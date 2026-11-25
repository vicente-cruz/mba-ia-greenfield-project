import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import videoConfig from '../../config/video.config';
import { VideoStatus } from '../../videos/entities/video.entity';
import { VideoJobDispatcherService } from '../../videos/jobs/video-job-dispatcher.service';
import {
  buildVideoJobId,
  parseVideoJobId,
  type ProcessVideoJobData,
} from '../../videos/jobs/video-job-id';
import {
  OperationTimeoutError,
  withTimeout,
} from '../../videos/jobs/with-timeout';
import {
  VIDEO_JOB_PUBLISH_TIMEOUT_MS,
  VIDEO_QUEUES,
} from '../../videos/videos.constants';
import { redactSignedUrls } from '../media/media-probe.rules';
import { MAINTENANCE_QUEUE_TIMEOUT_MS } from './maintenance.constants';
import type { MaintenanceJobData, MaintenanceTask } from './maintenance-task';
import {
  decideResumption,
  decideWithoutPendingAction,
  type JobObservation,
  MISSING_JOB,
  type ProcessingSnapshot,
} from './processing-reconciliation.decisions';
import {
  type CollectionFacts,
  ProcessingReconciliationRepository,
  type SnapshotCursor,
} from './processing-reconciliation.repository';

/** The finished sets of the queue that the collection walks. */
const FINISHED_STATES = ['completed', 'failed'] as const;
type FinishedState = (typeof FINISHED_STATES)[number];

/** Counts of one run of the reconciliation, kept by BullMQ as the result of the job. */
export interface ProcessingReconciliationResult {
  examined: number;
  /** R1 won: a new generation reserved, one recovery counted, then R2 and R3. */
  recovered: number;
  /** Closed in `error` with G_R (`PROCESSING_INCONSISTENT`, `_FAILED` or `_STALLED`). */
  closed: number;
  /** Pending actions taken over and resolved by the table of evidences. */
  resumed: number;
  /** A write affected zero rows: the retrato and its observation were discarded. */
  discarded: number;
  /** Job waiting, delayed, active, or a pending action still within its deadline. */
  untouched: number;
  /** Waiting jobs above `PROCESSING_STUCK_ALERT_MS`. */
  stuckAlerts: number;
  /** Finished jobs removed after the database confirmed them (collection of P5). */
  collected: number;
  /** Unexpected failures; the job fails after the batch, and the next run tries again. */
  failed: number;
}

/**
 * The reconciliation of the processing (`reconcile-processing`, SI-03.25; P5, TD-12, G-05). For
 * each video in `processing` past the grace, or with an expired pending action:
 * 1. reads the retrato `R` of the video;
 * 2. derives the job `video-{videoId}-{run}-{g}`, with `g` the reserved generation of a pending
 *    action, or `processing_dispatch`;
 * 3. asks the queue about that job;
 * 4. writes with the guard of the same `R`. Zero rows discards `R` and the observation together.
 * The publication and the confirmation of the actions (R2, R3) go through
 * `VideoJobDispatcherService`, always with the generation reserved by the action; there is no
 * `job.retry()`. Then the finished jobs are collected, only after the database confirms them.
 *
 * Each run is bounded by `batchSize`, and the batches move on between runs: the videos and the
 * finished jobs that must stay never hold the following ones out (positions kept in memory, per
 * process). Every wait on the queue is bounded too; when the queue does not answer, the run stops
 * and fails, and a pending action stays for the resumption of P5.
 */
@Injectable()
export class ProcessingReconcilerService implements MaintenanceTask {
  private readonly logger = new Logger(ProcessingReconcilerService.name);
  /** Where the next batch of videos starts; `null` starts again from the oldest. */
  private snapshotCursor: SnapshotCursor | null = null;
  /** Where the next batch of each finished set starts (oldest first). */
  private readonly collectOffsets: Record<FinishedState, number> = {
    completed: 0,
    failed: 0,
  };

