import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { ChannelsModule } from '../../channels/channels.module';
import { Channel } from '../../channels/entities/channel.entity';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { createStorageClient } from '../../storage/storage.clients';
import { StorageModule } from '../../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { listKeysUnder, listUploadsUnder } from '../../test/storage';
import {
  buildUploadSession,
  buildVideo,
  saveTestChannel,
} from '../../test/video-entity-fixtures';
import { User } from '../../users/entities/user.entity';
import { UploadPart } from '../../videos/entities/upload-part.entity';
import {
  UploadSession,
  UploadSessionStatus,
} from '../../videos/entities/upload-session.entity';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import {
  originalObjectKey,
  thumbnailObjectKey,
} from '../../videos/storage-keys';
import { UploadPartsRepository } from '../../videos/upload-parts.repository';
import { UploadPartsService } from '../../videos/upload-parts.service';
import { UploadSessionAccessService } from '../../videos/upload-session-access.service';
import { UploadSessionsRepository } from '../../videos/upload-sessions.repository';
import { UploadSessionsService } from '../../videos/upload-sessions.service';
import { VideoLockService } from '../../videos/video-lock.service';
import { StorageCleanerService } from './storage-cleaner.service';
import { StorageCleanupRepository } from './storage-cleanup.repository';

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
const BATCH = { batchSize: 100 };

function createModule(storageCleanupGraceMs: number): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, videoConfig],
      }),
      TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
      TypeOrmModule.forFeature([Video, UploadSession]),
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
      StorageCleanupRepository,
      StorageCleanerService,
    ],
  })
    .overrideProvider(videoConfig.KEY)
    .useValue({ ...videoConfig(), storageCleanupGraceMs })
    .compile();
}

/** A UUID whose first block orders it in the listings of the storage. */
const orderedId = (first: string) => `${first}-${randomUUID().slice(9)}`;

/**
 * P4 against the real database and storage (Silo). The cleanup walks the whole prefixes
 * `originals/` and `thumbnails/` of the bucket, as in production; the environment has no other
 * object there while the suites run (the real queues are paused by the global setup).
 */
