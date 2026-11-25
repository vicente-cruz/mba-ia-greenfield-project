import { randomBytes, randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { createStorageClient } from '../storage/storage.clients';
import { StorageUnavailableException } from '../storage/storage.exceptions';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { gate } from '../test/locks';
import {
  listKeysUnder,
  listUploadsUnder,
  realCompleteMultipartUpload,
  realCreateMultipartUpload,
  requestPresignedUrl,
  sha256Base64,
} from '../test/storage';
import { saveTestChannel } from '../test/video-entity-fixtures';
import { User } from '../users/entities/user.entity';
import { UploadPart } from './entities/upload-part.entity';
import {
  UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import { Video, VideoStatus } from './entities/video.entity';
import {
  UploadSessionCompletingException,
  UploadSessionInitiatingException,
  UploadSessionNotActiveException,
} from './exceptions/video.exceptions';
import { VideoJobDispatcherService } from './jobs/video-job-dispatcher.service';
import { UploadCompletionRepository } from './upload-completion.repository';
import { UploadCompletionService } from './upload-completion.service';
import { UploadPartsRepository } from './upload-parts.repository';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import {
  type UploadDeclaration,
  UploadSessionsService,
} from './upload-sessions.service';
import { VideoLockService } from './video-lock.service';
import { VIDEO_QUEUES } from './videos.constants';

jest.setTimeout(30_000);

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
const DECLARATION: UploadDeclaration = {
  fileName: 'restart.mp4',
  sizeBytes: FILE_SIZE,
  contentType: 'video/mp4',
};
/** The queue is the real `video-processing`, in a keyspace of its own, so no worker consumes it. */
const QUEUE_PREFIX = `test-restart-${process.pid}`;

describe('UploadSessionsService.restartSession (integration)', () => {
  const config = storageConfig();
  /** Own client for checks and cleanup, independent of the services under test. */
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: UploadSessionsService;
  let partsService: UploadPartsService;
  let completionService: UploadCompletionService;
  let storage: StorageService;
  let queue: Queue;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        ChannelsModule,
        StorageModule,
        BullModule.forRoot({
          connection: {
            host: queueConfig().redis.host,
            port: queueConfig().redis.port,
          },
          prefix: QUEUE_PREFIX,
        }),
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
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(UploadSessionsService);
    partsService = moduleRef.get(UploadPartsService);
    completionService = moduleRef.get(UploadCompletionService);
    storage = moduleRef.get(StorageService);
    queue = moduleRef.get(getQueueToken(VIDEO_QUEUES.PROCESSING));
  });

  afterAll(async () => {
    try {
      await removeStorageOfAllVideos();
      await cleanAllTables(dataSource);
      await queue.obliterate({ force: true });
    } finally {
      s3.destroy();
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

  /** A draft video with its first session active, created by P1 against the real storage. */
  async function createDraft() {
    const created = await service.createVideoWithSession(
      channel.user_id,
      DECLARATION,
    );
    const first = await storedSession(created.uploadSession.id);
    return {
      publicId: created.publicId,
      videoId: first.video_id,
      first,
      restart: () =>
        service.restartSession(channel.user_id, created.publicId, DECLARATION),
    };
  }

  /** Signs, sends and registers the single part of the current session `sessionId`. */
  async function sendAndRegister(
    publicId: string,
    sessionId: string,
  ): Promise<void> {
    const body = randomBytes(FILE_SIZE);
    const {
      parts: [signed],
    } = await partsService.requestPartUrls(
      channel.user_id,
      publicId,
      sessionId,
      { parts: [{ partNumber: 1, checksumSha256: sha256Base64(body) }] },
    );
    const put = await requestPresignedUrl(signed.url, {
      method: signed.method,
      headers: { ...signed.headers },
      body,
    });
    expect(put.status).toBe(200);
    await partsService.requestPartUrls(channel.user_id, publicId, sessionId, {
      completedParts: [{ partNumber: 1, etag: put.headers.etag as string }],
    });
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  async function storedVideo(videoId: string): Promise<Video> {
    return dataSource.getRepository(Video).findOneByOrFail({ id: videoId });
  }

  async function sessionsOf(videoId: string): Promise<UploadSession[]> {
    return dataSource
      .getRepository(UploadSession)
      .find({ where: { video_id: videoId }, order: { created_at: 'ASC' } });
  }

  async function uploadExists(key: string, uploadId: string): Promise<boolean> {
    try {
      await s3.send(
        new ListPartsCommand({
          Bucket: config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchUpload') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Holds the first call of the real `createMultipartUpload` until the test releases it; that is,
   * the first restart (or creation) after its T1. Later calls go straight to the storage.
   */
  function holdFirstCreate(failWith?: Error) {
    const arrived = gate();
    const release = gate();
    let calls = 0;
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockImplementation(async (key, options) => {
        if (calls++ === 0) {
          arrived.open();
          await release.opened;
          if (failWith) {
            throw failWith;
          }
        }
        return realCreateMultipartUpload(storage, key, options);
      });
    return { arrived: arrived.opened, release: release.open };
  }

  async function takeOverInDatabase(sessionId: string): Promise<string> {
    const token = randomUUID();
    await dataSource.query(
      `UPDATE upload_sessions
          SET status = 'aborting', claim_token = $2,
              claim_expires_at = now() + interval '5 minutes'
        WHERE id = $1`,
      [sessionId, token],
    );
    return token;
  }

  describe('restarts (T-03)', () => {
    it('should refuse a second restart while the first is held after T1, and leave a single active session', async () => {
      const draft = await createDraft();
      const barrier = holdFirstCreate();

      const first = draft.restart();
      try {
        await barrier.arrived;
        const video = await storedVideo(draft.videoId);
        const held = await storedSession(video.current_upload_session_id ?? '');
        expect(held.id).not.toBe(draft.first.id);
        expect(held.status).toBe(UploadSessionStatus.INITIATING);
        const [{ claimInFuture }] = await dataSource.query<
          { claimInFuture: boolean }[]
        >(
          `SELECT claim_expires_at > now() AS "claimInFuture" FROM upload_sessions WHERE id = $1`,
          [held.id],
        );
        expect(claimInFuture).toBe(true);
        await expect(storedSession(draft.first.id)).resolves.toMatchObject({
          status: UploadSessionStatus.ABORTING,
        });

        await expect(draft.restart()).rejects.toBeInstanceOf(
          UploadSessionInitiatingException,
        );

        barrier.release();
        const response = await first;
        expect(response.uploadSession.id).toBe(held.id);
      } finally {
        barrier.release();
        await Promise.allSettled([first]);
      }

      const sessions = await sessionsOf(draft.videoId);
      expect(sessions.map((session) => session.status)).toEqual([
        UploadSessionStatus.ABORTED,
        UploadSessionStatus.ACTIVE,
      ]);
    });

    it('should accept a restart after the activation of the first one, aborting the session it created', async () => {
      const draft = await createDraft();

      const first = await draft.restart();
      const second = await draft.restart();

      expect(second.uploadSession.id).not.toBe(first.uploadSession.id);
      const firstRestarted = await storedSession(first.uploadSession.id);
      expect(firstRestarted.status).toBe(UploadSessionStatus.ABORTED);
      await expect(
        uploadExists(firstRestarted.object_key, firstRestarted.upload_id ?? ''),
      ).resolves.toBe(false);
      const active = (await sessionsOf(draft.videoId)).filter(
        (session) => session.status === UploadSessionStatus.ACTIVE,
      );
      expect(active.map((session) => session.id)).toEqual([
        second.uploadSession.id,
      ]);
      await expect(storedVideo(draft.videoId)).resolves.toMatchObject({
        current_upload_session_id: second.uploadSession.id,
        status: VideoStatus.DRAFT,
      });
    });
  });

  describe('restart and completion (P1 and P2 under the same lock)', () => {
    it('should refuse the restart with UPLOAD_SESSION_COMPLETING when the completion claims first', async () => {
      const draft = await createDraft();
      await sendAndRegister(draft.publicId, draft.first.id);
      const arrived = gate();
      const release = gate();
      jest
        .spyOn(storage, 'completeMultipartUpload')
        .mockImplementation(async (key, uploadId, parts) => {
          arrived.open();
          await release.opened;
          return realCompleteMultipartUpload(storage, key, uploadId, parts);
        });

      const completion = completionService.completeUpload(
        channel.user_id,
        draft.publicId,
        draft.first.id,
      );
      try {
        await arrived.opened;
        await expect(draft.restart()).rejects.toBeInstanceOf(
          UploadSessionCompletingException,
        );
        release.open();
        await expect(completion).resolves.toMatchObject({
          transitioned: true,
        });
      } finally {
        release.open();
        await Promise.allSettled([completion]);
      }

      await expect(sessionsOf(draft.videoId)).resolves.toHaveLength(1);
      await expect(storedVideo(draft.videoId)).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        original_key: draft.first.object_key,
      });
    });

    it('should refuse the completion with UPLOAD_SESSION_NOT_ACTIVE when the restart claims first', async () => {
      const draft = await createDraft();
      await sendAndRegister(draft.publicId, draft.first.id);
      const barrier = holdFirstCreate();

      const restart = draft.restart();
      try {
        await barrier.arrived;
        await expect(
          completionService.completeUpload(
            channel.user_id,
            draft.publicId,
            draft.first.id,
          ),
        ).rejects.toBeInstanceOf(UploadSessionNotActiveException);
        barrier.release();
        await expect(restart).resolves.toMatchObject({ status: 'draft' });
      } finally {
        barrier.release();
        await Promise.allSettled([restart]);
      }

      await expect(storedSession(draft.first.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTED,
      });
      await expect(storedVideo(draft.videoId)).resolves.toMatchObject({
        status: VideoStatus.DRAFT,
        processing_run: 0,
      });
      await expect(queue.getJobs()).resolves.toEqual([]);
    });
  });

  it('should refuse the restart of a draft whose session is completing, even with its claim expired, writing nothing', async () => {
    const draft = await createDraft();
    await dataSource.query(
      `UPDATE upload_sessions
          SET status = 'completing', claim_token = $2,
              claim_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [draft.first.id, randomUUID()],
    );
    const before = await storedSession(draft.first.id);

    await expect(draft.restart()).rejects.toBeInstanceOf(
      UploadSessionCompletingException,
    );

    await expect(storedSession(draft.first.id)).resolves.toEqual(before);
    await expect(sessionsOf(draft.videoId)).resolves.toHaveLength(1);
    await expect(storedVideo(draft.videoId)).resolves.toMatchObject({
      current_upload_session_id: draft.first.id,
    });
  });

  describe('drafts left by expired or abandoned sessions', () => {
    it('should restart a draft whose session expired (Q-04), aborting it', async () => {
      const draft = await createDraft();
      await dataSource.query(
        `UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [draft.first.id],
      );

      const restarted = await draft.restart();

      expect(restarted.uploadSession.status).toBe(UploadSessionStatus.ACTIVE);
      await expect(storedSession(draft.first.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTED,
      });
    });

    it('should restart a draft whose session is aborting within the claim of another operation, leaving that claim alone', async () => {
      const draft = await createDraft();
      const token = await takeOverInDatabase(draft.first.id);
      const before = await storedSession(draft.first.id);

      const restarted = await draft.restart();

      expect(restarted.uploadSession.id).not.toBe(draft.first.id);
      await expect(storedSession(draft.first.id)).resolves.toEqual(before);
      expect(before.claim_token).toBe(token);
    });

    it('should restart a draft whose session is aborted', async () => {
      const draft = await createDraft();
      await dataSource.query(
        `UPDATE upload_sessions SET status = 'aborted' WHERE id = $1`,
        [draft.first.id],
      );

      await expect(draft.restart()).resolves.toMatchObject({
        uploadSession: { status: UploadSessionStatus.ACTIVE },
      });
    });

    it('should take over an initiating session with an expired claim and abort its multipart found at its key', async () => {
      const draft = await createDraft();
      const orphanUploadId = draft.first.upload_id ?? '';
      await dataSource.query(
        `UPDATE upload_sessions
            SET status = 'initiating', upload_id = NULL, claim_token = $2,
                claim_expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [draft.first.id, randomUUID()],
      );

      await expect(draft.restart()).resolves.toMatchObject({
        uploadSession: { status: UploadSessionStatus.ACTIVE },
      });
      await expect(storedSession(draft.first.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTED,
      });
      await expect(
        uploadExists(draft.first.object_key, orphanUploadId),
      ).resolves.toBe(false);
    });
  });

  describe('failures after T1', () => {
    it('should end the new session aborted, keep the video a restartable draft and answer STORAGE_UNAVAILABLE when the Create fails', async () => {
      const draft = await createDraft();
      const failure = new StorageUnavailableException('CreateMultipartUpload');
      jest
        .spyOn(storage, 'createMultipartUpload')
        .mockRejectedValueOnce(failure);

      await expect(draft.restart()).rejects.toBe(failure);

      const video = await storedVideo(draft.videoId);
      expect(video.status).toBe(VideoStatus.DRAFT);
      const abandoned = await storedSession(
        video.current_upload_session_id ?? '',
      );
      expect(abandoned.id).not.toBe(draft.first.id);
      expect(abandoned).toMatchObject({
        status: UploadSessionStatus.ABORTED,
        claim_token: null,
      });
      await expect(storedSession(draft.first.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTED,
      });
      await expect(draft.restart()).resolves.toMatchObject({
        uploadSession: { status: UploadSessionStatus.ACTIVE },
      });
    });

    it('should abort its own upload and answer UPLOAD_SESSION_NOT_ACTIVE when another operation took the new session over before T2', async () => {
      const draft = await createDraft();
      const barrier = holdFirstCreate();

      const restart = draft.restart();
      let token = '';
      let newSessionId = '';
      try {
        await barrier.arrived;
        newSessionId =
          (await storedVideo(draft.videoId)).current_upload_session_id ?? '';
        token = await takeOverInDatabase(newSessionId);
        barrier.release();
        await expect(restart).rejects.toBeInstanceOf(
          UploadSessionNotActiveException,
        );
      } finally {
        barrier.release();
        await Promise.allSettled([restart]);
      }

      const takenOver = await storedSession(newSessionId);
      expect(takenOver).toMatchObject({
        status: UploadSessionStatus.ABORTING,
        claim_token: token,
        upload_id: null,
      });
      await expect(
        listUploadsUnder(s3, config.bucket, takenOver.object_key),
      ).resolves.toEqual([]);
    });

    it('should not let the abandon after a failed Create overwrite a new session taken over by another operation', async () => {
      const draft = await createDraft();
      const barrier = holdFirstCreate(
        new StorageUnavailableException('CreateMultipartUpload'),
      );

      const restart = draft.restart();
      let token = '';
      let newSessionId = '';
      try {
        await barrier.arrived;
        newSessionId =
          (await storedVideo(draft.videoId)).current_upload_session_id ?? '';
        token = await takeOverInDatabase(newSessionId);
        barrier.release();
        await expect(restart).rejects.toBeInstanceOf(
          StorageUnavailableException,
        );
      } finally {
        barrier.release();
        await Promise.allSettled([restart]);
      }

      await expect(storedSession(newSessionId)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTING,
        claim_token: token,
      });
    });
  });

  it('should start the new session without the file mismatch block, keeping the block and the registry of the old one', async () => {
    const draft = await createDraft();
    await sendAndRegister(draft.publicId, draft.first.id);
    await dataSource.query(
      `UPDATE upload_sessions SET file_mismatch_at = now() WHERE id = $1`,
      [draft.first.id],
    );
    const registryBefore = await dataSource
      .getRepository(UploadPart)
      .findBy({ upload_session_id: draft.first.id });

    const restarted = await draft.restart();

    await expect(
      storedSession(restarted.uploadSession.id),
    ).resolves.toMatchObject({ file_mismatch_at: null });
    const old = await storedSession(draft.first.id);
    expect(old.status).toBe(UploadSessionStatus.ABORTED);
    expect(old.file_mismatch_at).toBeInstanceOf(Date);
    await expect(
      dataSource
        .getRepository(UploadPart)
        .findBy({ upload_session_id: draft.first.id }),
    ).resolves.toEqual(registryBefore);
  });
});
