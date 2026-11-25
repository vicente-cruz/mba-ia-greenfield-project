import { randomBytes, randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { ChannelsModule } from '../../channels/channels.module';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { createStorageClient } from '../../storage/storage.clients';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  listKeysUnder,
  listUploadsUnder,
  requestPresignedUrl,
  sha256Base64,
} from '../../test/storage';
import { saveTestChannel } from '../../test/video-entity-fixtures';
import { User } from '../../users/entities/user.entity';
import { UploadPart } from '../../videos/entities/upload-part.entity';
import {
  UploadSession,
  UploadSessionStatus,
} from '../../videos/entities/upload-session.entity';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import { VideoJobDispatcherService } from '../../videos/jobs/video-job-dispatcher.service';
import { UploadCompletionRepository } from '../../videos/upload-completion.repository';
import { UploadCompletionService } from '../../videos/upload-completion.service';
import { UploadPartsRepository } from '../../videos/upload-parts.repository';
import { UploadPartsService } from '../../videos/upload-parts.service';
import { UploadSessionAccessService } from '../../videos/upload-session-access.service';
import { UploadSessionsRepository } from '../../videos/upload-sessions.repository';
import { UploadSessionsService } from '../../videos/upload-sessions.service';
import { VideoLockService } from '../../videos/video-lock.service';
import { VIDEO_QUEUES } from '../../videos/videos.constants';
import { UploadSessionSweeperService } from './upload-session-sweeper.service';

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
const BATCH = { batchSize: 100 };
/** The queue of the publication of P2, in a keyspace of its own: no worker consumes it. */
const QUEUE_PREFIX = `test-upload-session-sweep-${process.pid}`;

async function createModule(): Promise<TestingModule> {
  const { host, port } = queueConfig().redis;
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
      BullModule.forRoot({ connection: { host, port }, prefix: QUEUE_PREFIX }),
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
      UploadSessionSweeperService,
    ],
  }).compile();
}

