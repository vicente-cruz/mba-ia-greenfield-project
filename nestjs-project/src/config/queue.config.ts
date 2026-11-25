import { registerAs } from '@nestjs/config';
import { QUEUE_DEFAULTS } from './config.constants';
import { readIntEnv } from './env.utils';

export default registerAs('queue', () => ({
  redis: {
    host: process.env.REDIS_HOST || QUEUE_DEFAULTS.REDIS_HOST,
    port: readIntEnv('REDIS_PORT', QUEUE_DEFAULTS.REDIS_PORT),
  },
  videoProcessing: {
    attempts: readIntEnv(
      'VIDEO_PROCESSING_ATTEMPTS',
      QUEUE_DEFAULTS.VIDEO_PROCESSING_ATTEMPTS,
    ),
    backoffMs: readIntEnv(
      'VIDEO_PROCESSING_BACKOFF_MS',
      QUEUE_DEFAULTS.VIDEO_PROCESSING_BACKOFF_MS,
    ),
    concurrency: readIntEnv(
      'VIDEO_PROCESSING_CONCURRENCY',
      QUEUE_DEFAULTS.VIDEO_PROCESSING_CONCURRENCY,
    ),
    timeoutMs: readIntEnv(
      'VIDEO_PROCESSING_TIMEOUT_MS',
      QUEUE_DEFAULTS.VIDEO_PROCESSING_TIMEOUT_MS,
    ),
  },
  // Lock and stall settings of the BullMQ workers (TD-10; values confirmed by V-11).
  worker: {
    lockDurationMs: readIntEnv(
      'QUEUE_LOCK_DURATION_MS',
      QUEUE_DEFAULTS.QUEUE_LOCK_DURATION_MS,
    ),
    stalledIntervalMs: readIntEnv(
      'QUEUE_STALLED_INTERVAL_MS',
      QUEUE_DEFAULTS.QUEUE_STALLED_INTERVAL_MS,
    ),
    maxStalledCount: readIntEnv(
      'QUEUE_MAX_STALLED_COUNT',
      QUEUE_DEFAULTS.QUEUE_MAX_STALLED_COUNT,
    ),
  },
}));
