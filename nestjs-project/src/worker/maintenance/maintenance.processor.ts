import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import queueConfig from '../../config/queue.config';
import { VIDEO_QUEUES } from '../../videos/videos.constants';
import {
  MAINTENANCE_JOBS,
  type MaintenanceJobName,
} from './maintenance.constants';
import {
  MAINTENANCE_TASKS,
  type MaintenanceJobData,
  type MaintenanceTasks,
} from './maintenance-task';
import { maintenanceWorkerOptions } from './maintenance.worker-options';

const MAINTENANCE_JOB_NAMES: readonly string[] =
  Object.values(MAINTENANCE_JOBS);

function isMaintenanceJobName(name: string): name is MaintenanceJobName {
  return MAINTENANCE_JOB_NAMES.includes(name);
}

/**
 * Consumer of `video-maintenance` in the `video-worker` service (TD-10, TD-12): one job at a time,
 * dispatched by its name to the task of `MAINTENANCE_TASKS` (sweep, reconciliation and cleanup,
 * from SI-03.24 to SI-03.26). An unknown name is logged as an error and fails without retries and
 * without touching anything.
 *
 * On shutdown, the worker is drained in `onModuleDestroy`, like the processing one (SI-03.22).
 */
@Processor(VIDEO_QUEUES.MAINTENANCE, maintenanceWorkerOptions(queueConfig()))
export class MaintenanceProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MaintenanceProcessor.name);
  /** The worker exists only after `@nestjs/bullmq` registered it (`init`, not `compile`). */
  private workerStarted = false;

  constructor(
    @Inject(MAINTENANCE_TASKS) private readonly tasks: MaintenanceTasks,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.workerStarted = true;
    const { concurrency, lockDuration, stalledInterval, maxStalledCount } =
      this.worker.opts;
    this.logger.log({
      event: 'video-maintenance.worker-started',
      queue: VIDEO_QUEUES.MAINTENANCE,
      concurrency,
      lockDuration,
      stalledInterval,
      maxStalledCount,
    });
  }

  /** Waits for the active maintenance job before the other modules release their resources. */
  async onModuleDestroy(): Promise<void> {
    if (!this.workerStarted) {
      return;
    }
    this.logger.log({ event: 'video-maintenance.worker-closing' });
    await this.worker.close();
    this.logger.log({ event: 'video-maintenance.worker-closed' });
  }

  async process(job: Job<MaintenanceJobData>): Promise<unknown> {
    if (!isMaintenanceJobName(job.name)) {
      this.logger.error({
        event: 'video-maintenance.unknown-job',
        jobId: job.id,
        name: job.name,
      });
      throw new UnrecoverableError(`unknown maintenance job "${job.name}"`);
    }
    return this.tasks[job.name].run(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<MaintenanceJobData> | undefined, error: Error): void {
    this.logger.warn({
      event: 'video-maintenance.failed',
      queue: VIDEO_QUEUES.MAINTENANCE,
      jobId: job?.id,
      name: job?.name,
      reason: error.message,
    });
  }
}
