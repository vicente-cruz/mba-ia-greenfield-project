import { randomBytes, randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request, { type Test as SupertestRequest } from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresignedUrl, sha256Base64 } from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import { UploadSession } from '../src/videos/entities/upload-session.entity';
import { Video } from '../src/videos/entities/video.entity';
import { registerConfirmedUser } from './helpers/auth';
import { VideoQueuesControl } from './helpers/queues';
import {
  errorBody,
  partUrlsBody,
  uploadSessionBody,
  videoUploadSessionBody,
} from './helpers/response-bodies';
import {
  closeVideoFixtureContext,
  createVideoFixtureContext,
  removeVideoStorage,
  seedProcessingVideo,
  type VideoFixtureContext,
} from './helpers/video-fixtures';

jest.setTimeout(60_000);

/** 5 MiB, the minimum part of the S3, so each file has few parts (TD-15). */
const PART_SIZE = 5_242_880;
const PART_SIZE_ENV = 'UPLOAD_PART_SIZE_BYTES';

describe('GET /videos/:publicId/upload-sessions/:sessionId (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queues: VideoQueuesControl;
  let fixtures: VideoFixtureContext;
  let ownerEmail: string;
  let ownerToken: string;
  let otherToken: string;
  let userCounter = 0;
  /** Value of UPLOAD_PART_SIZE_BYTES before the suite, restored in `afterAll`. */
  let previousPartSize: string | undefined;

  beforeAll(async () => {
    previousPartSize = process.env[PART_SIZE_ENV];
    // Read by the `video` namespace when the application module is compiled.
    process.env[PART_SIZE_ENV] = String(PART_SIZE);

    queues = new VideoQueuesControl();
    await queues.pauseAll();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    fixtures = createVideoFixtureContext(dataSource);
  });

  afterAll(async () => {
    try {
      await removeStorageOfAllVideos();
      await cleanAllTables(dataSource);
    } finally {
      try {
        await queues.restore();
      } finally {
        closeVideoFixtureContext(fixtures);
        await app.close();
        if (previousPartSize === undefined) {
          delete process.env[PART_SIZE_ENV];
        } else {
          process.env[PART_SIZE_ENV] = previousPartSize;
        }
      }
    }
  });

  beforeEach(async () => {
    // The queues are paused and idle before any data is removed.
    await queues.prepareScenario();
    await removeStorageOfAllVideos();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const run = `${process.pid}_${++userCounter}`;
    ownerEmail = `session_get_owner_${run}@example.com`;
    ownerToken = await registerConfirmedUser(app, ownerEmail);
    otherToken = await registerConfirmedUser(
      app,
      `session_get_other_${run}@example.com`,
    );
  });

  async function removeStorageOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
      await removeVideoStorage(fixtures, video.id);
    }
  }

  async function createVideo(
    partCount: number,
  ): Promise<{ publicId: string; sessionId: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        fileName: 'video.mp4',
        sizeBytes: partCount * PART_SIZE,
        contentType: 'video/mp4',
      })
      .expect(201);
    const body = videoUploadSessionBody(res);
    expect(body.uploadSession.partSize).toBe(PART_SIZE);
    expect(body.uploadSession.partCount).toBe(partCount);
    return { publicId: body.publicId, sessionId: body.uploadSession.id };
  }

  function getSession(
    video: { publicId: string; sessionId: string },
    token: string = ownerToken,
  ): SupertestRequest {
    return request(app.getHttpServer())
      .get(`/videos/${video.publicId}/upload-sessions/${video.sessionId}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function postPartUrls(
    video: { publicId: string; sessionId: string },
    body: object,
  ): SupertestRequest {
    return request(app.getHttpServer())
      .post(
        `/videos/${video.publicId}/upload-sessions/${video.sessionId}/part-urls`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body);
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  describe('1. Classificação das partes', () => {
    it('1.1 sessao-sem-partes-enviadas-tem-todas-missing', async () => {
      const video = await createVideo(3);

      const res = await getSession(video).expect(200);

      const body = uploadSessionBody(res);
      expect(body).toMatchObject({
        id: video.sessionId,
        status: 'active',
        expired: false,
        fileMismatch: false,
        partSize: PART_SIZE,
        partCount: 3,
        checksumAlgorithm: 'SHA256',
      });
      expect(body.parts).toEqual(
        [1, 2, 3].map((partNumber) => ({
          partNumber,
          state: 'missing',
          checksumSha256: null,
          etag: null,
        })),
      );
    });

    it('1.2 partes-confirmed-unregistered-e-divergent', async () => {
      const video = await createVideo(3);
      const bodies = [1, 2, 3].map(() => randomBytes(PART_SIZE));
      const checksums = bodies.map((body) => sha256Base64(body));
      const signed = partUrlsBody(
        await postPartUrls(video, {
          parts: checksums.map((checksumSha256, index) => ({
            partNumber: index + 1,
            checksumSha256,
          })),
        }).expect(200),
      ).parts;
      const etags: string[] = [];
      for (const [index, part] of signed.entries()) {
        expect(part.expectedSize).toBe(PART_SIZE);
        const put = await requestPresignedUrl(part.url, {
          method: part.method,
          headers: part.headers,
          body: bodies[index],
        });
        expect(put.status).toBe(200);
        etags.push(put.headers.etag as string);
      }
      await postPartUrls(video, {
        completedParts: [
          { partNumber: 1, etag: etags[0] },
          { partNumber: 3, etag: etags[2] },
        ],
      }).expect(200);
      // Part 3 written again with other content on the same upload, by the internal client.
      const session = await storedSession(video.sessionId);
      const other = randomBytes(PART_SIZE);
      await fixtures.s3.send(
        new UploadPartCommand({
          Bucket: fixtures.bucket,
          Key: session.object_key,
          UploadId: session.upload_id ?? '',
          PartNumber: 3,
          Body: other,
          ContentLength: other.length,
          ChecksumSHA256: sha256Base64(other),
        }),
      );

      const res = await getSession(video).expect(200);

      expect(uploadSessionBody(res).parts).toEqual([
        {
          partNumber: 1,
          state: 'confirmed',
          checksumSha256: checksums[0],
          etag: etags[0],
        },
        {
          partNumber: 2,
          state: 'unregistered',
          checksumSha256: checksums[1],
          etag: null,
        },
        {
          partNumber: 3,
          state: 'divergent',
          checksumSha256: checksums[2],
          etag: etags[2],
        },
      ]);
    });

    it('1.3 sessao-concluida-devolve-partes-vazias', async () => {
      const owner = await dataSource
        .getRepository(User)
        .findOneByOrFail({ email: ownerEmail });
      const channel = await dataSource
        .getRepository(Channel)
        .findOneByOrFail({ user_id: owner.id });
      const { video, session } = await seedProcessingVideo(fixtures, {
        channelId: channel.id,
        original: randomBytes(4_096),
      });
      expect(video).toMatchObject({
        status: 'processing',
        processing_run: 1,
        processing_dispatch: 1,
        original_key: session.object_key,
        current_upload_session_id: session.id,
      });

      const res = await getSession({
        publicId: video.public_id,
        sessionId: session.id,
      }).expect(200);

      expect(uploadSessionBody(res)).toMatchObject({
        id: session.id,
        status: 'completed',
        expired: false,
        parts: [],
      });
    });

    it('1.4 upload-desconhecido-pelo-storage-retorna-410', async () => {
      const video = await createVideo(1);
      const session = await storedSession(video.sessionId);
      await fixtures.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: fixtures.bucket,
          Key: session.object_key,
          UploadId: session.upload_id ?? '',
        }),
      );

      const res = await getSession(video).expect(410);

      expect(errorBody(res).error).toBe('UPLOAD_SESSION_EXPIRED');
      await expect(storedSession(video.sessionId)).resolves.toMatchObject({
        status: 'aborted',
      });
      await expect(
        dataSource
          .getRepository(Video)
          .findOneByOrFail({ id: session.video_id }),
      ).resolves.toMatchObject({ status: 'draft' });
    });
  });

  describe('2. Autorização', () => {
    it('2.1 usuario-que-nao-e-dono-recebe-404', async () => {
      const video = await createVideo(1);

      const foreign = await getSession(video, otherToken).expect(404);
      expect(errorBody(foreign).error).toBe('VIDEO_NOT_FOUND');

      const missing = await getSession({
        publicId: video.publicId,
        sessionId: randomUUID(),
      }).expect(404);
      expect(errorBody(missing).error).toBe('UPLOAD_SESSION_NOT_FOUND');
    });
  });
});
