import { randomUUID } from 'node:crypto';
import { AbortMultipartUploadCommand, type S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { createStorageClient } from '../storage/storage.clients';
import { STORAGE_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageUnavailableException } from '../storage/storage.exceptions';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { listUploadsUnder, realCreateMultipartUpload } from '../test/storage';
import { saveTestChannel } from '../test/video-entity-fixtures';
import { User } from '../users/entities/user.entity';
import { UploadPart } from './entities/upload-part.entity';
import {
  UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { UploadPartsRepository } from './upload-parts.repository';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import {
  type UploadDeclaration,
  UploadSessionsService,
} from './upload-sessions.service';
import { VideoLockService } from './video-lock.service';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

const DECLARATION: UploadDeclaration = {
  fileName: 'a.mp4',
  sizeBytes: 10_000_000_000,
  contentType: 'video/mp4',
};
const DAY_MS = 24 * 60 * 60 * 1000;

async function createModule(internalClient?: S3Client): Promise<TestingModule> {
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, videoConfig],
      }),
      TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
      ChannelsModule,
      StorageModule,
    ],
    providers: [
      UploadSessionAccessService,
      UploadSessionsService,
      UploadSessionsRepository,
      UploadPartsService,
      UploadPartsRepository,
      VideoLockService,
    ],
  });
  if (internalClient) {
    builder = builder
      .overrideProvider(STORAGE_INTERNAL_CLIENT)
      .useValue(internalClient);
  }
  return builder.compile();
}

