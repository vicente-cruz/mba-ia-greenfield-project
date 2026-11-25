import { randomBytes } from 'node:crypto';
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
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  listUploadsUnder,
  requestPresignedUrl,
  sha256Base64,
} from '../test/storage';
import { saveTestChannel } from '../test/video-entity-fixtures';
import { User } from '../users/entities/user.entity';
import { UploadPart } from './entities/upload-part.entity';
import { UploadSession } from './entities/upload-session.entity';
import { Video } from './entities/video.entity';
import {
  UploadFileMismatchException,
  UploadPartNotSignedException,
} from './exceptions/video.exceptions';
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

/** Small files: one part each, as the regular suites use (SI-03.9). */
const FILE_SIZE = 3 * 1024;

describe('UploadPartsService (integration)', () => {
  const config = storageConfig();
  /** Own client for checks and cleanup, independent of the services under test. */
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let sessionsService: UploadSessionsService;
  let partsService: UploadPartsService;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
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
    }).compile();
    dataSource = moduleRef.get(DataSource);
    sessionsService = moduleRef.get(UploadSessionsService);
    partsService = moduleRef.get(UploadPartsService);
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

  async function createUpload(sizeBytes = FILE_SIZE) {
    const created = await sessionsService.createVideoWithSession(
      channel.user_id,
      { fileName: 'parts.mp4', sizeBytes, contentType: 'video/mp4' },
    );
    return {
      publicId: created.publicId,
      sessionId: created.uploadSession.id,
      partUrls: (body: Parameters<UploadPartsService['requestPartUrls']>[3]) =>
        partsService.requestPartUrls(
          channel.user_id,
          created.publicId,
          created.uploadSession.id,
          body,
        ),
    };
  }

  async function storedPart(
    sessionId: string,
    partNumber: number,
  ): Promise<UploadPart | null> {
    return dataSource
      .getRepository(UploadPart)
      .findOneBy({ upload_session_id: sessionId, part_number: partNumber });
  }

  it('should accept a real PUT with expectedSize bytes and the returned header, and keep the reported ETag', async () => {
    const upload = await createUpload();
    const body = randomBytes(FILE_SIZE);
    const checksum = sha256Base64(body);

    const {
      parts: [signed],
    } = await upload.partUrls({
      parts: [{ partNumber: 1, checksumSha256: checksum }],
    });

    expect(signed.expectedSize).toBe(FILE_SIZE);
    expect(Object.keys(signed.headers)).toEqual(['x-amz-checksum-sha256']);
    const url = new URL(signed.url);
    expect(url.origin).toBe(new URL(config.publicEndpoint).origin);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;host;x-amz-checksum-sha256',
    );

    const put = await requestPresignedUrl(signed.url, {
      method: signed.method,
      headers: { ...signed.headers },
      body,
    });
    expect(put.status).toBe(200);
    const etag = put.headers.etag;
    expect(etag).toEqual(expect.any(String));

    await expect(
      upload.partUrls({
        completedParts: [{ partNumber: 1, etag: etag as string }],
      }),
    ).resolves.toEqual({ parts: [], registeredParts: [1] });

    const registered = await storedPart(upload.sessionId, 1);
    expect(registered).toMatchObject({
      expected_size: FILE_SIZE,
      checksum_sha256: checksum,
      etag,
    });
    expect(registered?.etag_registered_at).toBeInstanceOf(Date);
    const session = await dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: upload.sessionId });
    const listed = await s3.send(
      new ListPartsCommand({
        Bucket: config.bucket,
        Key: session.object_key,
        UploadId: session.upload_id ?? '',
      }),
    );
    expect(listed.Parts).toEqual([
      expect.objectContaining({
        PartNumber: 1,
        ETag: etag,
        ChecksumSHA256: checksum,
        Size: FILE_SIZE,
      }),
    ]);
  });

  it('should keep content-length signed: a body of another size is refused', async () => {
    const upload = await createUpload();
    const body = randomBytes(FILE_SIZE + 1);

    const {
      parts: [signed],
    } = await upload.partUrls({
      parts: [{ partNumber: 1, checksumSha256: sha256Base64(body) }],
    });
    const put = await requestPresignedUrl(signed.url, {
      method: 'PUT',
      headers: { ...signed.headers },
      body,
    });

    expect(put.status).toBe(403);
  });

  describe('checksum registered once', () => {
    it('should register one checksum when two requests race with different checksums for the same part', async () => {
      const upload = await createUpload();
      const checksumA = sha256Base64(randomBytes(FILE_SIZE));
      const checksumB = sha256Base64(randomBytes(FILE_SIZE));

      const results = await Promise.allSettled([
        upload.partUrls({
          parts: [{ partNumber: 1, checksumSha256: checksumA }],
        }),
        upload.partUrls({
          parts: [{ partNumber: 1, checksumSha256: checksumB }],
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(UploadFileMismatchException);
      const winner = results[0].status === 'fulfilled' ? checksumA : checksumB;
      await expect(
        dataSource
          .getRepository(UploadPart)
          .countBy({ upload_session_id: upload.sessionId }),
      ).resolves.toBe(1);
      expect((await storedPart(upload.sessionId, 1))?.checksum_sha256).toBe(
        winner,
      );
      const session = await dataSource
        .getRepository(UploadSession)
        .findOneByOrFail({ id: upload.sessionId });
      expect(session.file_mismatch_at).toBeInstanceOf(Date);
    });

    it('should accept concurrent signatures with the same checksum and keep one row', async () => {
      const upload = await createUpload();
      const checksum = sha256Base64(randomBytes(FILE_SIZE));

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          upload.partUrls({
            parts: [{ partNumber: 1, checksumSha256: checksum }],
          }),
        ),
      );

      expect(results.every((r) => r.parts[0].partNumber === 1)).toBe(true);
      await expect(
        dataSource
          .getRepository(UploadPart)
          .countBy({ upload_session_id: upload.sessionId }),
      ).resolves.toBe(1);
      const session = await dataSource
        .getRepository(UploadSession)
        .findOneByOrFail({ id: upload.sessionId });
      expect(session.file_mismatch_at).toBeNull();
    });

    it('should keep the original checksum and the recorded block after the 409', async () => {
      const upload = await createUpload(134_217_728);
      const checksumA = sha256Base64(randomBytes(64));
      const checksumB = sha256Base64(randomBytes(64));
      await upload.partUrls({
        parts: [{ partNumber: 2, checksumSha256: checksumA }],
      });

      await expect(
        upload.partUrls({
          parts: [{ partNumber: 2, checksumSha256: checksumB }],
        }),
      ).rejects.toBeInstanceOf(UploadFileMismatchException);

      // Read on a fresh query: the block was committed despite the error answer.
      const session = await dataSource
        .getRepository(UploadSession)
        .findOneByOrFail({ id: upload.sessionId });
      expect(session.file_mismatch_at).toBeInstanceOf(Date);
      expect((await storedPart(upload.sessionId, 2))?.checksum_sha256).toBe(
        checksumA,
      );
      await expect(
        upload.partUrls({
          parts: [{ partNumber: 1, checksumSha256: checksumB }],
        }),
      ).rejects.toBeInstanceOf(UploadFileMismatchException);
      await expect(storedPart(upload.sessionId, 1)).resolves.toBeNull();
    });
  });

  it('should record no ETag of a batch that reports a part never signed', async () => {
    const upload = await createUpload(134_217_728);
    await upload.partUrls({
      parts: [{ partNumber: 1, checksumSha256: sha256Base64(randomBytes(64)) }],
    });

    await expect(
      upload.partUrls({
        completedParts: [
          { partNumber: 1, etag: '"one"' },
          { partNumber: 2, etag: '"two"' },
        ],
      }),
    ).rejects.toBeInstanceOf(UploadPartNotSignedException);

    expect((await storedPart(upload.sessionId, 1))?.etag).toBeNull();
  });
});
