import type { ConfigType } from '@nestjs/config';
import type { WorkerOptions } from 'bullmq';
import type queueConfig from '../../config/queue.config';

export type VideoProcessingWorkerOptions = Required<
  Pick<
    WorkerOptions,
    'concurrency' | 'lockDuration' | 'stalledInterval' | 'maxStalledCount'
  >
>;

/**
 * Options of the BullMQ worker of `video-processing` (TD-10; values confirmed by V-11): the
 * concurrency of the processing and the lock and stall settings, from the `queue` configuration.
 */
export function videoProcessingWorkerOptions(
  config: ConfigType<typeof queueConfig>,
): VideoProcessingWorkerOptions {
  return {
    concurrency: config.videoProcessing.concurrency,
    lockDuration: config.worker.lockDurationMs,
    stalledInterval: config.worker.stalledIntervalMs,
    maxStalledCount: config.worker.maxStalledCount,
  };
}
