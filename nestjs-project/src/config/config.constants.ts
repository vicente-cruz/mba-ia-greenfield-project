// Defaults and fixed limits shared by envValidationSchema and the registerAs namespaces of
// phase 03 (storage, queue and video). Values confirmed by the feasibility proofs are marked
// with the proof; the others were chosen within the constraints of the phase plan (SI-03.8).

export const STORAGE_DEFAULTS = {
  S3_REGION: 'us-east-1',
  // The storage service (Silo) is addressed by path, not by virtual host (TD-07, V-03).
  S3_FORCE_PATH_STYLE: 'true',
} as const;

export const QUEUE_DEFAULTS = {
  // Docker Compose service name, never localhost.
  REDIS_HOST: 'redis',
  REDIS_PORT: 6379,
  VIDEO_PROCESSING_ATTEMPTS: 3,
  VIDEO_PROCESSING_BACKOFF_MS: 5_000,
  VIDEO_PROCESSING_CONCURRENCY: 1,
  // Per-call timeout that kills ffprobe/ffmpeg (V-04: 60 s; the network options make a stalled
  // read exit by itself in about 44 s).
  VIDEO_PROCESSING_TIMEOUT_MS: 60_000,
  // BullMQ 6.7.7 effective defaults confirmed by V-11; applied to the workers of both queues.
  QUEUE_LOCK_DURATION_MS: 30_000,
  QUEUE_STALLED_INTERVAL_MS: 30_000,
  QUEUE_MAX_STALLED_COUNT: 1,
} as const;

export const VIDEO_DEFAULTS = {
  // 10 GB decimal and 150 parts of 64 MiB (TD-03).
  VIDEO_MAX_SIZE_BYTES: 10_000_000_000,
  UPLOAD_PART_SIZE_BYTES: 67_108_864,
  // Absolute TTL counted from the session activation, never renewed by parts (V-01, Q-08).
  UPLOAD_SESSION_TTL: '24h',
  UPLOAD_SESSION_CLAIM_TTL_SECONDS: 300,
  UPLOAD_PART_URL_TTL_SECONDS: 900,
  PLAYBACK_URL_TTL_SECONDS: 3_600,
  DOWNLOAD_URL_TTL_SECONDS: 300,
  PROCESSING_JOB_ACTION_TTL_SECONDS: 120,
  PROCESSING_MAX_RECOVERIES: 2,
  PROCESSING_STUCK_ALERT_MS: 600_000,
  PROCESSING_RECONCILE_GRACE_MS: 300_000,
  STORAGE_CLEANUP_GRACE_MS: 3_600_000,
  MAINTENANCE_SWEEP_INTERVAL_MS: 60_000,
  MAINTENANCE_RECONCILE_INTERVAL_MS: 60_000,
  MAINTENANCE_CLEANUP_INTERVAL_MS: 3_600_000,
  MAINTENANCE_BATCH_SIZE: 100,
} as const;

/** S3 multipart and object limits (TD-03). */
export const S3_LIMITS = {
  MIN_PART_SIZE_BYTES: 5 * 1024 * 1024,
  MAX_PART_SIZE_BYTES: 5 * 1024 * 1024 * 1024,
  MAX_PARTS: 10_000,
  MAX_OBJECT_SIZE_BYTES: 5 * 1024 * 1024 * 1024 * 1024,
  /** Maximum lifetime of a SigV4 presigned URL. */
  MAX_PRESIGNED_URL_TTL_SECONDS: 604_800,
} as const;

/**
 * MINIO_API_STALE_UPLOADS_EXPIRY of the storage service (compose.yaml), counted from the creation
 * of the multipart upload (V-01). UPLOAD_SESSION_TTL plus the claim TTL must stay below it, so the
 * application sweep always aborts before the storage cleanup (TD-02, G-10).
 */
export const STORAGE_STALE_UPLOADS_EXPIRY_SECONDS = 48 * 60 * 60;
