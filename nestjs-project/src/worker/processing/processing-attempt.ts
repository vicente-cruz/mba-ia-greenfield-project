import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job } from 'bullmq';
import {
  parseVideoJobId,
  type ProcessVideoJobData,
} from '../../videos/jobs/video-job-id';

/**
 * One delivery of a `process-video` job, identified by the order token of P3: the generation
 * (`dispatch`), read from the jobId, and `seq = job.attemptsStarted`. `attemptId` names the
 * attempt in the database (`current_attempt_id`) and in the key of its thumbnail.
 */
export interface ProcessingAttempt {
  videoId: string;
  run: number;
  dispatch: number;
  seq: number;
  attemptId: string;
}

/** Frame of the thumbnail: 1 s into the video, or its middle when it is shorter (G-07). */
export const THUMBNAIL_FRAME_SECONDS = 1;

/**
 * The attempt of a delivery. The jobId must be `video-{videoId}-{run}-{dispatch}` and agree with
 * the payload `{ videoId, run }` ("Events/Messages → process-video"); otherwise the job cannot be
 * attributed to an execution, and retrying it gives the same result, so it fails without retries.
 */
export function processingAttemptOf(
  job: Pick<Job<ProcessVideoJobData>, 'id' | 'data' | 'attemptsStarted'>,
): ProcessingAttempt {
  const identity = job.id ? parseVideoJobId(job.id) : null;
  if (
    !identity ||
    identity.videoId !== job.data?.videoId ||
    identity.run !== job.data?.run
  ) {
    throw new UnrecoverableError(
      `job ${job.id ?? '(no id)'} does not match its payload ${JSON.stringify(job.data ?? null)}`,
    );
  }
  if (!Number.isSafeInteger(job.attemptsStarted) || job.attemptsStarted < 1) {
    throw new UnrecoverableError(
      `job ${job.id} has no started attempt (attemptsStarted ${job.attemptsStarted})`,
    );
  }
  return {
    videoId: identity.videoId,
    run: identity.run,
    dispatch: identity.dispatch,
    seq: job.attemptsStarted,
    attemptId: randomUUID(),
  };
}

/** The last attempt of the job: a failure now is final (`job.attemptsMade + 1 >= attempts`). */
export function isLastAttempt(
  job: Pick<Job, 'attemptsMade' | 'opts'>,
): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/** Deterministic position of the frame of the thumbnail, from the duration found by ffprobe. */
export function thumbnailFrameSeconds(durationSeconds: number | null): number {
  if (durationSeconds === null || durationSeconds <= 0) {
    return 0;
  }
  return Math.min(THUMBNAIL_FRAME_SECONDS, durationSeconds / 2);
}
