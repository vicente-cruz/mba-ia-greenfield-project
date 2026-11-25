import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import queueConfig from '../../config/queue.config';
import { StorageService } from '../../storage/storage.service';
import { VIDEO_ERROR_CODES } from '../../videos/exceptions/video.exceptions';
import type { ProcessVideoJobData } from '../../videos/jobs/video-job-id';
import { thumbnailObjectKey } from '../../videos/storage-keys';
import { VIDEO_QUEUES } from '../../videos/videos.constants';
import { MediaRejectedError } from '../media/media.errors';
import { MediaProbeService } from '../media/media-probe.service';
import { redactSignedUrls } from '../media/media-probe.rules';
import {
  isLastAttempt,
  type ProcessingAttempt,
  processingAttemptOf,
  thumbnailFrameSeconds,
} from './processing-attempt';
import { ProcessingStateService } from './processing-state.service';
import { videoProcessingWorkerOptions } from './video-processing.worker-options';

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/** Result of a delivery, kept by BullMQ as the return value of the job. */
export interface ProcessVideoResult {
  /**
   * - `ready`: this attempt published the video;
   * - `superseded`: it assumed, but lost the attempt before publishing;
   * - `skipped`: it did not assume (obsolete delivery, terminal video or another execution).
   */
  outcome: 'ready' | 'superseded' | 'skipped';
  attemptId: string;
}

/**
 * Consumer of `process-video` in the `video-worker` service (TD-10, TD-11, TD-12; P3):
 * 1. assumes the current attempt with the token (`dispatch` of the jobId, `job.attemptsStarted`),
 *    or ends without FFmpeg and without writing to the storage (G-08);
 * 2. probes the original and extracts a frame over the internal presigned URL (SI-03.21);
 * 3. writes `thumbnails/{videoId}/{attemptId}.jpg` and publishes `ready`, only while current.
 *
 * Permanent media errors record `error` and fail the job with `UnrecoverableError`. Transient
 * errors are thrown again for the retry of BullMQ; the last attempt records `PROCESSING_FAILED`
 * first. Every write to `videos` has the publication guard of P3.
 *
 * On shutdown, the worker is drained in `onModuleDestroy`, before the other modules release the
 * resources the active job still uses (TD-10).
 */
@Processor(VIDEO_QUEUES.PROCESSING, videoProcessingWorkerOptions(queueConfig()))
export class VideoProcessingProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(VideoProcessingProcessor.name);
  /** The worker exists only after `@nestjs/bullmq` registered it (`init`, not `compile`). */
  private workerStarted = false;

  constructor(
    private readonly state: ProcessingStateService,
    private readonly media: MediaProbeService,
    private readonly storage: StorageService,
  ) {
    super();
  }

  /** The effective options of the worker, after `@nestjs/bullmq` created it. */
  onApplicationBootstrap(): void {
    this.workerStarted = true;
    const { concurrency, lockDuration, stalledInterval, maxStalledCount } =
      this.worker.opts;
    this.logger.log({
      event: 'video-processing.worker-started',
      queue: VIDEO_QUEUES.PROCESSING,
      concurrency,
      lockDuration,
      stalledInterval,
      maxStalledCount,
    });
  }

  /**
   * Stops taking jobs and waits for the active ones (`worker.close()`), first in the shutdown.
   * Nest runs `onModuleDestroy` from the root module down, before `beforeApplicationShutdown` and
   * `onApplicationShutdown`: the storage clients (`StorageModule.onModuleDestroy`) and the
   * database (`TypeOrmCoreModule.onApplicationShutdown`) are released only after the active job
   * finished. `@nestjs/bullmq` closes the worker again in `onApplicationShutdown`; a second
   * `close()` returns the same promise.
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.workerStarted) {
      return;
    }
    this.logger.log({ event: 'video-processing.worker-closing' });
    await this.worker.close();
    this.logger.log({ event: 'video-processing.worker-closed' });
  }

  async process(job: Job<ProcessVideoJobData>): Promise<ProcessVideoResult> {
    const attempt = processingAttemptOf(job);
    const video = await this.state.assume(attempt);
    if (!video) {
      this.logger.log({
        event: 'video-processing.skipped',
        jobId: job.id,
        seq: attempt.seq,
        reason: 'obsolete delivery, terminal video or another execution',
      });
      return { outcome: 'skipped', attemptId: attempt.attemptId };
    }

    try {
      const metadata = await this.media.probe(
        video.originalKey,
        video.contentType,
      );
      const frame = await this.media.extractFrame(
        video.originalKey,
        thumbnailFrameSeconds(metadata.durationSeconds),
      );
      const thumbnailKey = thumbnailObjectKey(
        attempt.videoId,
        attempt.attemptId,
      );
      await this.storage.putObject(thumbnailKey, frame, THUMBNAIL_CONTENT_TYPE);
      const published = await this.state.publishReady(
        attempt,
        metadata,
        thumbnailKey,
      );
      if (!published) {
        this.logLostAttempt(job, attempt, 'ready');
      }
      return {
        outcome: published ? 'ready' : 'superseded',
        attemptId: attempt.attemptId,
      };
    } catch (error) {
      return this.fail(job, attempt, error);
    }
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn({
      event: 'video-processing.stalled',
      queue: VIDEO_QUEUES.PROCESSING,
      jobId,
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessVideoJobData> | undefined, error: Error): void {
    this.logger.warn({
      event: 'video-processing.failed',
      queue: VIDEO_QUEUES.PROCESSING,
      jobId: job?.id,
      attemptsStarted: job?.attemptsStarted,
      attemptsMade: job?.attemptsMade,
      reason: redactSignedUrls(error.message),
    });
  }

  /** Records the outcome allowed by the error, under the guard of P3, and fails the delivery. */
  private async fail(
    job: Job<ProcessVideoJobData>,
    attempt: ProcessingAttempt,
    error: unknown,
  ): Promise<never> {
    if (error instanceof MediaRejectedError) {
      const recorded = await this.state.recordError(
        attempt,
        error.code,
        error.reason,
      );
      if (!recorded) {
        this.logLostAttempt(job, attempt, error.code);
      }
      throw new UnrecoverableError(error.message);
    }

    if (isLastAttempt(job)) {
      const reason = redactSignedUrls(
        error instanceof Error ? error.message : String(error),
      );
      try {
        const recorded = await this.state.recordError(
          attempt,
          VIDEO_ERROR_CODES.PROCESSING_FAILED,
          reason,
        );
        if (!recorded) {
          this.logLostAttempt(
            job,
            attempt,
            VIDEO_ERROR_CODES.PROCESSING_FAILED,
          );
        }
      } catch (writeError) {
        // The job still fails with the original cause; the reconciliation (P5) closes the video.
        this.logger.error({
          event: 'video-processing.error-not-recorded',
          jobId: job.id,
          seq: attempt.seq,
          reason: redactSignedUrls(
            writeError instanceof Error
              ? writeError.message
              : String(writeError),
          ),
        });
      }
    }
    throw error;
  }

  private logLostAttempt(
    job: Job<ProcessVideoJobData>,
    attempt: ProcessingAttempt,
    outcome: string,
  ): void {
    this.logger.warn({
      event: 'video-processing.attempt-lost',
      jobId: job.id,
      seq: attempt.seq,
      attemptId: attempt.attemptId,
      outcome,
    });
  }
}