describe('UploadSessionSweeperService (integration)', () => {
  const config = storageConfig();
  /** Own client for the storage changes and the cleanup, independent of the services under test. */
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let sweeper: UploadSessionSweeperService;
  let sessionsService: UploadSessionsService;
  let partsService: UploadPartsService;
  let completionService: UploadCompletionService;
  let storage: StorageService;
  let queue: Queue;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await createModule();
    dataSource = moduleRef.get(DataSource);
    sweeper = moduleRef.get(UploadSessionSweeperService);
    sessionsService = moduleRef.get(UploadSessionsService);
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

  /** A one-part session created by P1 against the real storage. */
  async function createUpload() {
    const body = randomBytes(FILE_SIZE);
    const created = await sessionsService.createVideoWithSession(
      channel.user_id,
      { fileName: 'sweep.mp4', sizeBytes: FILE_SIZE, contentType: 'video/mp4' },
    );
    const session = await storedSession(created.uploadSession.id);
    const partUrls = (
      request: Parameters<UploadPartsService['requestPartUrls']>[3],
    ) =>
      partsService.requestPartUrls(
        channel.user_id,
        created.publicId,
        session.id,
        request,
      );
    return {
      session,
      publicId: created.publicId,
      /** Signs part 1 for the file, without sending it. */
      sign: async () => {
        const {
          parts: [signed],
        } = await partUrls({
          parts: [{ partNumber: 1, checksumSha256: sha256Base64(body) }],
        });
        return { signed, body };
      },
      /** Signs, sends and registers part 1: the session is ready to complete. */
      sendAndRegister: async () => {
        const {
          parts: [signed],
        } = await partUrls({
          parts: [{ partNumber: 1, checksumSha256: sha256Base64(body) }],
        });
        const put = await requestPresignedUrl(signed.url, {
          method: signed.method,
          headers: { ...signed.headers },
          body,
        });
        expect(put.status).toBe(200);
        await partUrls({
          completedParts: [{ partNumber: 1, etag: put.headers.etag as string }],
        });
        return {
          etag: put.headers.etag as string,
          checksumSha256: sha256Base64(body),
        };
      },
      complete: () =>
        completionService.completeUpload(
          channel.user_id,
          created.publicId,
          session.id,
        ),
    };
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  async function storedVideo(videoId: string): Promise<Video> {
    return dataSource.getRepository(Video).findOneByOrFail({ id: videoId });
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

  async function objectSize(key: string): Promise<number | null> {
    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      return head.ContentLength ?? null;
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFound') {
        return null;
      }
      throw error;
    }
  }

  /** `active` past its deadline, as the clock of the database sees it. */
  async function expireSession(sessionId: string): Promise<void> {
    await dataSource.query(
      `UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [sessionId],
    );
  }

  /** A claim recorded by the test with another token and an expired deadline (T-04). */
  async function leaveExpiredClaim(
    sessionId: string,
    status: UploadSessionStatus,
  ): Promise<string> {
    const token = randomUUID();
    await dataSource.query(
      `UPDATE upload_sessions
          SET status = $2, claim_token = $3,
              claim_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [sessionId, status, token],
    );
    return token;
  }

  async function blockedOnVideoLock(): Promise<number> {
    const [{ blocked }] = await dataSource.query<{ blocked: number }[]>(
      `SELECT count(*)::int AS blocked FROM pg_stat_activity
        WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query LIKE 'SELECT "Video"."id"%'`,
    );
    return blocked;
  }

  async function waitForBlocked(count: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while ((await blockedOnVideoLock()) < count) {
      if (Date.now() > deadline) {
        throw new Error(`fewer than ${count} operations wait on the lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Holds the lock of the video in a transaction of the test until `release` is called. */
  async function holdVideoLock(videoId: string) {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query('SELECT id FROM videos WHERE id = $1 FOR UPDATE', [
      videoId,
    ]);
    return {
      release: async () => {
        await runner.commitTransaction();
        await runner.release();
      },
    };
  }

  describe('abort of sessions past their deadlines (P1, G-10)', () => {
    it('should abort an active session past expires_at, confirmed by NoSuchUpload, and leave a current one alone', async () => {
      const expired = await createUpload();
      const current = await createUpload();
      await expireSession(expired.session.id);

      const result = await sweeper.run(BATCH);

      expect(result).toMatchObject({ examined: 1, aborted: 1, failed: 0 });
      await expect(storedSession(expired.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTED,
        claim_token: null,
        claim_expires_at: null,
      });
      await expect(
        uploadExists(
          expired.session.object_key,
          expired.session.upload_id ?? '',
        ),
      ).resolves.toBe(false);
      await expect(
        storedVideo(expired.session.video_id),
      ).resolves.toMatchObject({
        status: VideoStatus.DRAFT,
        current_upload_session_id: expired.session.id,
      });
      await expect(storedSession(current.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ACTIVE,
      });
      await expect(
        uploadExists(
          current.session.object_key,
          current.session.upload_id ?? '',
        ),
      ).resolves.toBe(true);
    });

    it('should abort the multipart of an orphan initiating session without registry, leaving no upload at its key (P1)', async () => {
      const other = await createUpload();
      const orphan = await createUpload();
      // The creator died after CreateMultipartUpload and before T2: no upload_id is recorded.
      await dataSource.query(
        `UPDATE upload_sessions SET status = 'initiating', upload_id = NULL WHERE id = $1`,
        [orphan.session.id],
      );
      await leaveExpiredClaim(
        orphan.session.id,
        UploadSessionStatus.INITIATING,
      );

      const result = await sweeper.run(BATCH);

      expect(result).toMatchObject({ examined: 1, aborted: 1, failed: 0 });
      await expect(storedSession(orphan.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTED,
        claim_token: null,
      });
      expect(
        (
          await listUploadsUnder(s3, config.bucket, orphan.session.object_key)
        ).filter((upload) => upload.key === orphan.session.object_key),
      ).toEqual([]);
      await expect(
        uploadExists(other.session.object_key, other.session.upload_id ?? ''),
      ).resolves.toBe(true);
    });

    it('should leave an initiating or aborting session within its claim deadline alone', async () => {
      const initiating = await createUpload();
      const aborting = await createUpload();
      await dataSource.query(
        `UPDATE upload_sessions
            SET status = 'initiating', upload_id = NULL, claim_token = $2,
                claim_expires_at = now() + interval '1 minute'
          WHERE id = $1`,
        [initiating.session.id, randomUUID()],
      );
      await dataSource.query(
        `UPDATE upload_sessions
            SET status = 'aborting', claim_token = $2,
                claim_expires_at = now() + interval '1 minute'
          WHERE id = $1`,
        [aborting.session.id, randomUUID()],
      );

      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        examined: 0,
      });

      await expect(storedSession(initiating.session.id)).resolves.toMatchObject(
        { status: UploadSessionStatus.INITIATING },
      );
      await expect(storedSession(aborting.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTING,
      });
    });

    it('should confirm with NoSuchUpload an abort that a part in transit kept listed, after a part was sent (T-05, F-09)', async () => {
      const upload = await createUpload();
      const { signed, body } = await upload.sign();
      // DELETE aborts, but the listing still shows the upload: the session stays aborting.
      const listParts = jest
        .spyOn(storage, 'listParts')
        .mockResolvedValue({ status: 'found', parts: [] });
      await sessionsService.abortSession(
        channel.user_id,
        upload.publicId,
        upload.session.id,
      );
      const left = await storedSession(upload.session.id);
      expect(left.status).toBe(UploadSessionStatus.ABORTING);
      // The part in transit arrives after the abort.
      const put = await requestPresignedUrl(signed.url, {
        method: signed.method,
        headers: { ...signed.headers },
        body,
      });
      expect(put.status).toBe(404);
      expect(put.body.toString()).toContain('NoSuchUpload');

      // Within the claim of DELETE, the sweep leaves it; once expired, it takes it over.
      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        examined: 0,
      });
      listParts.mockRestore();
      await dataSource.query(
        `UPDATE upload_sessions SET claim_expires_at = now() - interval '1 second' WHERE id = $1`,
        [upload.session.id],
      );
      const realListParts = jest.spyOn(storage, 'listParts');

      const result = await sweeper.run(BATCH);

      expect(result).toMatchObject({ examined: 1, aborted: 1 });
      await expect(realListParts.mock.results[0].value).resolves.toEqual({
        status: 'no-such-upload',
      });
      const swept = await storedSession(upload.session.id);
      expect(swept).toMatchObject({
        status: UploadSessionStatus.ABORTED,
        claim_token: null,
      });
      await expect(
        uploadExists(upload.session.object_key, upload.session.upload_id ?? ''),
      ).resolves.toBe(false);
    });

    it('should keep the session aborting with the claim of the sweep while the storage does not confirm, without counting a failure (F-09)', async () => {
      const upload = await createUpload();
      await expireSession(upload.session.id);
      jest
        .spyOn(storage, 'listParts')
        .mockResolvedValue({ status: 'found', parts: [] });

      const result = await sweeper.run(BATCH);

      expect(result).toMatchObject({
        examined: 1,
        aborted: 0,
        abortUnconfirmed: 1,
        failed: 0,
      });
      const left = await storedSession(upload.session.id);
      expect(left.status).toBe(UploadSessionStatus.ABORTING);
      expect(left.claim_token).toEqual(expect.any(String));
    });
  });

  describe('resumption of an expired completion (T-04, P2, G-02, F-01)', () => {
    it('should resume a completing claim recorded by the test and finalize it, publishing generation 1', async () => {
      const upload = await createUpload();
      await upload.sendAndRegister();
      const previousToken = await leaveExpiredClaim(
        upload.session.id,
        UploadSessionStatus.COMPLETING,
      );

      const result = await sweeper.run(BATCH);

      expect(result).toMatchObject({ examined: 1, completed: 1, failed: 0 });
      const session = await storedSession(upload.session.id);
      expect(session).toMatchObject({
        status: UploadSessionStatus.COMPLETED,
        claim_token: null,
      });
      expect(session.claim_token).not.toBe(previousToken);
      await expect(storedVideo(upload.session.video_id)).resolves.toMatchObject(
        {
          status: VideoStatus.PROCESSING,
          original_key: upload.session.object_key,
          processing_run: 1,
          processing_dispatch: 1,
          pending_job_action: null,
        },
      );
      await expect(objectSize(upload.session.object_key)).resolves.toBe(
        FILE_SIZE,
      );
      await expect(
        queue.getJob(`video-${upload.session.video_id}-1-1`),
      ).resolves.toBeDefined();
    });

    it('should resume, not abort, a completing session whose own deadline also expired', async () => {
      const upload = await createUpload();
      await upload.sendAndRegister();
      await leaveExpiredClaim(
        upload.session.id,
        UploadSessionStatus.COMPLETING,
      );
      await expireSession(upload.session.id);

      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        completed: 1,
        aborted: 0,
      });

      await expect(storedSession(upload.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.COMPLETED,
      });
    });

    it('should finalize a partial completion whose Complete already happened, confirming the object by HeadObject', async () => {
      const upload = await createUpload();
      const part = await upload.sendAndRegister();
      // The completer died after the Complete and before T2.
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: config.bucket,
          Key: upload.session.object_key,
          UploadId: upload.session.upload_id ?? '',
          MultipartUpload: {
            Parts: [
              {
                PartNumber: 1,
                ETag: part.etag,
                ChecksumSHA256: part.checksumSha256,
              },
            ],
          },
        }),
      );
      await leaveExpiredClaim(
        upload.session.id,
        UploadSessionStatus.COMPLETING,
      );

      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        completed: 1,
      });

      await expect(storedSession(upload.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.COMPLETED,
      });
      await expect(storedVideo(upload.session.video_id)).resolves.toMatchObject(
        { status: VideoStatus.PROCESSING },
      );
    });

    it('should revert to active, not abort, a resumed completion whose conference fails', async () => {
      const upload = await createUpload();
      await leaveExpiredClaim(
        upload.session.id,
        UploadSessionStatus.COMPLETING,
      );

      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        completed: 0,
        completionDecided: 1,
        aborted: 0,
      });

      await expect(storedSession(upload.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ACTIVE,
        claim_token: null,
        claim_expires_at: null,
      });
      await expect(
        uploadExists(upload.session.object_key, upload.session.upload_id ?? ''),
      ).resolves.toBe(true);
    });

    it('should re-read after losing the token in T2 and never finalize for another claim (step 5)', async () => {
      const upload = await createUpload();
      await upload.sendAndRegister();
      await leaveExpiredClaim(
        upload.session.id,
        UploadSessionStatus.COMPLETING,
      );
      const realComplete = storage.completeMultipartUpload.bind(
        storage,
      ) as StorageService['completeMultipartUpload'];
      let otherToken = '';
      jest
        .spyOn(storage, 'completeMultipartUpload')
        .mockImplementation(async (key, uploadId, parts) => {
          const completed = await realComplete(key, uploadId, parts);
          // Another process takes the completion over between the Complete and T2.
          otherToken = randomUUID();
          await dataSource.query(
            `UPDATE upload_sessions SET claim_token = $2 WHERE id = $1`,
            [upload.session.id, otherToken],
          );
          return completed;
        });

      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        completed: 0,
        completionDecided: 1,
      });

      await expect(storedSession(upload.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.COMPLETING,
        claim_token: otherToken,
      });
      await expect(storedVideo(upload.session.video_id)).resolves.toMatchObject(
        { status: VideoStatus.DRAFT },
      );
      await expect(
        queue.getJob(`video-${upload.session.video_id}-1-1`),
      ).resolves.toBeUndefined();
    });

    it('should not complete a session listed as completing that another process reverted to active before the claim', async () => {
      const upload = await createUpload();
      await upload.sendAndRegister();
      await leaveExpiredClaim(
        upload.session.id,
        UploadSessionStatus.COMPLETING,
      );
      const repository = moduleRef.get(UploadSessionsRepository);
      const realFind = repository.findSweepCandidates.bind(
        repository,
      ) as UploadSessionsRepository['findSweepCandidates'];
      jest
        .spyOn(repository, 'findSweepCandidates')
        .mockImplementation(async (batchSize) => {
          const candidates = await realFind(batchSize);
          // Between the listing and the claim, another resumption reverted the completion.
          await dataSource.query(
            `UPDATE upload_sessions
                SET status = 'active', claim_token = NULL, claim_expires_at = NULL
              WHERE id = $1`,
            [upload.session.id],
          );
          return candidates;
        });
      const complete = jest.spyOn(storage, 'completeMultipartUpload');

      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        examined: 1,
        completed: 0,
        skipped: 1,
      });

      expect(complete).not.toHaveBeenCalled();
      await expect(storedSession(upload.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ACTIVE,
        claim_token: null,
      });
      await expect(storedVideo(upload.session.video_id)).resolves.toMatchObject(
        { status: VideoStatus.DRAFT },
      );
    });

    it('should leave a completing session within its claim deadline alone', async () => {
      const upload = await createUpload();
      await dataSource.query(
        `UPDATE upload_sessions
            SET status = 'completing', claim_token = $2,
                claim_expires_at = now() + interval '1 minute'
          WHERE id = $1`,
        [upload.session.id, randomUUID()],
      );
      await expireSession(upload.session.id);

      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        examined: 0,
      });
      await expect(storedSession(upload.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.COMPLETING,
      });
    });
  });

  describe('completion and sweep at the limit of the expiry (T-03, F-08)', () => {
    it('should let the completion that started within the deadline win over the sweep that arrives after it', async () => {
      const upload = await createUpload();
      await upload.sendAndRegister();
      await dataSource.query(
        `UPDATE upload_sessions SET expires_at = now() + interval '1500 milliseconds' WHERE id = $1`,
        [upload.session.id],
      );
      const lock = await holdVideoLock(upload.session.video_id);
      let completion: Promise<unknown> = Promise.resolve();
      let sweep: Promise<unknown> = Promise.resolve();
      try {
        // The claim of the completion starts within the deadline and waits for the lock.
        completion = upload.complete();
        await waitForBlocked(1);
        // The deadline passes; the sweep lists the session and waits for the same lock.
        await new Promise((resolve) => setTimeout(resolve, 1_700));
        sweep = sweeper.run(BATCH);
        await waitForBlocked(2);
      } finally {
        await lock.release();
      }

      await expect(completion).resolves.toMatchObject({ transitioned: true });
      await expect(sweep).resolves.toMatchObject({
        examined: 1,
        aborted: 0,
        skipped: 1,
      });
      await expect(storedSession(upload.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.COMPLETED,
      });
      await expect(storedVideo(upload.session.video_id)).resolves.toMatchObject(
        { status: VideoStatus.PROCESSING },
      );
    });

    it('should let the sweep that claimed the expired session first win over the completion that arrives after it', async () => {
      const upload = await createUpload();
      await upload.sendAndRegister();
      await expireSession(upload.session.id);
      const lock = await holdVideoLock(upload.session.video_id);
      let completion: Promise<unknown> = Promise.resolve();
      let sweep: Promise<unknown> = Promise.resolve();
      try {
        sweep = sweeper.run(BATCH);
        await waitForBlocked(1);
        completion = upload.complete().catch((error: unknown) => error);
        await waitForBlocked(2);
      } finally {
        await lock.release();
      }

      await expect(sweep).resolves.toMatchObject({ examined: 1, aborted: 1 });
      await expect(completion).resolves.toMatchObject({
        errorCode: 'UPLOAD_SESSION_NOT_ACTIVE',
      });
      await expect(storedSession(upload.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTED,
      });
      await expect(storedVideo(upload.session.video_id)).resolves.toMatchObject(
        { status: VideoStatus.DRAFT },
      );
      await expect(
        uploadExists(upload.session.object_key, upload.session.upload_id ?? ''),
      ).resolves.toBe(false);
    });
  });

  describe('batches', () => {
    async function threeCandidates() {
      const active = await createUpload();
      await expireSession(active.session.id);
      const orphan = await createUpload();
      await dataSource.query(
        `UPDATE upload_sessions SET status = 'initiating', upload_id = NULL WHERE id = $1`,
        [orphan.session.id],
      );
      await leaveExpiredClaim(
        orphan.session.id,
        UploadSessionStatus.INITIATING,
      );
      const completing = await createUpload();
      await completing.sendAndRegister();
      await leaveExpiredClaim(
        completing.session.id,
        UploadSessionStatus.COMPLETING,
      );
      return [active, orphan, completing];
    }

    async function snapshot() {
      return {
        sessions: await dataSource
          .getRepository(UploadSession)
          .find({ order: { id: 'ASC' } }),
        videos: await dataSource
          .getRepository(Video)
          .find({ order: { id: 'ASC' } }),
      };
    }

    it('should change nothing when the same batch runs again', async () => {
      await threeCandidates();
      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        examined: 3,
        aborted: 2,
        completed: 1,
      });
      const after = await snapshot();
      const jobs = await queue.getJobCounts();

      await expect(sweeper.run(BATCH)).resolves.toMatchObject({
        examined: 0,
      });

      expect(await snapshot()).toEqual(after);
      expect(await queue.getJobCounts()).toEqual(jobs);
    });

    it('should act once on each session when two sweeps run at the same time', async () => {
      const [active, orphan, completing] = await threeCandidates();
      const markAborted = jest.spyOn(
        moduleRef.get(UploadSessionsRepository),
        'markAborted',
      );

      const results = await Promise.all([
        sweeper.run(BATCH),
        sweeper.run(BATCH),
      ]);

      const total = (key: 'aborted' | 'completed' | 'failed') =>
        results.reduce((sum, result) => sum + result[key], 0);
      expect(total('aborted')).toBe(2);
      expect(total('completed')).toBe(1);
      expect(total('failed')).toBe(0);
      expect(
        markAborted.mock.results.filter((call) => call.type === 'return'),
      ).toHaveLength(2);
      for (const upload of [active, orphan]) {
        await expect(storedSession(upload.session.id)).resolves.toMatchObject({
          status: UploadSessionStatus.ABORTED,
        });
      }
      await expect(storedSession(completing.session.id)).resolves.toMatchObject(
        { status: UploadSessionStatus.COMPLETED },
      );
    });

    it('should take at most batchSize sessions per run, oldest deadline first', async () => {
      const uploads = [
        await createUpload(),
        await createUpload(),
        await createUpload(),
      ];
      for (const [index, upload] of uploads.entries()) {
        await dataSource.query(
          `UPDATE upload_sessions SET expires_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
          [upload.session.id, String(3 - index)],
        );
      }

      await expect(sweeper.run({ batchSize: 2 })).resolves.toMatchObject({
        examined: 2,
        aborted: 2,
      });
      await expect(storedSession(uploads[2].session.id)).resolves.toMatchObject(
        { status: UploadSessionStatus.ACTIVE },
      );
      await expect(sweeper.run({ batchSize: 2 })).resolves.toMatchObject({
        examined: 1,
        aborted: 1,
      });
    });

    it('should finish the batch when one session fails, and then fail the run', async () => {
      const failing = await createUpload();
      await leaveExpiredClaim(
        failing.session.id,
        UploadSessionStatus.COMPLETING,
      );
      const expired = await createUpload();
      await expireSession(expired.session.id);
      jest
        .spyOn(completionService, 'resumeExpiredCompletion')
        .mockRejectedValue(new Error('database unreachable'));

      await expect(sweeper.run(BATCH)).rejects.toThrow(
        'sweep of upload sessions: 1 of 2 sessions failed',
      );

      await expect(storedSession(expired.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTED,
      });
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'should refuse a batchSize of %s without touching anything',
      async (batchSize) => {
        await expect(sweeper.run({ batchSize })).rejects.toThrow(
          'invalid batchSize',
        );
      },
    );
  });
});
