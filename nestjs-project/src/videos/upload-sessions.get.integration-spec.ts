import { randomUUID } from 'node:crypto';
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
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
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { gate, waitForBlockedVideoLock } from '../test/locks';
import { listUploadsUnder } from '../test/storage';
import { saveTestChannel } from '../test/video-entity-fixtures';
import { User } from '../users/entities/user.entity';
import { UploadPart } from './entities/upload-part.entity';
import {
  UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { UploadSessionExpiredException } from './exceptions/video.exceptions';
import { UploadPartState } from './upload-part-classification';
import { UploadPartsRepository } from './upload-parts.repository';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import { UploadSessionsService } from './upload-sessions.service';
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

async function createModule(
  internalStorageEndpoint?: string,
): Promise<TestingModule> {
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
      VideoLockService,
      UploadPartsService,
      UploadPartsRepository,
    ],
  });
  if (internalStorageEndpoint) {
    builder = builder
      .overrideProvider(STORAGE_INTERNAL_CLIENT)
      .useValue(createStorageClient(storageConfig(), internalStorageEndpoint));
  }
  return builder.compile();
}

describe('UploadSessionsService.getSession (integration)', () => {
  const config = storageConfig();
  /** Own client for the storage changes and the cleanup, independent of the services under test. */
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: UploadSessionsService;
  let videoLock: VideoLockService;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await createModule();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(UploadSessionsService);
    videoLock = moduleRef.get(VideoLockService);
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

  async function abortUploadsOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
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

  /** A one-part session created by P1 against the real storage. */
  async function createUpload() {
    const created = await service.createVideoWithSession(channel.user_id, {
      fileName: 'get.mp4',
      sizeBytes: 3_072,
      contentType: 'video/mp4',
    });
    const session = await storedSession(created.uploadSession.id);
    return {
      publicId: created.publicId,
      session,
      get: (target: UploadSessionsService = service) =>
        target.getSession(channel.user_id, created.publicId, session.id),
    };
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  /** Removes the multipart upload of the session, as the automatic cleanup of the storage does. */
  async function removeUploadFromStorage(
    session: UploadSession,
  ): Promise<void> {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: config.bucket,
        Key: session.object_key,
        UploadId: session.upload_id ?? '',
      }),
    );
  }

  it('should claim the session whose upload vanished, leave it aborted and answer UPLOAD_SESSION_EXPIRED (F-10)', async () => {
    const upload = await createUpload();
    await removeUploadFromStorage(upload.session);

    await expect(upload.get()).rejects.toBeInstanceOf(
      UploadSessionExpiredException,
    );

    const session = await storedSession(upload.session.id);
    expect(session).toMatchObject({
      status: UploadSessionStatus.ABORTED,
      claim_token: null,
      claim_expires_at: null,
      upload_id: upload.session.upload_id,
    });
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: upload.session.video_id });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.current_upload_session_id).toBe(upload.session.id);
  });

  it('should wait for the lock of the video and keep the transition its holder committed', async () => {
    const upload = await createUpload();
    await removeUploadFromStorage(upload.session);
    const completionToken = randomUUID();
    const holderHasLock = gate();
    const releaseHolder = gate();

    // A completion claims the session under the lock while the GET is reading the storage.
    const holder = videoLock.withLockedVideo(
      upload.session.video_id,
      async (_, manager) => {
        await manager.update(
          UploadSession,
          { id: upload.session.id },
          {
            status: UploadSessionStatus.COMPLETING,
            claim_token: completionToken,
            claim_expires_at: new Date(Date.now() + 60_000),
          },
        );
        holderHasLock.open();
        await releaseHolder.opened;
      },
    );
    await holderHasLock.opened;
    const get = upload.get();

    try {
      await waitForBlockedVideoLock(dataSource);
    } finally {
      releaseHolder.open();
      await holder;
    }

    await expect(get).resolves.toMatchObject({
      id: upload.session.id,
      status: UploadSessionStatus.COMPLETING,
      expired: false,
      parts: [],
    });
    await expect(storedSession(upload.session.id)).resolves.toMatchObject({
      status: UploadSessionStatus.COMPLETING,
      claim_token: completionToken,
    });
  });

  it('should answer STORAGE_UNAVAILABLE and change nothing when the storage cannot be reached', async () => {
    const upload = await createUpload();
    const before = await storedSession(upload.session.id);
    const unreachable = await createModule('http://storage:1');

    try {
      await expect(
        upload.get(unreachable.get(UploadSessionsService)),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    } finally {
      await unreachable.close();
    }

    await expect(storedSession(upload.session.id)).resolves.toEqual(before);
  });

  it('should report an expired deadline by the clock of the database, classifying the parts without aborting', async () => {
    const upload = await createUpload();
    await dataSource.query(
      `UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [upload.session.id],
    );

    await expect(upload.get()).resolves.toMatchObject({
      status: UploadSessionStatus.ACTIVE,
      expired: true,
      parts: [
        {
          partNumber: 1,
          state: UploadPartState.MISSING,
          checksumSha256: null,
          etag: null,
        },
      ],
    });
    await expect(storedSession(upload.session.id)).resolves.toMatchObject({
      status: UploadSessionStatus.ACTIVE,
      claim_token: null,
    });
  });
});
