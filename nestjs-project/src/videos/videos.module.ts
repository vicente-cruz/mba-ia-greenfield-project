import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { UploadPart } from './entities/upload-part.entity';
import { UploadSession } from './entities/upload-session.entity';
import { Video } from './entities/video.entity';
import { VideoJobDispatcherService } from './jobs/video-job-dispatcher.service';
import { UploadCompletionRepository } from './upload-completion.repository';
import { UploadCompletionService } from './upload-completion.service';
import { UploadPartsRepository } from './upload-parts.repository';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import { UploadSessionsController } from './upload-sessions.controller';
import { UploadSessionsService } from './upload-sessions.service';
import { VideoLockService } from './video-lock.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VIDEO_QUEUES } from './videos.constants';

/**
 * Routes of the phase and the pieces they share with the worker (SI-03.20 imports this module).
 * The BullMQ connection (`BullModule.forRootAsync`) is registered once, by the application root.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video, UploadSession, UploadPart]),
    ChannelsModule,
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_QUEUES.PROCESSING }),
  ],
  controllers: [VideosController, UploadSessionsController],
  providers: [
    VideoLockService,
    VideoJobDispatcherService,
    UploadSessionsRepository,
    UploadSessionAccessService,
    UploadSessionsService,
    UploadPartsRepository,
    UploadPartsService,
    UploadCompletionRepository,
    UploadCompletionService,
    VideosService,
  ],
  exports: [
    TypeOrmModule,
    VideoLockService,
    VideoJobDispatcherService,
    // The sweep of the worker (SI-03.24) reuses the abort and the completion of the sessions.
    UploadSessionsRepository,
    UploadSessionsService,
    UploadCompletionService,
  ],
})
export class VideosModule {}
