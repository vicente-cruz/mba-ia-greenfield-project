import type { ConfigType } from '@nestjs/config';
import type { WorkerOptions } from 'bullmq';
import type queueConfig from '../../config/queue.config';
import { MAINTENANCE_CONCURRENCY } from './maintenance.constants';

export type MaintenanceWorkerOptions = Required<
  Pick<
    WorkerOptions,
    'concurrency' | 'lockDuration' | 'stalledInterval' | 'maxStalledCount'
  >
>;

/**
 * Options of the BullMQ worker of `video-maintenance`: concurrency 1, apart from the processing of
 * videos (TD-10), and the lock and stall settings of the `queue` configuration (V-11).
 */
export function maintenanceWorkerOptions(
  config: ConfigType<typeof queueConfig>,
): MaintenanceWorkerOptions {
  return {
    concurrency: MAINTENANCE_CONCURRENCY,
    lockDuration: config.worker.lockDurationMs,
    stalledInterval: config.worker.stalledIntervalMs,
    maxStalledCount: config.worker.maxStalledCount,
  };
}
