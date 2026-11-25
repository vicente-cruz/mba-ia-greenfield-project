/** Names of the jobs of `video-maintenance` ("Events/Messages"). */
export const MAINTENANCE_JOBS = {
  SWEEP_UPLOAD_SESSIONS: 'sweep-upload-sessions',
  RECONCILE_PROCESSING: 'reconcile-processing',
  CLEANUP_STORAGE: 'cleanup-storage',
} as const;

export type MaintenanceJobName =
  (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS];

/**
 * Stable ids of the Job Schedulers (TD-12): every instance of the worker upserts the same ids, so
 * the queue keeps one scheduler per id.
 */
export const MAINTENANCE_SCHEDULERS = {
  UPLOAD_SESSION_SWEEP: 'upload-session-sweep',
  PROCESSING_RECONCILIATION: 'processing-reconciliation',
  STORAGE_CLEANUP: 'storage-cleanup',
} as const;

/** One maintenance job at a time, in a queue of its own, apart from the videos (TD-10). */
export const MAINTENANCE_CONCURRENCY = 1;

/**
 * Options of every job produced by the schedulers. A maintenance job is not retried: the next run
 * of its scheduler repeats the batch, and each step is idempotent (G-01). Only the last jobs are
 * kept, so the periodic runs do not grow the queue without bound.
 */
export const MAINTENANCE_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 100 },
} as const;

/**
 * Limit of each wait on the queue in the maintenance (SI-03.25), the same bound as the publication
 * of SI-03.16 (`VIDEO_JOB_PUBLISH_TIMEOUT_MS`): with Redis unreachable, BullMQ waits for the
 * connection instead of failing, and the maintenance job would never end.
 */
export const MAINTENANCE_QUEUE_TIMEOUT_MS = 5_000;
