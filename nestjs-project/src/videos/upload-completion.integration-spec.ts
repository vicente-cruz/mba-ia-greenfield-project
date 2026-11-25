import { randomBytes } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
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
import { STORAGE_INTERNAL_CLIENT } from '../storage/storage.constants';
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
  UploadIncompleteException,
  UploadPartMismatchException,
  UploadSessionCompletingException,
  UploadSessionExpiredException,
} from './exceptions/video.exceptions';
import { VideoJobDispatcherService } from './jobs/video-job-dispatcher.service';
import { UploadCompletionRepository } from './upload-completion.repository';
import { UploadCompletionService } from './upload-completion.service';
import { UploadPartsRepository } from './upload-parts.repository';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import { UploadSessionsService } from './upload-sessions.service';
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

/** 5 MiB, the minimum the storage accepts for every part but the last one in a Complete. */
const PART_SIZE = 5_242_880;
/** One part of 3 KiB. */
const ONE_PART = 3_072;
/** Two parts: 5 MiB and a last one of 1 KiB. */
const TWO_PARTS = PART_SIZE + 1_024;
/** The queue is the real `video-processing`, in a keyspace of its own, so no worker consumes it. */
const QUEUE_PREFIX = `test-completion-${process.pid}`;

async function createModule(
  internalStorageEndpoint?: string,
): Promise<TestingModule> {
  let builder = Test.createTestingModule({
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
  })
    .overrideProvider(videoConfig.KEY)
    .useValue({ ...videoConfig(), uploadPartSizeBytes: PART_SIZE });
  if (internalStorageEndpoint) {
    builder = builder
      .overrideProvider(STORAGE_INTERNAL_CLIENT)
      .useValue(createStorageClient(storageConfig(), internalStorageEndpoint));
  }
  return builder.compile();
}

