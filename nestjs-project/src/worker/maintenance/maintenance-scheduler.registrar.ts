import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import videoConfig from '../../config/video.config';
import { VIDEO_QUEUES } from '../../videos/videos.constants';
import {
  MAINTENANCE_JOB_OPTIONS,
  MAINTENANCE_JOBS,
  MAINTENANCE_SCHEDULERS,
  type MaintenanceJobName,
} from './maintenance.constants';
import type { MaintenanceJobData } from './maintenance-task';

export interface MaintenanceSchedule {
  schedulerId: string;
  jobName: MaintenanceJobName;
  every: number;
  batchSize: number;
}

/** The three schedules of the phase, with intervals and batch from the configuration. */
export function maintenanceSchedules(
  config: ConfigType<typeof videoConfig>,
): MaintenanceSchedule[] {
  const { sweepIntervalMs, reconcileIntervalMs, cleanupIntervalMs, batchSize } =
    config.maintenance;
  return [
    {
      schedulerId: MAINTENANCE_SCHEDULERS.UPLOAD_SESSION_SWEEP,
      jobName: MAINTENANCE_JOBS.SWEEP_UPLOAD_SESSIONS,
      every: sweepIntervalMs,
      batchSize,
    },
    {
      schedulerId: MAINTENANCE_SCHEDULERS.PROCESSING_RECONCILIATION,
      jobName: MAINTENANCE_JOBS.RECONCILE_PROCESSING,
      every: reconcileIntervalMs,
      batchSize,
    },
    {
      schedulerId: MAINTENANCE_SCHEDULERS.STORAGE_CLEANUP,
      jobName: MAINTENANCE_JOBS.CLEANUP_STORAGE,
      every: cleanupIntervalMs,
      batchSize,
    },
  ];
}

/**
 * Registers the Job Schedulers of `video-maintenance` when the worker starts (TD-12). `upsert` by
 * stable id: several instances, or a restart, keep one scheduler per id. A restart with the same
 * settings keeps the next run of each scheduler; a changed interval or batch updates it.
 */
@Injectable()
export class MaintenanceSchedulerRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceSchedulerRegistrar.name);

  constructor(
    @InjectQueue(VIDEO_QUEUES.MAINTENANCE)
    private readonly queue: Queue<MaintenanceJobData>,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.register();
  }

  async register(): Promise<void> {
    for (const schedule of maintenanceSchedules(this.config)) {
      await this.queue.upsertJobScheduler(
        schedule.schedulerId,
        { every: schedule.every },
        {
          name: schedule.jobName,
          data: { batchSize: schedule.batchSize },
          opts: MAINTENANCE_JOB_OPTIONS,
        },
      );
      this.logger.log({
        event: 'video-maintenance.scheduler-registered',
        schedulerId: schedule.schedulerId,
        jobName: schedule.jobName,
        every: schedule.every,
        batchSize: schedule.batchSize,
      });
    }
  }
}