  constructor(
    private readonly reconciliation: ProcessingReconciliationRepository,
    private readonly dispatcher: VideoJobDispatcherService,
    @InjectQueue(VIDEO_QUEUES.PROCESSING)
    private readonly queue: Queue<ProcessVideoJobData>,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async run(data: MaintenanceJobData): Promise<ProcessingReconciliationResult> {
    const { batchSize } = data;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error(`invalid batchSize for the reconciliation: ${batchSize}`);
    }
    const result: ProcessingReconciliationResult = {
      examined: 0,
      recovered: 0,
      closed: 0,
      resumed: 0,
      discarded: 0,
      untouched: 0,
      stuckAlerts: 0,
      collected: 0,
      failed: 0,
    };
    let queueUnavailable: OperationTimeoutError | null = null;
    for (const snapshot of await this.nextSnapshots(batchSize)) {
      result.examined += 1;
      try {
        await this.reconcile(snapshot, result);
      } catch (error) {
        result.failed += 1;
        this.logger.warn({
          event: 'video-maintenance.reconcile-video-failed',
          videoId: snapshot.videoId,
          reason: errorMessage(error),
        });
        if (error instanceof OperationTimeoutError) {
          // Every other call would wait as long: the rest of the batch waits for the next run.
          queueUnavailable = error;
          break;
        }
      }
    }
    if (!queueUnavailable) {
      try {
        await this.collect(batchSize, result);
      } catch (error) {
        result.failed += 1;
        this.logger.warn({
          event: 'video-maintenance.collect-failed',
          reason: errorMessage(error),
        });
        if (error instanceof OperationTimeoutError) {
          queueUnavailable = error;
        }
      }
    }
    if (result.examined > 0 || result.collected > 0) {
      this.logger.log({ event: 'video-maintenance.reconcile', ...result });
    }
    if (queueUnavailable) {
      throw new Error(
        `reconciliation of the processing: queue unavailable (${queueUnavailable.message})`,
      );
    }
    if (result.failed > 0) {
      throw new Error(
        `reconciliation of the processing: ${result.failed} failures in ${result.examined} videos and the collection`,
      );
    }
    return result;
  }

  /**
   * The next batch of videos after the position of the previous run. A short page ends the cycle,
   * and the next run starts again from the oldest; an empty page after a position starts again in
   * the same run.
   */
  private async nextSnapshots(
    batchSize: number,
  ): Promise<ProcessingSnapshot[]> {
    const graceMs = this.config.processingReconcileGraceMs;
    let page = await this.reconciliation.findSnapshots(
      batchSize,
      graceMs,
      this.snapshotCursor,
    );
    if (page.snapshots.length === 0 && this.snapshotCursor !== null) {
      page = await this.reconciliation.findSnapshots(batchSize, graceMs, null);
    }
    this.snapshotCursor = page.snapshots.length < batchSize ? null : page.last;
    return page.snapshots;
  }

  private async reconcile(
    snapshot: ProcessingSnapshot,
    result: ProcessingReconciliationResult,
  ): Promise<void> {
    if (snapshot.pendingAction !== null) {
      if (!snapshot.pendingExpired) {
        // The owner of the action is acting within its deadline.
        result.untouched += 1;
        return;
      }
      await this.resume(snapshot, result);
      return;
    }

    const jobId = buildVideoJobId({
      videoId: snapshot.videoId,
      run: snapshot.run,
      dispatch: snapshot.dispatch,
    });
    const job = await this.observe(jobId);
    const decision = decideWithoutPendingAction(snapshot, job, {
      maxRecoveries: this.config.processingMaxRecoveries,
      stuckAlertMs: this.config.processingStuckAlertMs,
      now: Date.now(),
    });
    switch (decision.kind) {
      case 'reserve-generation':
        await this.recover(snapshot, jobId, job, result);
        return;
      case 'close': {
        const closed = await this.reconciliation.closeInError(
          snapshot,
          decision.code,
          closingMessage(jobId, job, snapshot),
          decision.failedJob
            ? {
                dispatch: snapshot.dispatch,
                attemptsStarted: job.attemptsStarted,
              }
            : null,
        );
        if (!closed) {
          this.discard(snapshot, jobId, result);
          return;
        }
        result.closed += 1;
        this.logger.warn({
          event: 'video-maintenance.reconcile-closed',
          videoId: snapshot.videoId,
          jobId,
          errorCode: decision.code,
          jobState: job.state,
        });
        // The RETURNING of the closure confirms the terminal execution of this job.
        if (job.state !== 'missing') {
          result.collected += await this.queueCall(
            'remove of a closed job',
            this.queue.remove(jobId),
          );
        }
        return;
      }
      case 'wait':
        result.untouched += 1;
        if (decision.stuck) {
          result.stuckAlerts += 1;
          this.logger.warn({
            event: 'video-processing.stuck',
            videoId: snapshot.videoId,
            jobId,
            jobState: job.state,
            waitingMs:
              job.timestamp === null ? null : Date.now() - job.timestamp,
            reason: 'queue without consumer; waiting for a worker',
          });
        }
        return;
      case 'none':
        result.untouched += 1;
        return;
    }
  }

