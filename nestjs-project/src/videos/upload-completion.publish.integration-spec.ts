import { randomBytes } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { createStorageClient } from '../storage/storage.clients';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  listKeysUnder,
  listUploadsUnder,
  requestPresignedUrl,
  sha256Base64,
} from '../test/storage';
import { saveTestChannel } from '../test/video-entity-fixtures';
import { User } from '../users/entities/user.entity';
import { UploadPart } from './entities/upload-part.entity';
import { UploadSession } from './entities/upload-session.entity';
import {
  Video,
  VideoPendingJobAction,
  VideoStatus,
} from './entities/video.entity';
import { VideoJobDispatcherService } from './jobs/video-job-dispatcher.service';
import { UploadCompletionRepository } from './upload-completion.repository';
import { UploadCompletionService } from './upload-completion.service';
import { UploadPartsRepository } from './upload-parts.repository';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import { UploadSessionsService } from './upload-sessions.service';
import { VideoLockService } from './video-lock.service';
import { VIDEO_JOB_PUBLISH_TIMEOUT_MS, VIDEO_QUEUES } from './videos.constants';

jest.setTimeout(60_000);

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

/** One part of 3 KiB: the Complete accepts a single part of any size. */
const FILE_SIZE = 3_072;
/** The queue is the real `video-processing`, in a keyspace of its own, so no worker consumes it. */
const QUEUE_PREFIX = `test-completion-publish-${process.pid}`;
const REDIS = {
  host: queueConfig().redis.host,
  port: queueConfig().redis.port,
};

/** The completion with its queue on `connection`: the Redis of the environment or an unreachable one. */
async function createModule(connection: {
  host: string;
  port: number;
}): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, videoConfig, queueConfig],
      }),
      TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
      TypeOrmModule.forFeature([Video]),
      ChannelsModule,
      StorageModule,
      BullModule.forRoot({ connection, prefix: QUEUE_PREFIX }),
      BullModule.registerQueue({ name: VIDEO_QUEUES.PROCESSING }),
    ],
    providers: [
      UploadSessionAccessService,
      UploadSessionsService,
      UploadSessionsRepository,
      VideoLockService,
      UploadPartsService,
      UploadPartsRepository,
      UploadCompletionRepository,
      UploadCompletionService,
      VideoJobDispatcherService,
    ],
  }).compile();
}

