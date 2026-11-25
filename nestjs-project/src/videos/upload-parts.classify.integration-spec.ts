import { randomBytes } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
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

/**
 * Small parts keep the real PUTs fast. The storage only enforces the 5 MiB minimum on the
 * Complete, which this suite never calls.
 */
const PART_SIZE = 1_024;

describe('UploadPartsService.classifyParts (integration)', () => {
  const config = storageConfig();
  /** Own client for re-uploads, checks and cleanup, independent of the services under test. */
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let sessionsService: UploadSessionsService;
  let partsService: UploadPartsService;
  let internalClient: S3Client;
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
    })
      .overrideProvider(videoConfig.KEY)
      .useValue({ ...videoConfig(), uploadPartSizeBytes: PART_SIZE })
      .compile();
    dataSource = moduleRef.get(DataSource);
    sessionsService = moduleRef.get(UploadSessionsService);
    partsService = moduleRef.get(UploadPartsService);
    internalClient = moduleRef.get<S3Client>(STORAGE_INTERNAL_CLIENT);
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

  /** A session of `partCount` full parts, created by P1 against the real storage. */
  async function createUpload(partCount: number) {
    const created = await sessionsService.createVideoWithSession(
      channel.user_id,
      {
        fileName: 'classify.mp4',
        sizeBytes: partCount * PART_SIZE,
        contentType: 'video/mp4',
      },
    );
    const session = await dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: created.uploadSession.id });
    const partUrls = (
      body: Parameters<UploadPartsService['requestPartUrls']>[3],
    ) =>
      partsService.requestPartUrls(
        channel.user_id,
        created.publicId,
        session.id,
        body,
      );

    /** Signs the part and sends it through its signed URL; returns the ETag of the PUT. */
    async function sendPart(partNumber: number, body: Buffer): Promise<string> {
      const {
        parts: [signed],
      } = await partUrls({
        parts: [{ partNumber, checksumSha256: sha256Base64(body) }],
      });
      const put = await requestPresignedUrl(signed.url, {
        method: signed.method,
        headers: { ...signed.headers },
        body,
      });
      expect(put.status).toBe(200);
      return put.headers.etag as string;
    }

    return { session, partUrls, sendPart };
  }

  it('should classify a re-sent part as divergent and a part sent without registry as unregistered (T-07)', async () => {
    const upload = await createUpload(5);
    const bodies = [1, 2, 3, 4].map(() => randomBytes(PART_SIZE));

    const etag1 = await upload.sendPart(1, bodies[0]);
    await upload.sendPart(2, bodies[1]);
    const etag3 = await upload.sendPart(3, bodies[2]);
    await upload.partUrls({
      completedParts: [
        { partNumber: 1, etag: etag1 },
        { partNumber: 3, etag: etag3 },
      ],
    });
    // Part 4 is signed but never sent; part 5 is never signed.
    const checksum4 = sha256Base64(bodies[3]);
    await upload.partUrls({
      parts: [{ partNumber: 4, checksumSha256: checksum4 }],
    });
    // Part 3 is overwritten after its registry, on the same upload, as a concurrent write would.
    const other = randomBytes(PART_SIZE);
    await s3.send(
      new UploadPartCommand({
        Bucket: config.bucket,
        Key: upload.session.object_key,
        UploadId: upload.session.upload_id ?? '',
        PartNumber: 3,
        Body: other,
        ContentLength: other.length,
        ChecksumSHA256: sha256Base64(other),
      }),
    );

    const result = await partsService.classifyParts(upload.session);

    expect(result).toEqual({
      status: 'found',
      parts: [
        {
          partNumber: 1,
          state: UploadPartState.CONFIRMED,
          checksumSha256: sha256Base64(bodies[0]),
          etag: etag1,
        },
        {
          partNumber: 2,
          state: UploadPartState.UNREGISTERED,
          checksumSha256: sha256Base64(bodies[1]),
          etag: null,
        },
        {
          partNumber: 3,
          state: UploadPartState.DIVERGENT,
          checksumSha256: sha256Base64(bodies[2]),
          etag: etag3,
        },
        {
          partNumber: 4,
          state: UploadPartState.MISSING,
          checksumSha256: checksum4,
          etag: null,
        },
        {
          partNumber: 5,
          state: UploadPartState.MISSING,
          checksumSha256: null,
          etag: null,
        },
      ],
      extraPartNumbers: [],
    });
  });

  it('should walk every page of ListParts with a small page and classify the parts of the last page', async () => {
    const upload = await createUpload(5);
    const etags: { partNumber: number; etag: string }[] = [];
    for (const partNumber of [1, 2, 3, 4, 5]) {
      etags.push({
        partNumber,
        etag: await upload.sendPart(partNumber, randomBytes(PART_SIZE)),
      });
    }
    // Part 5, alone on the third page, is the only one without a registered ETag.
    await upload.partUrls({ completedParts: etags.slice(0, 4) });
    const send = jest.spyOn(internalClient, 'send');

    const result = await partsService.classifyParts(upload.session, {
      pageSize: 2,
    });

    const listPartsCalls = send.mock.calls.filter(
      ([command]) => command instanceof ListPartsCommand,
    );
    expect(listPartsCalls).toHaveLength(3);
    expect(result).toMatchObject({
      status: 'found',
      parts: [
        { partNumber: 1, state: UploadPartState.CONFIRMED },
        { partNumber: 2, state: UploadPartState.CONFIRMED },
        { partNumber: 3, state: UploadPartState.CONFIRMED },
        { partNumber: 4, state: UploadPartState.CONFIRMED },
        { partNumber: 5, state: UploadPartState.UNREGISTERED },
      ],
    });
  });

  it('should report no-such-upload for an upload removed from the storage', async () => {
    const upload = await createUpload(1);
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: config.bucket,
        Key: upload.session.object_key,
        UploadId: upload.session.upload_id ?? '',
      }),
    );

    await expect(partsService.classifyParts(upload.session)).resolves.toEqual({
      status: 'no-such-upload',
      uploadId: upload.session.upload_id,
    });
  });
});