  /** R1 with G_R and the limit, then R2 and R3 with the generation of the reservation. */
  private async recover(
    snapshot: ProcessingSnapshot,
    jobId: string,
    job: JobObservation,
    result: ProcessingReconciliationResult,
  ): Promise<void> {
    const token = randomUUID();
    const generation = await this.reconciliation.reserveGeneration(
      snapshot,
      token,
      this.config.processingJobActionTtlSeconds,
      this.config.processingMaxRecoveries,
    );
    if (generation === null) {
      this.discard(snapshot, jobId, result);
      return;
    }
    result.recovered += 1;
    this.logger.warn({
      event: 'video-maintenance.reconcile-recovery',
      videoId: snapshot.videoId,
      jobId,
      jobState: job.state,
      generation,
      recoveries: snapshot.recoveries + 1,
    });
    await this.publishAndConfirm(snapshot, generation, token);
  }

  /**
   * Resumption of an expired pending action (table of evidences of P5): the queue is asked about
   * the reserved generation, the action is taken over with G_P, and the evidence decides. No new
   * generation and no recovery is counted.
   */
  private async resume(
    snapshot: ProcessingSnapshot,
    result: ProcessingReconciliationResult,
  ): Promise<void> {
    const generation = snapshot.pendingDispatch ?? 0;
    const jobId = buildVideoJobId({
      videoId: snapshot.videoId,
      run: snapshot.run,
      dispatch: generation,
    });
    const job = await this.observe(jobId);
    const token = randomUUID();
    const taken = await this.reconciliation.takeOverAction(
      snapshot,
      token,
      this.config.processingJobActionTtlSeconds,
    );
    if (!taken) {
      this.discard(snapshot, jobId, result);
      return;
    }
    result.resumed += 1;
    const decision = decideResumption(snapshot, job);
    this.logger.warn({
      event: 'video-maintenance.reconcile-resumption',
      videoId: snapshot.videoId,
      jobId,
      jobState: job.state,
      decision,
    });
    switch (decision) {
      case 'confirm':
        await this.confirm(snapshot, generation, token);
        return;
      case 'publish-and-confirm':
        await this.publishAndConfirm(snapshot, generation, token);
        return;
      case 'close-lost-job':
        // Repeating the add would recreate `g` with its counter below the fence.
        this.logger.error({
          event: 'video-maintenance.reconcile-lost-job',
          videoId: snapshot.videoId,
          jobId,
          fenceDispatch: snapshot.fenceDispatch,
          reason:
            'the job of the generation had an accepted delivery and is gone outside the protocol',
        });
        await this.confirm(snapshot, generation, token);
        return;
    }
  }

  /**
   * R2 with the generation of the action, then R3 by its token. The add has the limit of the
   * publication of SI-03.16: when it passes, the action stays pending for the resumption of P5,
   * and an add that completes later is harmless (the job of `g` exists, so the resumption only
   * confirms; a superseded `g` is inert by P3 and collected).
   */
  private async publishAndConfirm(
    snapshot: ProcessingSnapshot,
    generation: number,
    token: string,
  ): Promise<void> {
    try {
      await withTimeout(
        this.dispatcher.publish({
          videoId: snapshot.videoId,
          run: snapshot.run,
          dispatch: generation,
        }),
        VIDEO_JOB_PUBLISH_TIMEOUT_MS,
        'add of the reserved generation',
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        this.logger.warn({
          event: 'video-maintenance.reconcile-publication-timed-out',
          videoId: snapshot.videoId,
          generation,
          reason: 'the action stays pending for the resumption of P5',
        });
      }
      throw error;
    }
    await this.confirm(snapshot, generation, token);
  }

  private async confirm(
    snapshot: ProcessingSnapshot,
    generation: number,
    token: string,
  ): Promise<void> {
    const confirmed = await this.dispatcher.confirm({
      videoId: snapshot.videoId,
      dispatch: generation,
      token,
    });
    if (!confirmed) {
      this.logger.warn({
        event: 'video-maintenance.reconcile-confirmation-lost',
        videoId: snapshot.videoId,
        generation,
        reason: 'the action was taken over before its confirmation',
      });
    }
  }