describe('UploadSessionsService.createVideoWithSession (integration)', () => {
  const config = storageConfig();
  /** Own client for checks and cleanup, independent of the service under test. */
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: UploadSessionsService;
  let storage: StorageService;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await createModule();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(UploadSessionsService);
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    try {
      await abortUploadsOfAllVideos();
      await cleanAllTables(dataSource);
    } finally {
      s3.destroy();
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await abortUploadsOfAllVideos();
    await cleanAllTables(dataSource);
    channel = await saveTestChannel(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function abortUploadsOfAllVideos(): Promise<void> {
    const videos = await dataSource.getRepository(Video).find();
    for (const video of videos) {
      for (const upload of await listUploadsUnder(
        s3,
        config.bucket,
        `originals/${video.id}/`,
      )) {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: config.bucket,
            Key: upload.key,
            UploadId: upload.uploadId,
          }),
        );
      }
    }
  }

  /** What the sweep does after the claim deadline: `initiating → aborting` with a new token. */
  async function simulateSweepTakeover(objectKey: string): Promise<string> {
    const sweepToken = randomUUID();
    const sessionId = objectKey.split('/')[2];
    await dataSource.getRepository(UploadSession).update(
      { id: sessionId },
      {
        status: UploadSessionStatus.ABORTING,
        claim_token: sweepToken,
        claim_expires_at: new Date(Date.now() + 300_000),
      },
    );
    return sweepToken;
  }

  async function usableSessionsOf(videoId: string): Promise<number> {
    const [{ count }] = await dataSource.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM upload_sessions
       WHERE video_id = $1
         AND (status = 'active'
              OR (status = 'initiating' AND claim_expires_at > now()))`,
      [videoId],
    );
    return count;
  }

  it('should record the intent (T1) and commit it before calling the storage', async () => {
    let seenByStorageCall: UploadSession | null = null;
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockImplementation(async (key, options) => {
        // A query on another connection sees the committed intent.
        seenByStorageCall = await dataSource
          .getRepository(UploadSession)
          .findOneBy({ object_key: key });
        return realCreateMultipartUpload(storage, key, options);
      });

    await service.createVideoWithSession(channel.user_id, DECLARATION);

    expect(seenByStorageCall).toMatchObject({
      status: UploadSessionStatus.INITIATING,
      upload_id: null,
    });
    const intent = seenByStorageCall as unknown as UploadSession;
    expect(intent.claim_token).toEqual(expect.any(String));
    expect(intent.expires_at.getTime()).toBe(
      intent.claim_expires_at?.getTime(),
    );
    const claimMs =
      (intent.claim_expires_at?.getTime() ?? 0) - intent.created_at.getTime();
    expect(Math.abs(claimMs - 300_000)).toBeLessThan(5_000);
  });

  it('should leave a draft video and an active session whose multipart lives at originals/{videoId}/{sessionId}', async () => {
    const result = await service.createVideoWithSession(
      channel.user_id,
      DECLARATION,
    );

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: result.publicId });
    expect(video).toMatchObject({
      status: VideoStatus.DRAFT,
      channel_id: channel.id,
      current_upload_session_id: result.uploadSession.id,
      original_filename: 'a.mp4',
      content_type: 'video/mp4',
      size_bytes: 10_000_000_000,
    });
    const session = await dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: result.uploadSession.id });
    expect(session).toMatchObject({
      video_id: video.id,
      object_key: `originals/${video.id}/${session.id}`,
      status: UploadSessionStatus.ACTIVE,
      part_size: 67_108_864,
      part_count: 150,
      checksum_algorithm: 'SHA256',
      claim_token: null,
      claim_expires_at: null,
      file_mismatch_at: null,
    });
    expect(session.upload_id).toEqual(expect.any(String));
    expect(session.expires_at.getTime()).toBe(
      result.uploadSession.expiresAt.getTime(),
    );
    expect(
      Math.abs(session.expires_at.getTime() - Date.now() - DAY_MS),
    ).toBeLessThan(60_000);

    const uploads = await listUploadsUnder(
      s3,
      config.bucket,
      session.object_key,
    );
    expect(uploads).toEqual([
      { key: session.object_key, uploadId: session.upload_id },
    ]);
  });

  describe('CreateMultipartUpload failure', () => {
    it('should compensate with no orphan rows when the storage is unreachable (T-05)', async () => {
      const unreachable = await createModule(
        createStorageClient(config, 'http://storage:1'),
      );
      try {
        await expect(
          unreachable
            .get(UploadSessionsService)
            .createVideoWithSession(channel.user_id, DECLARATION),
        ).rejects.toBeInstanceOf(StorageUnavailableException);
      } finally {
        await unreachable.close();
      }

      await expect(dataSource.getRepository(Video).count()).resolves.toBe(0);
      await expect(
        dataSource.getRepository(UploadSession).count(),
      ).resolves.toBe(0);
    });

    it('should not compensate when the session no longer holds the claim token', async () => {
      let sweepToken = '';
      jest
        .spyOn(storage, 'createMultipartUpload')
        .mockImplementation(async (key) => {
          sweepToken = await simulateSweepTakeover(key);
          throw new StorageUnavailableException('CreateMultipartUpload');
        });

      await expect(
        service.createVideoWithSession(channel.user_id, DECLARATION),
      ).rejects.toBeInstanceOf(StorageUnavailableException);

      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ channel_id: channel.id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      await expect(
        dataSource
          .getRepository(UploadSession)
          .findOneByOrFail({ id: video.current_upload_session_id ?? '' }),
      ).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTING,
        claim_token: sweepToken,
      });
    });
  });

  describe('activation that loses the claim (T2 with zero rows)', () => {
    it('should abort the own upload and keep the draft in the restart condition of P1', async () => {
      let sweepToken = '';
      let objectKey = '';
      jest
        .spyOn(storage, 'createMultipartUpload')
        .mockImplementation(async (key, options) => {
          objectKey = key;
          sweepToken = await simulateSweepTakeover(key);
          return realCreateMultipartUpload(storage, key, options);
        });

      await expect(
        service.createVideoWithSession(channel.user_id, DECLARATION),
      ).rejects.toMatchObject({
        errorCode: 'STORAGE_UNAVAILABLE',
        httpStatus: 503,
      });

      await expect(
        listUploadsUnder(s3, config.bucket, objectKey),
      ).resolves.toEqual([]);
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ channel_id: channel.id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      const session = await dataSource
        .getRepository(UploadSession)
        .findOneByOrFail({ object_key: objectKey });
      expect(video.current_upload_session_id).toBe(session.id);
      expect(session).toMatchObject({
        status: UploadSessionStatus.ABORTING,
        claim_token: sweepToken,
        upload_id: null,
      });
      await expect(usableSessionsOf(video.id)).resolves.toBe(0);
    });
  });
});