describe('UploadCompletionService (integration)', () => {
  const config = storageConfig();
  /** Own client for the storage changes and the cleanup, independent of the services under test. */
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let sessionsService: UploadSessionsService;
  let partsService: UploadPartsService;
  let completionService: UploadCompletionService;
  let storage: StorageService;
  let queue: Queue;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await createModule();
    dataSource = moduleRef.get(DataSource);
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

  /** A session created by P1 against the real storage, with the bytes of its file. */
  async function createUpload(sizeBytes: number) {
    const file = randomBytes(sizeBytes);
    const created = await sessionsService.createVideoWithSession(
      channel.user_id,
      { fileName: 'complete.mp4', sizeBytes, contentType: 'video/mp4' },
    );
    const session = await dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: created.uploadSession.id });
    const partOf = (partNumber: number) =>
      file.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE);
    const partUrls = (
      body: Parameters<UploadPartsService['requestPartUrls']>[3],
    ) =>
      partsService.requestPartUrls(
        channel.user_id,
        created.publicId,
        session.id,
        body,
      );

    /** Signs and sends the parts through their signed URLs; returns their ETags. */
    async function sendParts(partNumbers: number[]): Promise<string[]> {
      const { parts } = await partUrls({
        parts: partNumbers.map((partNumber) => ({
          partNumber,
          checksumSha256: sha256Base64(partOf(partNumber)),
        })),
      });
      const etags: string[] = [];
      for (const signed of parts) {
        const put = await requestPresignedUrl(signed.url, {
          method: signed.method,
          headers: { ...signed.headers },
          body: partOf(signed.partNumber),
        });
        expect(put.status).toBe(200);
        etags.push(put.headers.etag as string);
      }
      return etags;
    }

    async function sendAndRegister(partNumbers: number[]): Promise<void> {
      const etags = await sendParts(partNumbers);
      await partUrls({
        completedParts: partNumbers.map((partNumber, index) => ({
          partNumber,
          etag: etags[index],
        })),
      });
    }

    /** UploadPart straight to the multipart of the session, outside the API. */
    async function uploadDirectly(
      partNumber: number,
      body: Buffer,
    ): Promise<void> {
      await s3.send(
        new UploadPartCommand({
          Bucket: config.bucket,
          Key: session.object_key,
          UploadId: session.upload_id ?? '',
          PartNumber: partNumber,
          Body: body,
          ContentLength: body.length,
          ChecksumSHA256: sha256Base64(body),
        }),
      );
    }

    return {
      session,
      publicId: created.publicId,
      sendParts,
      sendAndRegister,
      uploadDirectly,
      complete: (service: UploadCompletionService = completionService) =>
        service.completeUpload(channel.user_id, created.publicId, session.id),
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

  async function jobIdsOf(videoId: string): Promise<string[]> {
    const jobs = await queue.getJobs();
    return jobs
      .map((job) => job.id ?? '')
      .filter((id) => id.startsWith(`video-${videoId}-`));
  }

  /** The session is back to `active` without a claim, and nothing moved the video. */
  async function expectReverted(session: UploadSession): Promise<void> {
    await expect(storedSession(session.id)).resolves.toMatchObject({
      status: UploadSessionStatus.ACTIVE,
      claim_token: null,
      claim_expires_at: null,
    });
    await expect(storedVideo(session.video_id)).resolves.toMatchObject({
      status: VideoStatus.DRAFT,
      processing_run: 0,
      original_key: null,
    });
    await expect(jobIdsOf(session.video_id)).resolves.toEqual([]);
  }

  it('should conclude with 202 when the Complete was already done by the SDK before the call (T-01)', async () => {
    const upload = await createUpload(ONE_PART);
    await upload.sendAndRegister([1]);
    const [part] = await dataSource
      .getRepository(UploadPart)
      .findBy({ upload_session_id: upload.session.id });
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: config.bucket,
        Key: upload.session.object_key,
        UploadId: upload.session.upload_id ?? '',
        MultipartUpload: {
          Parts: [
            {
              PartNumber: 1,
              ETag: part.etag ?? '',
              ChecksumSHA256: part.checksum_sha256,
            },
          ],
        },
      }),
    );

    await expect(upload.complete()).resolves.toEqual({
      transitioned: true,
      body: { publicId: upload.publicId, status: VideoStatus.PROCESSING },
    });

    await expect(storedSession(upload.session.id)).resolves.toMatchObject({
      status: UploadSessionStatus.COMPLETED,
      claim_token: null,
    });
    await expect(storedVideo(upload.session.video_id)).resolves.toMatchObject({
      status: VideoStatus.PROCESSING,
      original_key: upload.session.object_key,
      processing_run: 1,
      processing_dispatch: 1,
      pending_job_action: null,
    });
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: upload.session.object_key,
      }),
    );
    expect(head.ContentLength).toBe(ONE_PART);
    await expect(jobIdsOf(upload.session.video_id)).resolves.toEqual([
      `video-${upload.session.video_id}-1-1`,
    ]);
  });

  it('should bar the old completer whose claim was taken over, which re-reads and finds the completion done (T-04)', async () => {
    const upload = await createUpload(ONE_PART);
    await upload.sendAndRegister([1]);
    const arrived = gate();
    const releaseFirst = gate();
    let calls = 0;
    jest
      .spyOn(storage, 'completeMultipartUpload')
      .mockImplementation(async (key, uploadId, parts) => {
        calls += 1;
        if (calls === 1) {
          arrived.open();
          await releaseFirst.opened;
        }
        return realCompleteMultipartUpload(storage, key, uploadId, parts);
      });

    const first = upload.complete();
    try {
      await arrived.opened;
      const claimedByFirst = await storedSession(upload.session.id);
      expect(claimedByFirst.status).toBe(UploadSessionStatus.COMPLETING);
      await dataSource.query(
        `UPDATE upload_sessions SET claim_expires_at = now() - interval '1 second' WHERE id = $1`,
        [upload.session.id],
      );

      // The second call takes the expired claim over and completes.
      await expect(upload.complete()).resolves.toMatchObject({
        transitioned: true,
      });
      const takenOver = await storedSession(upload.session.id);
      expect(takenOver.status).toBe(UploadSessionStatus.COMPLETED);
    } finally {
      releaseFirst.open();
    }

    // The first one reaches T2 with its old token, affects zero rows and re-reads: the database
    // shows this session completed and recorded by the video, so the answer is 200.
    await expect(first).resolves.toEqual({
      transitioned: false,
      body: { publicId: upload.publicId, status: VideoStatus.PROCESSING },
    });
    await expect(storedVideo(upload.session.video_id)).resolves.toMatchObject({
      processing_run: 1,
      original_key: upload.session.object_key,
    });
    await expect(jobIdsOf(upload.session.video_id)).resolves.toEqual([
      `video-${upload.session.video_id}-1-1`,
    ]);
  });

  describe('conference against the storage (T-07, G-04)', () => {
    it('should answer UPLOAD_PART_MISMATCH and revert for a part sent again with other content after its registry', async () => {
      const upload = await createUpload(ONE_PART);
      await upload.sendAndRegister([1]);
      await upload.uploadDirectly(1, randomBytes(ONE_PART));

      await expect(upload.complete()).rejects.toBeInstanceOf(
        UploadPartMismatchException,
      );
      await expectReverted(upload.session);
    });

    it('should answer UPLOAD_INCOMPLETE and revert for a part sent without its ETag registered', async () => {
      const upload = await createUpload(TWO_PARTS);
      await upload.sendAndRegister([1]);
      await upload.sendParts([2]);

      await expect(upload.complete()).rejects.toBeInstanceOf(
        UploadIncompleteException,
      );
      await expectReverted(upload.session);
    });

    it('should answer UPLOAD_PART_MISMATCH and revert for a part present in the storage without any registry', async () => {
      const upload = await createUpload(TWO_PARTS);
      await upload.sendAndRegister([1]);
      await upload.uploadDirectly(2, randomBytes(1_024));

      await expect(upload.complete()).rejects.toBeInstanceOf(
        UploadPartMismatchException,
      );
      await expectReverted(upload.session);
    });

    it('should answer UPLOAD_PART_MISMATCH and revert for a part listed beyond the plan', async () => {
      const upload = await createUpload(ONE_PART);
      await upload.sendAndRegister([1]);
      await upload.uploadDirectly(2, randomBytes(1_024));

      await expect(upload.complete()).rejects.toBeInstanceOf(
        UploadPartMismatchException,
      );
      await expectReverted(upload.session);
    });
  });

  describe('NoSuchUpload without the object of the declared size', () => {
    it.each([
      ['no object at the key', null],
      ['an object of another size at the key', ONE_PART + 1],
    ])(
      'should abort the session by the token and answer UPLOAD_SESSION_EXPIRED for %s',
      async (_, objectSize) => {
        const upload = await createUpload(ONE_PART);
        await upload.sendAndRegister([1]);
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: config.bucket,
            Key: upload.session.object_key,
            UploadId: upload.session.upload_id ?? '',
          }),
        );
        if (objectSize !== null) {
          const body = randomBytes(objectSize);
          await s3.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: upload.session.object_key,
              Body: body,
              ContentLength: body.length,
            }),
          );
        }

        await expect(upload.complete()).rejects.toBeInstanceOf(
          UploadSessionExpiredException,
        );

        await expect(storedSession(upload.session.id)).resolves.toMatchObject({
          status: UploadSessionStatus.ABORTED,
          claim_token: null,
        });
        await expect(
          storedVideo(upload.session.video_id),
        ).resolves.toMatchObject({
          status: VideoStatus.DRAFT,
          original_key: null,
        });
      },
    );
  });

  it('should answer STORAGE_UNAVAILABLE, keep the claim until it expires and let the next call resume it (G-02)', async () => {
    const upload = await createUpload(ONE_PART);
    await upload.sendAndRegister([1]);
    const unreachable = await createModule('http://storage:1');

    try {
      await expect(
        upload.complete(unreachable.get(UploadCompletionService)),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    } finally {
      await unreachable.close();
    }

    const claimed = await storedSession(upload.session.id);
    expect(claimed.status).toBe(UploadSessionStatus.COMPLETING);
    expect(claimed.claim_token).toEqual(expect.any(String));
    await expect(upload.complete()).rejects.toBeInstanceOf(
      UploadSessionCompletingException,
    );

    await dataSource.query(
      `UPDATE upload_sessions SET claim_expires_at = now() - interval '1 second' WHERE id = $1`,
      [upload.session.id],
    );
    await expect(upload.complete()).resolves.toMatchObject({
      transitioned: true,
    });
    const resumed = await storedSession(upload.session.id);
    expect(resumed.status).toBe(UploadSessionStatus.COMPLETED);
  });

  it('should answer UPLOAD_SESSION_EXPIRED for an active session past its deadline, without claiming it', async () => {
    const upload = await createUpload(ONE_PART);
    await upload.sendAndRegister([1]);
    await dataSource.query(
      `UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [upload.session.id],
    );

    await expect(upload.complete()).rejects.toBeInstanceOf(
      UploadSessionExpiredException,
    );
    await expectReverted(upload.session);
  });
});