  /**
   * Step 3 of P5. The state is read before the job: reading the job first could return its hash
   * from before a finishing script, with stale counters.
   */
  private async observe(jobId: string): Promise<JobObservation> {
    const state = await this.queueCall(
      'state of the job',
      this.queue.getJobState(jobId),
    );
    if (state === 'unknown') {
      return MISSING_JOB;
    }
    const job = await this.queueCall('job', this.queue.getJob(jobId));
    if (!job) {
      return MISSING_JOB;
    }
    return {
      state,
      attemptsStarted: job.attemptsStarted,
      failedReason: job.failedReason ?? null,
      timestamp: job.timestamp ?? null,
    };
  }

  private discard(
    snapshot: ProcessingSnapshot,
    jobId: string,
    result: ProcessingReconciliationResult,
  ): void {
    result.discarded += 1;
    this.logger.log({
      event: 'video-maintenance.reconcile-discarded',
      videoId: snapshot.videoId,
      jobId,
      reason: 'the retrato changed; the next cycle reads it again',
    });
  }

  /**
   * Collection of P5: removes a `completed` or `failed` job of `process-video` only after the
   * database confirms its terminal execution (`ready` or `error` in the same run) or its
   * superseded generation (older generation in the same run, or an older run). The job of the
   * current generation of a video in `processing` is never removed, nor waiting, delayed or
   * active jobs, which this pass does not even list.
   *
   * Each finished set is walked from the position of the previous run, oldest first, `batchSize`
   * jobs at a time; the jobs that stay move the position, and the end of the set starts again.
   */
  private async collect(
    batchSize: number,
    result: ProcessingReconciliationResult,
  ): Promise<void> {
    for (const state of FINISHED_STATES) {
      let offset = this.collectOffsets[state];
      let jobs = await this.finishedJobs(state, offset, batchSize);
      if (jobs.length === 0 && offset > 0) {
        offset = 0;
        jobs = await this.finishedJobs(state, offset, batchSize);
      }
      const identities = jobs
        .map((job) => (job.id ? parseVideoJobId(job.id) : null))
        .filter((identity) => identity !== null);
      const facts = await this.reconciliation.collectionFacts([
        ...new Set(identities.map((identity) => identity.videoId)),
      ]);
      let removed = 0;
      for (const identity of identities) {
        const video = facts.get(identity.videoId);
        if (video && isCollectable(identity, video)) {
          removed += await this.queueCall(
            'remove of a collected job',
            this.queue.remove(buildVideoJobId(identity)),
          );
        }
      }
      result.collected += removed;
      // The removed jobs left the set: the kept ones are where the next batch must start after.
      this.collectOffsets[state] =
        jobs.length < batchSize ? 0 : offset + jobs.length - removed;
    }
  }

  private finishedJobs(
    state: FinishedState,
    offset: number,
    batchSize: number,
  ) {
    return this.queueCall(
      `${state} jobs`,
      this.queue.getJobs([state], offset, offset + batchSize - 1, true),
    );
  }

  /** A call to the queue with the limit of the maintenance. */
  private queueCall<T>(operation: string, call: Promise<T>): Promise<T> {
    return withTimeout(call, MAINTENANCE_QUEUE_TIMEOUT_MS, operation);
  }
}

/** The confirmations of the collection of P5, read in the database. */
export function isCollectable(
  job: { run: number; dispatch: number },
  video: CollectionFacts,
): boolean {
  const terminal =
    (video.status === VideoStatus.READY ||
      video.status === VideoStatus.ERROR) &&
    video.run === job.run;
  const superseded =
    job.run < video.run ||
    (job.run === video.run && job.dispatch < video.dispatch);
  return terminal || superseded;
}

function closingMessage(
  jobId: string,
  job: JobObservation,
  snapshot: ProcessingSnapshot,
): string {
  switch (job.state) {
    case 'missing':
      return `job ${jobId} is missing and the execution reached ${snapshot.recoveries} recoveries`;
    case 'completed':
      return `job ${jobId} completed without a transition and the execution reached ${snapshot.recoveries} recoveries`;
    default:
      return redactSignedUrls(
        `job ${jobId} failed: ${job.failedReason ?? 'without a reason'}`,
      );
  }
}

function errorMessage(error: unknown): string {
  return redactSignedUrls(
    error instanceof Error ? error.message : String(error),
  );
}
