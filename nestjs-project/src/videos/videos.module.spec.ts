import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { UploadPart } from './entities/upload-part.entity';
import { UploadSession } from './entities/upload-session.entity';
import { Video } from './entities/video.entity';
import { VideoJobDispatcherService } from './jobs/video-job-dispatcher.service';
import { UploadCompletionService } from './upload-completion.service';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsController } from './upload-sessions.controller';
import { UploadSessionsService } from './upload-sessions.service';
import { VideoLockService } from './video-lock.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VIDEO_QUEUES } from './videos.constants';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

describe('VideosModule', () => {
  it('should compile with the repositories, the storage, the video-processing queue, the services and the controller', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRoot({
          connection: {
            host: queueConfig().redis.host,
            port: queueConfig().redis.port,
          },
        }),
        VideosModule,
      ],
    }).compile();

    try {
      for (const entity of [Video, UploadSession, UploadPart]) {
        expect(module.get(getRepositoryToken(entity))).toBeDefined();
      }
      expect(module.get(VideoLockService)).toBeInstanceOf(VideoLockService);
      expect(module.get(VideoJobDispatcherService)).toBeInstanceOf(
        VideoJobDispatcherService,
      );
      expect(module.get(UploadSessionAccessService)).toBeInstanceOf(
        UploadSessionAccessService,
      );
      expect(module.get(UploadSessionsService)).toBeInstanceOf(
        UploadSessionsService,
      );
      expect(module.get(UploadPartsService)).toBeInstanceOf(UploadPartsService);
      expect(module.get(UploadCompletionService)).toBeInstanceOf(
        UploadCompletionService,
      );
      expect(module.get(VideosService)).toBeInstanceOf(VideosService);
      expect(module.get(VideosController)).toBeInstanceOf(VideosController);
      expect(module.get(UploadSessionsController)).toBeInstanceOf(
        UploadSessionsController,
      );
      expect(module.get(StorageService)).toBeInstanceOf(StorageService);
      const queue = module.get<Queue>(getQueueToken(VIDEO_QUEUES.PROCESSING));
      expect(queue.name).toBe('video-processing');
    } finally {
      await module.close();
    }
  }, 30000);
});
