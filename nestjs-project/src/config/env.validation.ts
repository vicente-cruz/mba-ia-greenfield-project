import * as Joi from 'joi';
import {
  QUEUE_DEFAULTS,
  S3_LIMITS,
  STORAGE_DEFAULTS,
  STORAGE_STALE_UPLOADS_EXPIRY_SECONDS,
  VIDEO_DEFAULTS,
} from './config.constants';
import { DURATION_PATTERN, parseDurationSeconds } from './env.utils';

const positiveInteger = () => Joi.number().integer().min(1);
const nonNegativeInteger = () => Joi.number().integer().min(0);
const httpUri = () => Joi.string().uri({ scheme: ['http', 'https'] });
const presignedUrlTtl = () =>
  positiveInteger().max(S3_LIMITS.MAX_PRESIGNED_URL_TTL_SECONDS);

interface UploadLimits {
  VIDEO_MAX_SIZE_BYTES?: unknown;
  UPLOAD_PART_SIZE_BYTES?: unknown;
  UPLOAD_SESSION_TTL?: unknown;
  UPLOAD_SESSION_CLAIM_TTL_SECONDS?: unknown;
}

// Rules that relate two keys. Each one only runs when the keys it reads are individually valid,
// so a malformed key reports its own error instead of a derived one.
const validateUploadLimits: Joi.CustomValidator<UploadLimits> = (
  value,
  helpers,
) => {
  const maxSize = value.VIDEO_MAX_SIZE_BYTES;
  const partSize = value.UPLOAD_PART_SIZE_BYTES;
  if (
    typeof maxSize === 'number' &&
    typeof partSize === 'number' &&
    Math.ceil(maxSize / partSize) > S3_LIMITS.MAX_PARTS
  ) {
    return helpers.message({
      custom: `"VIDEO_MAX_SIZE_BYTES" divided by "UPLOAD_PART_SIZE_BYTES" must not exceed ${S3_LIMITS.MAX_PARTS} parts`,
    });
  }
  const ttl = value.UPLOAD_SESSION_TTL;
  const claimTtl = value.UPLOAD_SESSION_CLAIM_TTL_SECONDS;
  if (
    typeof ttl === 'string' &&
    DURATION_PATTERN.test(ttl) &&
    typeof claimTtl === 'number' &&
    parseDurationSeconds(ttl) + claimTtl >= STORAGE_STALE_UPLOADS_EXPIRY_SECONDS
  ) {
    return helpers.message({
      custom: `"UPLOAD_SESSION_TTL" plus "UPLOAD_SESSION_CLAIM_TTL_SECONDS" must be less than the storage stale uploads expiry (${STORAGE_STALE_UPLOADS_EXPIRY_SECONDS} s)`,
    });
  }
  return value;
};

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // Storage (phase-03-videos/TD-07)
  S3_ENDPOINT: httpUri().required(),
  S3_PUBLIC_ENDPOINT: httpUri().required(),
  S3_REGION: Joi.string().default(STORAGE_DEFAULTS.S3_REGION),
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_BUCKET: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.string()
    .valid('true', 'false')
    .default(STORAGE_DEFAULTS.S3_FORCE_PATH_STYLE),

  // Queue and worker (phase-03-videos/TD-09, TD-10)
  REDIS_HOST: Joi.string().default(QUEUE_DEFAULTS.REDIS_HOST),
  REDIS_PORT: Joi.number().port().default(QUEUE_DEFAULTS.REDIS_PORT),
  VIDEO_PROCESSING_ATTEMPTS: positiveInteger().default(
    QUEUE_DEFAULTS.VIDEO_PROCESSING_ATTEMPTS,
  ),
  VIDEO_PROCESSING_BACKOFF_MS: positiveInteger().default(
    QUEUE_DEFAULTS.VIDEO_PROCESSING_BACKOFF_MS,
  ),
  VIDEO_PROCESSING_CONCURRENCY: positiveInteger().default(
    QUEUE_DEFAULTS.VIDEO_PROCESSING_CONCURRENCY,
  ),
  VIDEO_PROCESSING_TIMEOUT_MS: positiveInteger().default(
    QUEUE_DEFAULTS.VIDEO_PROCESSING_TIMEOUT_MS,
  ),
  QUEUE_LOCK_DURATION_MS: positiveInteger().default(
    QUEUE_DEFAULTS.QUEUE_LOCK_DURATION_MS,
  ),
  QUEUE_STALLED_INTERVAL_MS: positiveInteger().default(
    QUEUE_DEFAULTS.QUEUE_STALLED_INTERVAL_MS,
  ),
  QUEUE_MAX_STALLED_COUNT: nonNegativeInteger().default(
    QUEUE_DEFAULTS.QUEUE_MAX_STALLED_COUNT,
  ),

  // Upload, delivery, processing and maintenance (phase-03-videos/TD-02, TD-03, TD-12, TD-14)
  VIDEO_MAX_SIZE_BYTES: positiveInteger()
    .max(S3_LIMITS.MAX_OBJECT_SIZE_BYTES)
    .default(VIDEO_DEFAULTS.VIDEO_MAX_SIZE_BYTES),
  UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(S3_LIMITS.MIN_PART_SIZE_BYTES)
    .max(S3_LIMITS.MAX_PART_SIZE_BYTES)
    .default(VIDEO_DEFAULTS.UPLOAD_PART_SIZE_BYTES),
  UPLOAD_SESSION_TTL: Joi.string()
    .pattern(DURATION_PATTERN, 'duration such as 24h, 90m or 3600s')
    .default(VIDEO_DEFAULTS.UPLOAD_SESSION_TTL),
  UPLOAD_SESSION_CLAIM_TTL_SECONDS: positiveInteger().default(
    VIDEO_DEFAULTS.UPLOAD_SESSION_CLAIM_TTL_SECONDS,
  ),
  UPLOAD_PART_URL_TTL_SECONDS: presignedUrlTtl().default(
    VIDEO_DEFAULTS.UPLOAD_PART_URL_TTL_SECONDS,
  ),
  PLAYBACK_URL_TTL_SECONDS: presignedUrlTtl().default(
    VIDEO_DEFAULTS.PLAYBACK_URL_TTL_SECONDS,
  ),
  DOWNLOAD_URL_TTL_SECONDS: presignedUrlTtl().default(
    VIDEO_DEFAULTS.DOWNLOAD_URL_TTL_SECONDS,
  ),
  PROCESSING_JOB_ACTION_TTL_SECONDS: positiveInteger().default(
    VIDEO_DEFAULTS.PROCESSING_JOB_ACTION_TTL_SECONDS,
  ),
  PROCESSING_MAX_RECOVERIES: nonNegativeInteger().default(
    VIDEO_DEFAULTS.PROCESSING_MAX_RECOVERIES,
  ),
  PROCESSING_STUCK_ALERT_MS: positiveInteger().default(
    VIDEO_DEFAULTS.PROCESSING_STUCK_ALERT_MS,
  ),
  // Graces are an additional margin only (P4, P5), so zero is allowed, for instance in tests.
  PROCESSING_RECONCILE_GRACE_MS: nonNegativeInteger().default(
    VIDEO_DEFAULTS.PROCESSING_RECONCILE_GRACE_MS,
  ),
  STORAGE_CLEANUP_GRACE_MS: nonNegativeInteger().default(
    VIDEO_DEFAULTS.STORAGE_CLEANUP_GRACE_MS,
  ),
  MAINTENANCE_SWEEP_INTERVAL_MS: positiveInteger().default(
    VIDEO_DEFAULTS.MAINTENANCE_SWEEP_INTERVAL_MS,
  ),
  MAINTENANCE_RECONCILE_INTERVAL_MS: positiveInteger().default(
    VIDEO_DEFAULTS.MAINTENANCE_RECONCILE_INTERVAL_MS,
  ),
  MAINTENANCE_CLEANUP_INTERVAL_MS: positiveInteger().default(
    VIDEO_DEFAULTS.MAINTENANCE_CLEANUP_INTERVAL_MS,
  ),
  MAINTENANCE_BATCH_SIZE: positiveInteger().default(
    VIDEO_DEFAULTS.MAINTENANCE_BATCH_SIZE,
  ),
}).custom(validateUploadLimits, 'upload limits');
