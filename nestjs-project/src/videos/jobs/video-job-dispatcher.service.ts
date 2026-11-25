import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { JobsOptions, JobState, Queue } from 'bullmq';
import { Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { Video } from '../entities/video.entity';
import { PROCESS_VIDEO_JOB_NAME, VIDEO_QUEUES } from '../videos.constants';
import {
  buildVideoJobId,
  type ProcessVideoJobData,
  type VideoJobIdentity,
} from './video-job-id';

/** Queue action recorded in the video row: the generation it reserved and its owner token (P5). */
export interface PendingJobActionClaim {
  videoId: string;
  /** `pending_job_dispatch`: the generation reserved by the action, never a re-read `processing_dispatch`. */
  dispatch: number;
  /** `pending_job_token`. */
  token: string;
}

/** The job as stored in the queue, read back after the `add`. */
export interface StoredVideoJob {
  data: ProcessVideoJobData;
  state: JobState | 'unknown';
  attemptsStarted: number;
  opts: Pick<
    JobsOptions,
    'attempts' | 'backoff' | 'removeOnComplete' | 'removeOnFail'
  >;
}

export interface PublishedVideoJob {
  jobId: string;
  /** `null` when the job no longer exists when it is read back, which is a fact for P5, not an error. */
  stored: StoredVideoJob | null;
}

/**
 * Executes and confirms the queue actions of P5 for the generation reserved by the action
 * (revision of recoveries by generation of TD-12). Used by the completion (P2) and by the
 * reconciliation (SI-03.25).
 */
@Injectable()
export class VideoJobDispatcherService {
  constructor(
    @InjectQueue(VIDEO_QUEUES.PROCESSING)
    private readonly queue: Queue<ProcessVideoJobData>,
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * R2: one `add` of the generation, with the jobs kept until the P5 collection removes them. An
   * `add` with the jobId of an existing job is ignored by BullMQ, but the Job it returns carries
   * the data and options of this call, not the stored ones (V-11, item 2.4). So the job is read
   * back from the queue, and only the stored version is returned.
   */
  async publish(identity: VideoJobIdentity): Promise<PublishedVideoJob> {
    const jobId = buildVideoJobId(identity);
    const { attempts, backoffMs } = this.config.videoProcessing;
    await this.queue.add(
      PROCESS_VIDEO_JOB_NAME,
      { videoId: identity.videoId, run: identity.run },
      {
        jobId,
        attempts,
        backoff: { type: 'exponential', delay: backoffMs },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    const job = await this.queue.getJob(jobId);
    if (!job) {
      return { jobId, stored: null };
    }
    return {
      jobId,
      stored: {
        data: job.data,
        state: await job.getState(),
        attemptsStarted: job.attemptsStarted,
        opts: {
          attempts: job.opts.attempts,
          backoff: job.opts.backoff,
          removeOnComplete: job.opts.removeOnComplete,
          removeOnFail: job.opts.removeOnFail,
        },
      },
    };
  }

  /**
   * R3: clears the pending action only while it still belongs to this token and generation.
   * `false` means another process took over the action or already confirmed it; it is an
   * expected outcome of the protocol, not an internal error.
   */
  async confirm(claim: PendingJobActionClaim): Promise<boolean> {
    const result = await this.videoRepository.update(
      {
        id: claim.videoId,
        pending_job_token: claim.token,
        pending_job_dispatch: claim.dispatch,
      },
      {
        pending_job_action: null,
        pending_job_dispatch: null,
        pending_job_token: null,
        pending_job_expires_at: null,
      },
    );
    return result.affected === 1;
  }
}
