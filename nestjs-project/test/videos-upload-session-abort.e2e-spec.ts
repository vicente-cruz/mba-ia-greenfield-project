import { randomBytes } from 'node:crypto';
import { ListPartsCommand } from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request, { type Test as SupertestRequest } from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresignedUrl, sha256Base64 } from '../src/test/storage';
import { UploadSession } from '../src/videos/entities/upload-session.entity';
import { Video } from '../src/videos/entities/video.entity';
import { registerConfirmedUser } from './helpers/auth';
import { VideoQueuesControl } from './helpers/queues';
import {
  errorBody,
  partUrlsBody,
  videoUploadSessionBody,
} from './helpers/response-bodies';
import {
  claimSessionForCompletion,
  closeVideoFixtureContext,
  createVideoFixtureContext,
  removeVideoStorage,
  type VideoFixtureContext,
} from './helpers/video-fixtures';

jest.setTimeout(60_000);

/** 5 MiB, the minimum part of the S3, so each file has few parts (TD-15). */
const PART_SIZE = 5_242_880;
const PART_SIZE_ENV = 'UPLOAD_PART_SIZE_BYTES';
/** One part of 1 MiB. */
const FILE_SIZE = 1_048_576;

describe('DELETE /videos/:publicId/upload-sessions/:sessionId (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queues: VideoQueuesControl;
  let fixtures: VideoFixtureContext;
  let ownerToken: string;
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
    // The queues are paused and idle before any data is removed, so the sweep does not act.
    await queues.prepareScenario();
    await removeStorageOfAllVideos();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const run = `${process.pid}_${++userCounter}`;
    ownerToken = await registerConfirmedUser(
      app,
      `session_abort_owner_${run}@example.com`,
    );
  });

  async function removeStorageOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
      await removeVideoStorage(fixtures, video.id);
    }
  }

  interface CreatedVideo {
    publicId: string;
    sessionId: string;
  }

  async function createVideo(): Promise<CreatedVideo> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        fileName: 'video.mp4',
        sizeBytes: FILE_SIZE,
        contentType: 'video/mp4',
      })
      .expect(201);
    const body = videoUploadSessionBody(res);
    expect(body.uploadSession.partSize).toBe(PART_SIZE);
    return { publicId: body.publicId, sessionId: body.uploadSession.id };
  }

  function sessionPath(video: CreatedVideo): string {
    return `/videos/${video.publicId}/upload-sessions/${video.sessionId}`;
  }

  function deleteSession(video: CreatedVideo): SupertestRequest {
    return request(app.getHttpServer())
      .delete(sessionPath(video))
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  async function sendPart1(video: CreatedVideo): Promise<void> {
    const body = randomBytes(FILE_SIZE);
    const [signed] = partUrlsBody(
      await request(app.getHttpServer())
        .post(`${sessionPath(video)}/part-urls`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          parts: [{ partNumber: 1, checksumSha256: sha256Base64(body) }],
        })
        .expect(200),
    ).parts;
    const put = await requestPresignedUrl(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body,
    });
    expect(put.status).toBe(200);
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  /** `ListParts` of the upload of the session, on the internal client of the fixtures. */
  async function listPartsOf(session: UploadSession): Promise<string> {
    try {
      const listed = await fixtures.s3.send(
        new ListPartsCommand({
          Bucket: fixtures.bucket,
          Key: session.object_key,
          UploadId: session.upload_id ?? '',
        }),
      );
      return `found ${listed.Parts?.length ?? 0} part(s)`;
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchUpload') {
        return 'NoSuchUpload';
      }
      throw error;
    }
  }

  describe('1. Abort da sessão', () => {
    it('1.1 abort-de-sessao-ativa-retorna-204-e-mantem-o-rascunho', async () => {
      const video = await createVideo();
      await sendPart1(video);
      const before = await storedSession(video.sessionId);
      await expect(listPartsOf(before)).resolves.toBe('found 1 part(s)');

      const res = await deleteSession(video).expect(204);

      expect(res.text).toBe('');
      await expect(listPartsOf(before)).resolves.toBe('NoSuchUpload');
      await expect(storedSession(video.sessionId)).resolves.toMatchObject({
        status: 'aborted',
      });
      await expect(
        dataSource
          .getRepository(Video)
          .findOneByOrFail({ public_id: video.publicId }),
      ).resolves.toMatchObject({
        status: 'draft',
        current_upload_session_id: video.sessionId,
      });
      await expect(queues.processing.getJobs()).resolves.toEqual([]);
    });

    it('1.2 abort-repetido-retorna-204', async () => {
      const video = await createVideo();
      await deleteSession(video).expect(204);
      const sessionBefore = await storedSession(video.sessionId);
      const videoBefore = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: video.publicId });

      await deleteSession(video).expect(204);

      const sessionAfter = await storedSession(video.sessionId);
      expect(sessionAfter.status).toBe('aborted');
      expect(sessionAfter).toEqual(sessionBefore);
      await expect(
        dataSource
          .getRepository(Video)
          .findOneByOrFail({ public_id: video.publicId }),
      ).resolves.toEqual(videoBefore);
    });

    it('1.3 abort-de-sessao-em-conclusao-retorna-409', async () => {
      const video = await createVideo();
      const completing = await claimSessionForCompletion(
        fixtures,
        video.sessionId,
      );

      const res = await deleteSession(video).expect(409);

      expect(errorBody(res).error).toBe('UPLOAD_SESSION_COMPLETING');
      await expect(storedSession(video.sessionId)).resolves.toEqual(completing);
      await expect(listPartsOf(completing)).resolves.toBe('found 0 part(s)');
    });
  });
});