describe('StorageCleanerService (integration)', () => {
  const config = storageConfig();
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let cleaner: StorageCleanerService;
  let channel: Channel;
  /** Video ids whose prefixes the test used, rows or not. */
  const touchedVideos = new Set<string>();

  beforeAll(async () => {
    moduleRef = await createModule(0);
    dataSource = moduleRef.get(DataSource);
    cleaner = moduleRef.get(StorageCleanerService);
  });

  afterAll(async () => {
    try {
      await removeTouchedStorage();
      await cleanAllTables(dataSource);
    } finally {
      s3.destroy();
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    channel = await saveTestChannel(dataSource);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await removeTouchedStorage();
  });

  async function removeTouchedStorage(): Promise<void> {
    for (const videoId of touchedVideos) {
      for (const prefix of [
        `originals/${videoId}/`,
        `thumbnails/${videoId}/`,
      ]) {
        for (const upload of await listUploadsUnder(
          s3,
          config.bucket,
          prefix,
        )) {
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
    touchedVideos.clear();
  }

  async function saveVideo(overrides: Partial<Video> = {}): Promise<Video> {
    const video = await dataSource
      .getRepository(Video)
      .save(buildVideo(channel.id, overrides));
    touchedVideos.add(video.id);
    return video;
  }

  async function saveSession(
    video: Video,
    overrides: Partial<UploadSession> = {},
  ): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .save(buildUploadSession(video.id, overrides));
  }

  async function putObject(key: string): Promise<void> {
    touchedVideos.add(key.split('/')[1]);
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: Buffer.from('object of the test'),
      }),
    );
  }

  async function createUpload(key: string): Promise<string> {
    touchedVideos.add(key.split('/')[1]);
    const created = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: config.bucket,
        Key: key,
        ChecksumAlgorithm: 'SHA256',
      }),
    );
    return created.UploadId ?? '';
  }

  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFound') {
        return false;
      }
      throw error;
    }
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

  async function storedKeys(): Promise<string[]> {
    const keys: string[] = [];
    for (const videoId of touchedVideos) {
      for (const prefix of [
        `originals/${videoId}/`,
        `thumbnails/${videoId}/`,
      ]) {
        keys.push(...(await listKeysUnder(s3, config.bucket, prefix)));
      }
    }
    return keys.sort();
  }

  /** A video ready with its completed original and its published thumbnail, both referenced. */
  async function readyVideo(firstBlock?: string) {
    const video = await saveVideo(
      firstBlock ? { id: orderedId(firstBlock) } : {},
    );
    const session = await saveSession(video, {
      status: UploadSessionStatus.COMPLETED,
      upload_id: 'completed-upload',
      claim_token: null,
      claim_expires_at: null,
    });
    const attemptId = randomUUID();
    const thumbnailKey = thumbnailObjectKey(video.id, attemptId);
    await dataSource.getRepository(Video).update(video.id, {
      status: VideoStatus.READY,
      current_upload_session_id: session.id,
      original_key: session.object_key,
      processing_run: 1,
      processing_dispatch: 1,
      current_attempt_id: attemptId,
      thumbnail_key: thumbnailKey,
    });
    await putObject(session.object_key);
    await putObject(thumbnailKey);
    return { video, session, thumbnailKey, attemptId };
  }

  describe('objects that stay', () => {
    it('should never remove the original and the thumbnail referenced by a ready video', async () => {
      const ready = await readyVideo();

      await expect(cleaner.run(BATCH)).resolves.toMatchObject({
        removed: 0,
        failed: 0,
      });

      await expect(objectExists(ready.session.object_key)).resolves.toBe(true);
      await expect(objectExists(ready.thumbnailKey)).resolves.toBe(true);
    });

    it('should keep the key of an aborted session that a video still references as its original', async () => {
      const video = await saveVideo();
      const session = await saveSession(video, {
        status: UploadSessionStatus.ABORTED,
        claim_token: null,
      });
      await dataSource
        .getRepository(Video)
        .update(video.id, { original_key: session.object_key });
      await putObject(session.object_key);

      await cleaner.run(BATCH);

      await expect(objectExists(session.object_key)).resolves.toBe(true);
    });

    it('should keep the multipart of an active session and of a session within its claim', async () => {
      const video = await saveVideo();
      const active = await saveSession(video, {
        status: UploadSessionStatus.ACTIVE,
        claim_token: null,
        claim_expires_at: null,
      });
      const activeUpload = await createUpload(active.object_key);
      await dataSource
        .getRepository(UploadSession)
        .update(active.id, { upload_id: activeUpload });
      const other = await saveVideo();
      const initiating = await saveSession(other);
      const initiatingUpload = await createUpload(initiating.object_key);

      await expect(cleaner.run(BATCH)).resolves.toMatchObject({
        aborted: 0,
        claimed: 0,
      });

      await expect(uploadExists(active.object_key, activeUpload)).resolves.toBe(
        true,
      );
      await expect(
        uploadExists(initiating.object_key, initiatingUpload),
      ).resolves.toBe(true);
      await expect(
        dataSource
          .getRepository(UploadSession)
          .findOneByOrFail({ id: initiating.id }),
      ).resolves.toMatchObject({ status: UploadSessionStatus.INITIATING });
    });

    it('should keep the thumbnails of a video in processing without a current attempt, and of the current attempt', async () => {
      const waiting = await saveVideo({
        status: VideoStatus.PROCESSING,
        processing_run: 1,
        processing_dispatch: 2,
      });
      const revokedKey = thumbnailObjectKey(waiting.id, randomUUID());
      await putObject(revokedKey);
      const current = randomUUID();
      const running = await saveVideo({
        status: VideoStatus.PROCESSING,
        processing_run: 1,
        processing_dispatch: 1,
        current_attempt_id: current,
      });
      const currentKey = thumbnailObjectKey(running.id, current);
      const obsoleteKey = thumbnailObjectKey(running.id, randomUUID());
      await putObject(currentKey);
      await putObject(obsoleteKey);

      await cleaner.run(BATCH);

      await expect(objectExists(revokedKey)).resolves.toBe(true);
      await expect(objectExists(currentKey)).resolves.toBe(true);
      await expect(objectExists(obsoleteKey)).resolves.toBe(false);
    });

    it('should keep every abandoned object younger than STORAGE_CLEANUP_GRACE_MS', async () => {
      const graceful = await createModule(3_600_000);
      try {
        const orphan = originalObjectKey(randomUUID(), randomUUID());
        await putObject(orphan);
        const upload = await createUpload(
          originalObjectKey(randomUUID(), randomUUID()),
        );
        const errored = await saveVideo({ status: VideoStatus.ERROR });
        const thumbnail = thumbnailObjectKey(errored.id, randomUUID());
        await putObject(thumbnail);

        await expect(
          graceful.get(StorageCleanerService).run(BATCH),
        ).resolves.toMatchObject({ removed: 0, aborted: 0, withinGrace: 3 });

        await expect(objectExists(orphan)).resolves.toBe(true);
        await expect(objectExists(thumbnail)).resolves.toBe(true);
        expect(upload).not.toBe('');
      } finally {
        await graceful.close();
      }
    });

    it('should keep a key whose facts changed at the re-read right before the removal', async () => {
      const videoId = randomUUID();
      const sessionId = randomUUID();
      const key = originalObjectKey(videoId, sessionId);
      await putObject(key);
      const facts = moduleRef.get(StorageCleanupRepository);
      const real = facts.originalKeyFacts.bind(
        facts,
      ) as StorageCleanupRepository['originalKeyFacts'];
      jest
        .spyOn(facts, 'originalKeyFacts')
        .mockImplementationOnce((keys) => real(keys))
        .mockImplementationOnce(async (keys) => {
          // Between the listing and the removal, the key gets its session row.
          const video = await saveVideo({ id: videoId });
          await saveSession(video, {
            id: sessionId,
            status: UploadSessionStatus.ACTIVE,
            claim_token: null,
            claim_expires_at: null,
          });
          return real(keys);
        });

      await expect(cleaner.run(BATCH)).resolves.toMatchObject({
        removed: 0,
      });

      await expect(objectExists(key)).resolves.toBe(true);
    });
  });

  describe('objects that go', () => {
    it('should remove the original of an aborted session and of a key without any row', async () => {
      const video = await saveVideo();
      const aborted = await saveSession(video, {
        status: UploadSessionStatus.ABORTED,
        claim_token: null,
      });
      await putObject(aborted.object_key);
      const orphan = originalObjectKey(randomUUID(), randomUUID());
      await putObject(orphan);

      await expect(cleaner.run(BATCH)).resolves.toMatchObject({
        removed: 2,
        failed: 0,
      });

      await expect(objectExists(aborted.object_key)).resolves.toBe(false);
      await expect(objectExists(orphan)).resolves.toBe(false);
    });

    it('should abort a multipart without a session row, and the one of an aborted session', async () => {
      const orphanKey = originalObjectKey(randomUUID(), randomUUID());
      const orphanUpload = await createUpload(orphanKey);
      const video = await saveVideo();
      const aborted = await saveSession(video, {
        status: UploadSessionStatus.ABORTED,
        claim_token: null,
      });
      const abortedUpload = await createUpload(aborted.object_key);

      await expect(cleaner.run(BATCH)).resolves.toMatchObject({
        aborted: 2,
        abortUnconfirmed: 0,
      });

      await expect(uploadExists(orphanKey, orphanUpload)).resolves.toBe(false);
      await expect(
        uploadExists(aborted.object_key, abortedUpload),
      ).resolves.toBe(false);
    });

    it('should take over an initiating session with an expired claim by token, abort its multipart and mark it aborted', async () => {
      const video = await saveVideo();
      const previousToken = randomUUID();
      const initiating = await saveSession(video, {
        claim_token: previousToken,
        claim_expires_at: new Date(Date.now() - 60_000),
      });
      const upload = await createUpload(initiating.object_key);

      await expect(cleaner.run(BATCH)).resolves.toMatchObject({
        claimed: 1,
      });

      await expect(uploadExists(initiating.object_key, upload)).resolves.toBe(
        false,
      );
      await expect(
        dataSource
          .getRepository(UploadSession)
          .findOneByOrFail({ id: initiating.id }),
      ).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTED,
        claim_token: null,
      });
    });

    it('should remove the obsolete thumbnails of a ready video and every thumbnail of a video in error', async () => {
      const ready = await readyVideo();
      const obsolete = thumbnailObjectKey(ready.video.id, randomUUID());
      await putObject(obsolete);
      const errored = await saveVideo({
        status: VideoStatus.ERROR,
        current_attempt_id: randomUUID(),
      });
      const residual = thumbnailObjectKey(
        errored.id,
        errored.current_attempt_id ?? '',
      );
      const other = thumbnailObjectKey(errored.id, randomUUID());
      await putObject(residual);
      await putObject(other);

      await expect(cleaner.run(BATCH)).resolves.toMatchObject({
        removed: 3,
      });

      await expect(objectExists(obsolete)).resolves.toBe(false);
      await expect(objectExists(residual)).resolves.toBe(false);
      await expect(objectExists(other)).resolves.toBe(false);
      await expect(objectExists(ready.thumbnailKey)).resolves.toBe(true);
      await expect(objectExists(ready.session.object_key)).resolves.toBe(true);
    });
  });

  describe('repetition and batches', () => {
    it('should remove nothing more when it runs again', async () => {
      await readyVideo();
      const orphan = originalObjectKey(randomUUID(), randomUUID());
      await putObject(orphan);
      await createUpload(originalObjectKey(randomUUID(), randomUUID()));
      const errored = await saveVideo({ status: VideoStatus.ERROR });
      await putObject(thumbnailObjectKey(errored.id, randomUUID()));

      await expect(cleaner.run(BATCH)).resolves.toMatchObject({
        removed: 2,
        aborted: 1,
      });
      const left = await storedKeys();

      await expect(cleaner.run(BATCH)).resolves.toMatchObject({
        removed: 0,
        aborted: 0,
        claimed: 0,
      });

      expect(await storedKeys()).toEqual(left);
    });

    it('should reach, in later runs, the abandoned keys listed after the ones that stay (batchSize 1)', async () => {
      // Kept keys first in the order of the storage, abandoned ones after them.
      const kept = await readyVideo('00000000');
      const activeVideo = await saveVideo({ id: orderedId('00000001') });
      const active = await saveSession(activeVideo, {
        status: UploadSessionStatus.ACTIVE,
        claim_token: null,
        claim_expires_at: null,
      });
      const activeUpload = await createUpload(active.object_key);
      await dataSource
        .getRepository(UploadSession)
        .update(active.id, { upload_id: activeUpload });
      const orphanObject = originalObjectKey(
        orderedId('ffffffff'),
        randomUUID(),
      );
      await putObject(orphanObject);
      const orphanKey = originalObjectKey(orderedId('fffffffe'), randomUUID());
      const orphanUpload = await createUpload(orphanKey);
      const errored = await saveVideo({
        id: orderedId('fffffffd'),
        status: VideoStatus.ERROR,
      });
      const erroredThumbnail = thumbnailObjectKey(errored.id, randomUUID());
      await putObject(erroredThumbnail);
      let examinedPerRun = 0;

      for (let run = 0; run < 4; run++) {
        const result = await cleaner.run({ batchSize: 1 });
        examinedPerRun = Math.max(examinedPerRun, result.examined);
      }

      await expect(objectExists(orphanObject)).resolves.toBe(false);
      await expect(uploadExists(orphanKey, orphanUpload)).resolves.toBe(false);
      await expect(objectExists(erroredThumbnail)).resolves.toBe(false);
      await expect(objectExists(kept.session.object_key)).resolves.toBe(true);
      await expect(objectExists(kept.thumbnailKey)).resolves.toBe(true);
      await expect(uploadExists(active.object_key, activeUpload)).resolves.toBe(
        true,
      );
      // At most one key of each of the three listings per run.
      expect(examinedPerRun).toBeLessThanOrEqual(3);
    });
  });
});
