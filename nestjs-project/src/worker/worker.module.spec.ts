import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { UploadPart } from '../videos/entities/upload-part.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoJobDispatcherService } from '../videos/jobs/video-job-dispatcher.service';
import { VIDEO_QUEUES } from '../videos/videos.constants';
import { MaintenanceSchedulerRegistrar } from './maintenance/maintenance-scheduler.registrar';
import {
  MAINTENANCE_TASKS,
  type MaintenanceTasks,
} from './maintenance/maintenance-task';
import { ProcessingReconcilerService } from './maintenance/processing-reconciler.service';
import { StorageCleanerService } from './maintenance/storage-cleaner.service';
import { UploadSessionSweeperService } from './maintenance/upload-session-sweeper.service';
import { MaintenanceProcessor } from './maintenance/maintenance.processor';
import { MediaProbeService } from './media/media-probe.service';
import { ProcessingStateService } from './processing/processing-state.service';
import { VideoProcessingProcessor } from './processing/video-processing.processor';
import { WorkerLifecycleService } from './worker-lifecycle.service';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  }, 30_000);

  afterAll(async () => {
    await module?.close();
  });

  it('should compile with its own configuration, database, storage and queues', () => {
    expect(module.get(WorkerLifecycleService)).toBeInstanceOf(
      WorkerLifecycleService,
    );
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(MediaProbeService)).toBeInstanceOf(MediaProbeService);
    expect(module.get(ProcessingStateService)).toBeInstanceOf(
      ProcessingStateService,
    );
    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(module.get(MaintenanceSchedulerRegistrar)).toBeInstanceOf(
      MaintenanceSchedulerRegistrar,
    );
    expect(module.get(MaintenanceProcessor)).toBeInstanceOf(
      MaintenanceProcessor,
    );
    expect(
      Object.keys(module.get<MaintenanceTasks>(MAINTENANCE_TASKS)).sort(),
    ).toEqual([
      'cleanup-storage',
      'reconcile-processing',
      'sweep-upload-sessions',
    ]);
  });

  it('should run the real sweep, reconciliation and cleanup', () => {
    const tasks = module.get<MaintenanceTasks>(MAINTENANCE_TASKS);

    expect(tasks).toEqual({
      'sweep-upload-sessions': module.get(UploadSessionSweeperService),
      'reconcile-processing': module.get(ProcessingReconcilerService),
      'cleanup-storage': module.get(StorageCleanerService),
    });
    expect(module.get(VideoJobDispatcherService)).toBeInstanceOf(
      VideoJobDispatcherService,
    );
    expect(module.get<Queue>(getQueueToken(VIDEO_QUEUES.PROCESSING)).name).toBe(
      'video-processing',
    );
    expect(
      module.get<Queue>(getQueueToken(VIDEO_QUEUES.MAINTENANCE)).name,
    ).toBe('video-maintenance');
  });

  it('should build the metadata of every entity the video code reaches, including the relations', () => {
    const dataSource = module.get(DataSource);

    expect(dataSource.isInitialized).toBe(true);
    for (const entity of [Video, UploadSession, UploadPart, Channel, User]) {
      expect(dataSource.hasMetadata(entity)).toBe(true);
    }
  });
});
