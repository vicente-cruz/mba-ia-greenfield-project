import type { JobState } from 'bullmq';
import type { VideoPendingJobAction } from '../../videos/entities/video.entity';
import { VIDEO_ERROR_CODES } from '../../videos/exceptions/video.exceptions';

/**
 * `failedReason` of BullMQ 6.7.7 for a job that stalled more than `maxStalledCount` (V-11). Only
 * this reason closes the execution as `PROCESSING_STALLED`; any other failure is
 * `PROCESSING_FAILED`.
 */
export const STALL_FAILED_REASON = 'job stalled more than allowable limit';

/**
 * The retrato `R` of P5: the fields of the video read in one statement, with the expiry of the
 * pending action evaluated by the clock of the database. Every write of the reconciliation is
 * guarded by this same retrato (G_R without a pending action, G_P with one).
 */
export interface ProcessingSnapshot {
  videoId: string;
  run: number;
  dispatch: number;
  recoveries: number;
  attemptId: string | null;
  fenceDispatch: number | null;
  fenceSeq: number | null;
  pendingAction: VideoPendingJobAction | null;
  pendingDispatch: number | null;
  pendingToken: string | null;
  /** `pending_job_expires_at < now()` in the database. */
  pendingExpired: boolean;
}

/** What the queue says about the job derived from the retrato (step 3 of P5). */
export interface JobObservation {
  state: JobState | 'missing';
  attemptsStarted: number;
  failedReason: string | null;
  /** When the job was added (ms), for the alert of a queue without consumer. */
  timestamp: number | null;
}

export const MISSING_JOB: JobObservation = {
  state: 'missing',
  attemptsStarted: 0,
  failedReason: null,
  timestamp: null,
};

export type ClosingCode =
  | typeof VIDEO_ERROR_CODES.PROCESSING_INCONSISTENT
  | typeof VIDEO_ERROR_CODES.PROCESSING_FAILED
  | typeof VIDEO_ERROR_CODES.PROCESSING_STALLED;

/** The conduct of P5 for a retrato without a pending action (G-05). */
export type ReconcileDecision =
  /** R1: new generation and one more recovery, then R2 and R3. */
  | { kind: 'reserve-generation' }
  /** `error` with G_R; for a `failed` job, also with the guard of the fence. */
  | { kind: 'close'; code: ClosingCode; failedJob: boolean }
  /** `waiting`, `delayed` or `prioritized`: nothing in the database; `stuck` logs an alert. */
  | { kind: 'wait'; stuck: boolean }
  /** `active` (the stall checker of BullMQ handles a lost lock), or a state of no conduct. */
  | { kind: 'none' };

export interface ReconcilePolicy {
  maxRecoveries: number;
  stuckAlertMs: number;
  now: number;
}

/**
 * The table of `reconcile-processing` for the job of generation `processing_dispatch`:
 * - missing, or `completed` without a transition in the database → R1 while
 *   `processing_recoveries < PROCESSING_MAX_RECOVERIES`; at the limit, `PROCESSING_INCONSISTENT`;
 * - `failed` → `PROCESSING_STALLED` for a stall above `maxStalledCount`, else
 *   `PROCESSING_FAILED`, never an automatic recovery;
 * - `waiting`, `delayed` or `prioritized` → wait, with an alert above `PROCESSING_STUCK_ALERT_MS`;
 * - `active` → nothing.
 */
export function decideWithoutPendingAction(
  snapshot: ProcessingSnapshot,
  job: JobObservation,
  policy: ReconcilePolicy,
): ReconcileDecision {
  switch (job.state) {
    case 'missing':
    case 'completed':
      return snapshot.recoveries < policy.maxRecoveries
        ? { kind: 'reserve-generation' }
        : {
            kind: 'close',
            code: VIDEO_ERROR_CODES.PROCESSING_INCONSISTENT,
            failedJob: false,
          };
    case 'failed':
      return {
        kind: 'close',
        code:
          job.failedReason === STALL_FAILED_REASON
            ? VIDEO_ERROR_CODES.PROCESSING_STALLED
            : VIDEO_ERROR_CODES.PROCESSING_FAILED,
        failedJob: true,
      };
    case 'waiting':
    case 'delayed':
    case 'prioritized':
      return {
        kind: 'wait',
        stuck:
          job.timestamp !== null &&
          policy.now - job.timestamp > policy.stuckAlertMs,
      };
    case 'active':
    case 'waiting-children':
      return { kind: 'none' };
  }
}

/** The conduct of the resumption of an expired pending action (table of evidences of P5). */
export type ResumptionDecision =
  /** The job `g` exists in some state: the `add` happened, only R3. */
  | 'confirm'
  /** The job `g` is missing and the fence has no token of `g`: R2 with the same `g`, then R3. */
  | 'publish-and-confirm'
  /** The job `g` is missing after an accepted delivery: no `add`, R3 closes the action. */
  | 'close-lost-job';

export function decideResumption(
  snapshot: ProcessingSnapshot,
  job: JobObservation,
): ResumptionDecision {
  if (job.state !== 'missing') {
    return 'confirm';
  }
  const generation = snapshot.pendingDispatch ?? 0;
  return snapshot.fenceDispatch === null || snapshot.fenceDispatch < generation
    ? 'publish-and-confirm'
    : 'close-lost-job';
}
