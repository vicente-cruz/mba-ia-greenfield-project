import { registerAs } from '@nestjs/config';
import { VIDEO_DEFAULTS } from './config.constants';
import { parseDurationSeconds, readIntEnv } from './env.utils';

export default registerAs('video', () => ({
  maxSizeBytes: readIntEnv(
    'VIDEO_MAX_SIZE_BYTES',
    VIDEO_DEFAULTS.VIDEO_MAX_SIZE_BYTES,
  ),
  uploadPartSizeBytes: readIntEnv(
    'UPLOAD_PART_SIZE_BYTES',
    VIDEO_DEFAULTS.UPLOAD_PART_SIZE_BYTES,
  ),
  uploadSessionTtlSeconds: parseDurationSeconds(
    process.env.UPLOAD_SESSION_TTL || VIDEO_DEFAULTS.UPLOAD_SESSION_TTL,
  ),
  uploadSessionClaimTtlSeconds: readIntEnv(
    'UPLOAD_SESSION_CLAIM_TTL_SECONDS',
    VIDEO_DEFAULTS.UPLOAD_SESSION_CLAIM_TTL_SECONDS,
  ),
  uploadPartUrlTtlSeconds: readIntEnv(
    'UPLOAD_PART_URL_TTL_SECONDS',
    VIDEO_DEFAULTS.UPLOAD_PART_URL_TTL_SECONDS,
  ),
  playbackUrlTtlSeconds: readIntEnv(
    'PLAYBACK_URL_TTL_SECONDS',
    VIDEO_DEFAULTS.PLAYBACK_URL_TTL_SECONDS,
  ),
  downloadUrlTtlSeconds: readIntEnv(
    'DOWNLOAD_URL_TTL_SECONDS',
    VIDEO_DEFAULTS.DOWNLOAD_URL_TTL_SECONDS,
  ),
  processingJobActionTtlSeconds: readIntEnv(
    'PROCESSING_JOB_ACTION_TTL_SECONDS',
    VIDEO_DEFAULTS.PROCESSING_JOB_ACTION_TTL_SECONDS,
  ),
  processingMaxRecoveries: readIntEnv(
    'PROCESSING_MAX_RECOVERIES',
    VIDEO_DEFAULTS.PROCESSING_MAX_RECOVERIES,
  ),
  processingStuckAlertMs: readIntEnv(
    'PROCESSING_STUCK_ALERT_MS',
    VIDEO_DEFAULTS.PROCESSING_STUCK_ALERT_MS,
  ),
  processingReconcileGraceMs: readIntEnv(
    'PROCESSING_RECONCILE_GRACE_MS',
    VIDEO_DEFAULTS.PROCESSING_RECONCILE_GRACE_MS,
  ),
  storageCleanupGraceMs: readIntEnv(
    'STORAGE_CLEANUP_GRACE_MS',
    VIDEO_DEFAULTS.STORAGE_CLEANUP_GRACE_MS,
  ),
  maintenance: {
    sweepIntervalMs: readIntEnv(
      'MAINTENANCE_SWEEP_INTERVAL_MS',
      VIDEO_DEFAULTS.MAINTENANCE_SWEEP_INTERVAL_MS,
    ),
    reconcileIntervalMs: readIntEnv(
      'MAINTENANCE_RECONCILE_INTERVAL_MS',
      VIDEO_DEFAULTS.MAINTENANCE_RECONCILE_INTERVAL_MS,
    ),
    cleanupIntervalMs: readIntEnv(
      'MAINTENANCE_CLEANUP_INTERVAL_MS',
      VIDEO_DEFAULTS.MAINTENANCE_CLEANUP_INTERVAL_MS,
    ),
    batchSize: readIntEnv(
      'MAINTENANCE_BATCH_SIZE',
      VIDEO_DEFAULTS.MAINTENANCE_BATCH_SIZE,
    ),
  },
}));
