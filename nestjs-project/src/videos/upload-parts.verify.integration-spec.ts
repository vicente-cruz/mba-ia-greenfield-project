import { randomBytes } from 'node:crypto';
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
import { Video } from './entities/video.entity';
import {
  UploadFileMismatchException,
  UploadSessionExpiredException,
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

/** Small parts keep the real PUTs fast; the storage only enforces 5 MiB on the Complete. */
const PART_SIZE = 1_024;
/** File A: two full parts and a last one of 500 bytes. */
const FILE_SIZE = 2 * PART_SIZE + 500;

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

/** The bytes of part `partNumber` (from 1) of `file`. */
function partOf(file: Buffer, partNumber: number): Buffer {
  return file.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE);
}

describe('UploadPartsService.verifyFile (integration)', () => {
  const config = storageConfig();
  /** Own client for the storage changes and the cleanup, independent of the services under test. */
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let sessionsService: UploadSessionsService;
  let partsService: UploadPartsService;
  let channel: Channel;
  let fileA: Buffer;

  beforeAll(async () => {
    moduleRef = await createModule();
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
    fileA = randomBytes(FILE_SIZE);
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

  /** The session of file A, created by P1 against the real storage. */
  async function createUpload() {
    const created = await sessionsService.createVideoWithSession(
      channel.user_id,
      { fileName: 'a.mp4', sizeBytes: FILE_SIZE, contentType: 'video/mp4' },
    );
    const sessionId = created.uploadSession.id;
    const partUrls = (
      body: Parameters<UploadPartsService['requestPartUrls']>[3],
    ) =>
      partsService.requestPartUrls(
        channel.user_id,
        created.publicId,
        sessionId,
        body,
      );
    const verify = (file: Buffer, partNumbers: number[]) =>
      partsService.verifyFile(
        channel.user_id,
        created.publicId,
        sessionId,
        partNumbers.map((partNumber) => ({
          partNumber,
          checksumSha256: sha256Base64(partOf(file, partNumber)),
        })),
      );

    /** Signs the parts of A, sends them through their signed URLs and returns their ETags. */
    async function sendParts(partNumbers: number[]): Promise<string[]> {
      const { parts } = await partUrls({
        parts: partNumbers.map((partNumber) => ({
          partNumber,
          checksumSha256: sha256Base64(partOf(fileA, partNumber)),
        })),
      });
      const etags: string[] = [];
      for (const signed of parts) {
        const put = await requestPresignedUrl(signed.url, {
          method: signed.method,
          headers: { ...signed.headers },
          body: partOf(fileA, signed.partNumber),
        });
        expect(put.status).toBe(200);
        etags.push(put.headers.etag as string);
      }
      return etags;
    }

    /** Sends and registers the parts of A, as the client does after each PUT. */
    async function sendAndRegister(partNumbers: number[]): Promise<void> {
      const etags = await sendParts(partNumbers);
      await partUrls({
        completedParts: partNumbers.map((partNumber, index) => ({
          partNumber,
          etag: etags[index],
        })),
      });
    }

    return {
      created,
      sessionId,
      publicId: created.publicId,
      partUrls,
      verify,
      sendParts,
      sendAndRegister,
    };
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  async function storedChecksums(sessionId: string): Promise<string[]> {
    const parts = await dataSource.getRepository(UploadPart).find({
      where: { upload_session_id: sessionId },
      order: { part_number: 'ASC' },
    });
    return parts.map((part) => part.checksum_sha256);
  }

  /** File A' is file A with 1 byte changed inside part 1. */
  function withOneByteChanged(file: Buffer): Buffer {
    const changed = Buffer.from(file);
    changed[100] = changed[100] ^ 0xff;
    return changed;
  }

  it('should block the session for a file with 1 byte changed in a confirmed part and refuse to sign new parts (F-11, G-11)', async () => {
    const upload = await createUpload();
    await upload.sendAndRegister([1, 2]);
    const fileA2 = withOneByteChanged(fileA);

    await expect(upload.verify(fileA2, [1, 2])).rejects.toBeInstanceOf(
      UploadFileMismatchException,
    );

    // Read on a fresh query: the block was committed despite the error answer.
    const session = await storedSession(upload.sessionId);
    expect(session.file_mismatch_at).toBeInstanceOf(Date);
    expect(session.status).toBe(UploadSessionStatus.ACTIVE);
    await expect(storedChecksums(upload.sessionId)).resolves.toEqual([
      sha256Base64(partOf(fileA, 1)),
      sha256Base64(partOf(fileA, 2)),
    ]);
    await expect(
      upload.partUrls({
        parts: [
          { partNumber: 3, checksumSha256: sha256Base64(partOf(fileA2, 3)) },
        ],
      }),
    ).rejects.toBeInstanceOf(UploadFileMismatchException);
    await expect(
      dataSource
        .getRepository(UploadPart)
        .countBy({ upload_session_id: upload.sessionId }),
    ).resolves.toBe(2);
  });

  it('should keep the block when a later verification carries the original file', async () => {
    const upload = await createUpload();
    await upload.sendAndRegister([1, 2]);
    await expect(
      upload.verify(withOneByteChanged(fileA), [1, 2]),
    ).rejects.toBeInstanceOf(UploadFileMismatchException);
    const blockedAt = (await storedSession(upload.sessionId)).file_mismatch_at;

    await expect(upload.verify(fileA, [1, 2])).rejects.toBeInstanceOf(
      UploadFileMismatchException,
    );

    const session = await storedSession(upload.sessionId);
    expect(session.file_mismatch_at).toEqual(blockedAt);
  });

  it('should match the same file, covering the confirmed, unregistered and signed missing parts', async () => {
    const upload = await createUpload();
    await upload.sendAndRegister([1]);
    await upload.sendParts([2]);
    // Part 3 is signed, so its checksum is registered, but never sent.
    await upload.partUrls({
      parts: [
        { partNumber: 3, checksumSha256: sha256Base64(partOf(fileA, 3)) },
      ],
    });

    await expect(upload.verify(fileA, [1, 2])).resolves.toEqual({
      result: 'match',
      verifiedParts: 2,
    });
    await expect(upload.verify(fileA, [1, 2, 3])).resolves.toEqual({
      result: 'match',
      verifiedParts: 3,
    });
    expect((await storedSession(upload.sessionId)).file_mismatch_at).toBeNull();
  });

  it('should answer STORAGE_UNAVAILABLE and record nothing when the storage cannot be reached', async () => {
    const upload = await createUpload();
    await upload.sendAndRegister([1]);
    const before = await storedSession(upload.sessionId);
    const unreachable = await createModule('http://storage:1');

    try {
      await expect(
        unreachable
          .get(UploadPartsService)
          .verifyFile(channel.user_id, upload.publicId, upload.sessionId, [
            {
              partNumber: 1,
              checksumSha256: sha256Base64(
                partOf(withOneByteChanged(fileA), 1),
              ),
            },
          ]),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    } finally {
      await unreachable.close();
    }

    await expect(storedSession(upload.sessionId)).resolves.toEqual(before);
  });

  it('should answer UPLOAD_SESSION_EXPIRED, recording nothing, when the storage no longer knows the upload', async () => {
    const upload = await createUpload();
    await upload.sendAndRegister([1]);
    const session = await storedSession(upload.sessionId);
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: config.bucket,
        Key: session.object_key,
        UploadId: session.upload_id ?? '',
      }),
    );

    await expect(upload.verify(fileA, [1])).rejects.toBeInstanceOf(
      UploadSessionExpiredException,
    );

    await expect(storedSession(upload.sessionId)).resolves.toEqual(session);
  });
});