describe('UploadCompletionService publication (integration)', () => {
  const config = storageConfig();
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let queue: Queue;
  /** The queue the API publishes to in the environment, with the default prefix. */
  let environmentQueue: Queue;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await createModule(REDIS);
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get(getQueueToken(VIDEO_QUEUES.PROCESSING));
    environmentQueue = new Queue(VIDEO_QUEUES.PROCESSING, {
      connection: REDIS,
    });
  });

  afterAll(async () => {
    try {
      await removeStorageOfAllVideos();
      await cleanAllTables(dataSource);
      await queue.obliterate({ force: true });
    } finally {
      s3.destroy();
      await environmentQueue.close();
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await removeStorageOfAllVideos();
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    channel = await saveTestChannel(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function removeStorageOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
      const prefix = `originals/${video.id}/`;
      for (const upload of await listUploadsUnder(s3, config.bucket, prefix)) {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: config.bucket,
            Key: upload.key,
            UploadId: upload.uploadId,
          }),
        );
      }
      for (const key of await listKeysUnder(s3, config.bucket, prefix)) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
        );
      }
    }
  }

  /** A one-part session with its part sent and registered, ready to complete. */
  async function readyUpload(target: TestingModule = moduleRef) {
    const sessions = target.get(UploadSessionsService);
    const partsService = target.get(UploadPartsService);
    const file = randomBytes(FILE_SIZE);
    const created = await sessions.createVideoWithSession(channel.user_id, {
      fileName: 'publish.mp4',
      sizeBytes: FILE_SIZE,
      contentType: 'video/mp4',
    });
    const sessionId = created.uploadSession.id;
    const {
      parts: [signed],
    } = await partsService.requestPartUrls(
      channel.user_id,
      created.publicId,
      sessionId,
      { parts: [{ partNumber: 1, checksumSha256: sha256Base64(file) }] },
    );
    const put = await requestPresignedUrl(signed.url, {
      method: signed.method,
      headers: { ...signed.headers },
      body: file,
    });
    expect(put.status).toBe(200);
    await partsService.requestPartUrls(
      channel.user_id,
      created.publicId,
      sessionId,
      { completedParts: [{ partNumber: 1, etag: put.headers.etag as string }] },
    );
    const session = await dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
    return {
      videoId: session.video_id,
      jobId: `video-${session.video_id}-1-1`,
      complete: (service: UploadCompletionService) =>
        service.completeUpload(channel.user_id, created.publicId, sessionId),
    };
  }

  async function storedVideo(videoId: string): Promise<Video> {
    return dataSource.getRepository(Video).findOneByOrFail({ id: videoId });
  }

  /** The video moved by T2 with the `publish` action still recorded, as F-02 requires. */
  async function expectPublishPending(videoId: string): Promise<void> {
    const video = await storedVideo(videoId);
    expect(video).toMatchObject({
      status: VideoStatus.PROCESSING,
      processing_run: 1,
      processing_dispatch: 1,
      pending_job_action: VideoPendingJobAction.PUBLISH,
      pending_job_dispatch: 1,
    });
    expect(video.pending_job_token).toEqual(expect.any(String));
    expect(video.pending_job_expires_at).toBeInstanceOf(Date);
    const [{ inFuture }] = await dataSource.query<{ inFuture: boolean }[]>(
      `SELECT pending_job_expires_at > now() AS "inFuture" FROM videos WHERE id = $1`,
      [videoId],
    );
    expect(inFuture).toBe(true);
  }

  it('should publish generation 1 after the commit, kept until the collection, and confirm the action (R2, R3)', async () => {
    const upload = await readyUpload();

    await expect(
      upload.complete(moduleRef.get(UploadCompletionService)),
    ).resolves.toMatchObject({ transitioned: true });

    const job = await queue.getJob(upload.jobId);
    expect(job?.data).toEqual({ videoId: upload.videoId, run: 1 });
    expect(job?.opts).toMatchObject({
      attempts: queueConfig().videoProcessing.attempts,
      removeOnComplete: false,
      removeOnFail: false,
    });
    await expect(storedVideo(upload.videoId)).resolves.toMatchObject({
      pending_job_action: null,
      pending_job_dispatch: null,
      pending_job_token: null,
    });
  });

  it('should keep the 202 and leave the publish action pending, with no job of generation 1, when the add fails', async () => {
    const upload = await readyUpload();
    jest
      .spyOn(queue, 'add')
      .mockRejectedValueOnce(new Error('Connection is closed.'));

    await expect(
      upload.complete(moduleRef.get(UploadCompletionService)),
    ).resolves.toMatchObject({ transitioned: true });

    await expectPublishPending(upload.videoId);
    await expect(queue.getJob(upload.jobId)).resolves.toBeUndefined();
  });

  it('should answer within the bound and leave the publish action pending when the Redis cannot be reached', async () => {
    const unreachable = await createModule({ host: REDIS.host, port: 1 });
    const unreachableQueue = unreachable.get<Queue>(
      getQueueToken(VIDEO_QUEUES.PROCESSING),
    );
    // The refused connections are the scenario; without a listener BullMQ logs each one.
    unreachableQueue.on('error', () => undefined);
    try {
      const upload = await readyUpload(unreachable);
      const startedAt = Date.now();

      await expect(
        upload.complete(unreachable.get(UploadCompletionService)),
      ).resolves.toMatchObject({ transitioned: true });

      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(VIDEO_JOB_PUBLISH_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(VIDEO_JOB_PUBLISH_TIMEOUT_MS + 10_000);
      await expectPublishPending(upload.videoId);
      await expect(queue.getJob(upload.jobId)).resolves.toBeUndefined();
      await expect(
        environmentQueue.getJob(upload.jobId),
      ).resolves.toBeUndefined();
    } finally {
      await unreachable.close();
    }
  });
});
