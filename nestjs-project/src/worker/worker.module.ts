import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import {
  bullRootOptions,
  typeOrmRootOptions,
} from '../config/root-connections';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { Video } from '../videos/entities/video.entity';
import { VideosModule } from '../videos/videos.module';
import { VIDEO_QUEUES } from '../videos/videos.constants';
import { MediaProbeService } from './media/media-probe.service';
import { MaintenanceSchedulerRegistrar } from './maintenance/maintenance-scheduler.registrar';
import { MAINTENANCE_JOBS } from './maintenance/maintenance.constants';
import {
  MAINTENANCE_TASKS,
  type MaintenanceTasks,
} from './maintenance/maintenance-task';
import { MaintenanceProcessor } from './maintenance/maintenance.processor';
import { ProcessingReconciliationRepository } from './maintenance/processing-reconciliation.repository';
import { ProcessingReconcilerService } from './maintenance/processing-reconciler.service';
import { StorageCleanerService } from './maintenance/storage-cleaner.service';
import { StorageCleanupRepository } from './maintenance/storage-cleanup.repository';
import { UploadSessionSweeperService } from './maintenance/upload-session-sweeper.service';
import { MediaProcessRunner } from './media/media-process.runner';
import { ProcessingStateService } from './processing/processing-state.service';
import { VideoProcessingProcessor } from './processing/video-processing.processor';
import { WorkerLifecycleService } from './worker-lifecycle.service';

/**
 * Root module of the `video-worker` process (TD-10): the same code as the API, without HTTP. It
 * loads only the namespaces the worker uses, validated by the same schema as the API, and opens
 * its own database and Redis connections.
 *
 * `VideoProcessingProcessor` consumes `video-processing` (SI-03.22). `MaintenanceProcessor`
 * consumes `video-maintenance`, fed by the schedulers of `MaintenanceSchedulerRegistrar`
 * (SI-03.23), with the three tasks of `MAINTENANCE_TASKS`: the sweep of upload sessions
 * (`UploadSessionSweeperService`, SI-03.24), the reconciliation of the processing
 * (`ProcessingReconcilerService`, SI-03.25) and the cleanup of the storage
 * (`StorageCleanerService`, SI-03.26).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig, videoConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: typeOrmRootOptions,
    }),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: bullRootOptions,
    }),
    StorageModule,
    VideosModule,
    // `Channel` relates to `User`: the entity of its own module must be loaded for the metadata.
    UsersModule,
    BullModule.registerQueue({ name: VIDEO_QUEUES.MAINTENANCE }),
    // The reconciliation (SI-03.25) reads and collects the jobs of the processing.
    BullModule.registerQueue({ name: VIDEO_QUEUES.PROCESSING }),
    TypeOrmModule.forFeature([Video]),
  ],
  providers: [
    WorkerLifecycleService,
    MediaProcessRunner,
    MediaProbeService,
    ProcessingStateService,
    VideoProcessingProcessor,
    MaintenanceSchedulerRegistrar,
    MaintenanceProcessor,
    UploadSessionSweeperService,
    ProcessingReconciliationRepository,
    ProcessingReconcilerService,
    StorageCleanupRepository,
    StorageCleanerService,
    {
      provide: MAINTENANCE_TASKS,
      inject: [
        UploadSessionSweeperService,
        ProcessingReconcilerService,
        StorageCleanerService,
      ],
      useFactory: (
        sweeper: UploadSessionSweeperService,
        reconciler: ProcessingReconcilerService,
        cleaner: StorageCleanerService,
      ): MaintenanceTasks => ({
        [MAINTENANCE_JOBS.SWEEP_UPLOAD_SESSIONS]: sweeper,
        [MAINTENANCE_JOBS.RECONCILE_PROCESSING]: reconciler,
        [MAINTENANCE_JOBS.CLEANUP_STORAGE]: cleaner,
      }),
    },
  ],
})
export class WorkerModule {}
