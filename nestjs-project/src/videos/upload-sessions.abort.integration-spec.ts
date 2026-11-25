import { randomBytes, randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
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
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { gate } from '../test/locks';
import {
  listUploadsUnder,
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
import { UploadSessionCompletingException } from './exceptions/video.exceptions';
import { UploadPartsRepository } from './upload-parts.repository';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import { UploadSessionsService } from './upload-sessions.service';
import { VideoLockService } from './video-lock.service';

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

/** One part of 3 KiB. */
const FILE_SIZE = 3_072;

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

describe('UploadSessionsService.abortSession (integration)', () => {
  const config = storageConfig();
  /** Own client for checks and cleanup, independent of the services under test. */
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: UploadSessionsService;
  let partsService: UploadPartsService;
  let storage: StorageService;
  let repository: UploadSessionsRepository;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await createModule();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(UploadSessionsService);
    partsService = moduleRef.get(UploadPartsService);
    storage = moduleRef.get(StorageService);
    repository = moduleRef.get(UploadSessionsRepository);
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
      fileName: 'abort.mp4',
      sizeBytes: FILE_SIZE,
      contentType: 'video/mp4',
    });
    const session = await storedSession(created.uploadSession.id);
    return {
      session,
      publicId: created.publicId,
      abort: (target: UploadSessionsService = service) =>
        target.abortSession(channel.user_id, created.publicId, session.id),
      /** Signs part 1 for `body` and returns the URL, without sending it. */
      sign: async (body: Buffer) => {
        const {
          parts: [signed],
        } = await partsService.requestPartUrls(
          channel.user_id,
          created.publicId,
          session.id,
          { parts: [{ partNumber: 1, checksumSha256: sha256Base64(body) }] },
        );
        return signed;
      },
    };
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  /** Whether the storage still knows the upload, by `ListParts` on an independent client. */
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

  async function expireClaim(sessionId: string): Promise<void> {
    await dataSource.query(
      `UPDATE upload_sessions SET claim_expires_at = now() - interval '1 second' WHERE id = $1`,
      [sessionId],
    );
  }

  it('should end aborted only after NoSuchUpload, and a part sent later through a URL already signed is refused (T-05)', async () => {
    const upload = await createUpload();
    const body = randomBytes(FILE_SIZE);
    const signed = await upload.sign(body);
    const listParts = jest.spyOn(storage, 'listParts');
    const markAborted = jest.spyOn(repository, 'markAborted');

    await expect(upload.abort()).resolves.toBeUndefined();

    await expect(listParts.mock.results[0].value).resolves.toEqual({
      status: 'no-such-upload',
    });
    expect(listParts.mock.invocationCallOrder[0]).toBeLessThan(
      markAborted.mock.invocationCallOrder[0],
    );
    await expect(storedSession(upload.session.id)).resolves.toMatchObject({
      status: UploadSessionStatus.ABORTED,
      claim_token: null,
      claim_expires_at: null,
    });
    const put = await requestPresignedUrl(signed.url, {
      method: signed.method,
      headers: { ...signed.headers },
      body,
    });
    expect(put.status).toBe(404);
    expect(put.body.toString()).toContain('NoSuchUpload');
    await expect(
      uploadExists(upload.session.object_key, upload.session.upload_id ?? ''),
    ).resolves.toBe(false);
    await expect(
      dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: upload.session.video_id }),
    ).resolves.toMatchObject({
      status: VideoStatus.DRAFT,
      current_upload_session_id: upload.session.id,
    });
  });

  it('should not let an operation that lost its token overwrite the operation that took the session over', async () => {
    const upload = await createUpload();
    const arrivals = [gate(), gate()];
    const releases = [gate(), gate()];
    let calls = 0;
    jest
      .spyOn(storage, 'abortMultipartUpload')
      .mockImplementation(async (key, uploadId) => {
        const index = calls++;
        if (index < 2) {
          arrivals[index].open();
          await releases[index].opened;
        }
        return StorageService.prototype.abortMultipartUpload.call(
          storage,
          key,
          uploadId,
        ) as ReturnType<StorageService['abortMultipartUpload']>;
      });
    const markAborted = jest.spyOn(repository, 'markAborted');

    const first = upload.abort();
    let second: Promise<void> | undefined;
    try {
      await arrivals[0].opened;
      const tokenOfFirst = (await storedSession(upload.session.id)).claim_token;
      await expireClaim(upload.session.id);
      second = upload.abort();
      await arrivals[1].opened;
      const tokenOfSecond = (await storedSession(upload.session.id))
        .claim_token;
      expect(tokenOfSecond).not.toBe(tokenOfFirst);

      // The first one confirms NoSuchUpload, but its token is gone: zero rows, nothing written.
      releases[0].open();
      await first;
      await expect(markAborted.mock.results[0].value).resolves.toBe(false);
      await expect(storedSession(upload.session.id)).resolves.toMatchObject({
        status: UploadSessionStatus.ABORTING,
        claim_token: tokenOfSecond,
      });

      releases[1].open();
      await second;
    } finally {
      releases.forEach((release) => release.open());
      await Promise.allSettled([first, second]);
    }

    await expect(storedSession(upload.session.id)).resolves.toMatchObject({
      status: UploadSessionStatus.ABORTED,
      claim_token: null,
    });
  });

  it('should find and abort the multipart of a session without upload_id at its own key, leaving other uploads alone', async () => {
    const other = await createUpload();
    const upload = await createUpload();
    const uploadId = upload.session.upload_id ?? '';
    // A session whose creator died after CreateMultipartUpload and before T2 (P1).
    await dataSource.query(
      `UPDATE upload_sessions
          SET status = 'initiating', upload_id = NULL, claim_token = $2,
              claim_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [upload.session.id, randomUUID()],
    );

    await expect(upload.abort()).resolves.toBeUndefined();

    await expect(storedSession(upload.session.id)).resolves.toMatchObject({
      status: UploadSessionStatus.ABORTED,
      claim_token: null,
    });
    await expect(
      uploadExists(upload.session.object_key, uploadId),
    ).resolves.toBe(false);
    await expect(
      uploadExists(other.session.object_key, other.session.upload_id ?? ''),
    ).resolves.toBe(true);
  });

  it('should keep the session aborting with its claim for the sweep when a part in transit keeps the upload listed (F-09)', async () => {
    const upload = await createUpload();
    jest
      .spyOn(storage, 'listParts')
      .mockResolvedValue({ status: 'found', parts: [] });

    await expect(upload.abort()).resolves.toBeUndefined();

    const left = await storedSession(upload.session.id);
    expect(left.status).toBe(UploadSessionStatus.ABORTING);
    expect(left.claim_token).toEqual(expect.any(String));

    // Once the claim expires, the next abort takes it over and confirms the absence.
    jest.restoreAllMocks();
    await expireClaim(upload.session.id);
    await expect(upload.abort()).resolves.toBeUndefined();
    await expect(storedSession(upload.session.id)).resolves.toMatchObject({
      status: UploadSessionStatus.ABORTED,
      claim_token: null,
    });
  });

  it('should keep the session aborting and the multipart open when the storage cannot be reached', async () => {
    const upload = await createUpload();
    const unreachable = await createModule('http://storage:1');

    try {
      await expect(
        upload.abort(unreachable.get(UploadSessionsService)),
      ).resolves.toBeUndefined();
    } finally {
      await unreachable.close();
    }

    const left = await storedSession(upload.session.id);
    expect(left.status).toBe(UploadSessionStatus.ABORTING);
    expect(left.claim_token).toEqual(expect.any(String));
    await expect(
      uploadExists(upload.session.object_key, upload.session.upload_id ?? ''),
    ).resolves.toBe(true);
  });

  it('should refuse a completing session even with its claim expired, leaving it and its multipart as they are', async () => {
    const upload = await createUpload();
    const token = randomUUID();
    await dataSource.query(
      `UPDATE upload_sessions
          SET status = 'completing', claim_token = $2,
              claim_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [upload.session.id, token],
    );

    await expect(upload.abort()).rejects.toBeInstanceOf(
      UploadSessionCompletingException,
    );

    await expect(storedSession(upload.session.id)).resolves.toMatchObject({
      status: UploadSessionStatus.COMPLETING,
      claim_token: token,
    });
    await expect(
      uploadExists(upload.session.object_key, upload.session.upload_id ?? ''),
    ).resolves.toBe(true);
  });

  it('should leave an aborting session within the claim of another operation untouched', async () => {
    const upload = await createUpload();
    const token = randomUUID();
    await dataSource.query(
      `UPDATE upload_sessions
          SET status = 'aborting', claim_token = $2,
              claim_expires_at = now() + interval '5 minutes'
        WHERE id = $1`,
      [upload.session.id, token],
    );
    const before = await storedSession(upload.session.id);

    await expect(upload.abort()).resolves.toBeUndefined();

    await expect(storedSession(upload.session.id)).resolves.toEqual(before);
    await expect(
      uploadExists(upload.session.object_key, upload.session.upload_id ?? ''),
    ).resolves.toBe(true);
  });
});
