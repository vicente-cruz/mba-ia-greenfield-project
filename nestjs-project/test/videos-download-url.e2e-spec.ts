import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import videoConfig from '../src/config/video.config';
import { parseContentDisposition } from '../src/test/content-disposition';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  type RawHttpResponse,
  requestPresignedUrl,
  sha256Base64,
} from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { registerConfirmedUser } from './helpers/auth';
import { VideoQueuesControl } from './helpers/queues';
import {
  errorBody,
  partUrlsBody,
  videoUploadSessionBody,
} from './helpers/response-bodies';
import {
  closeVideoFixtureContext,
  createVideoFixtureContext,
  removeVideoStorage,
  seedErrorVideo,
  seedReadyVideo,
  type VideoFixtureContext,
} from './helpers/video-fixtures';

jest.setTimeout(60_000);

/** 5 MiB, the minimum part of the S3; each fixture fits in a single part (TD-15). */
const PART_SIZE = 5_242_880;
const PART_SIZE_ENV = 'UPLOAD_PART_SIZE_BYTES';
const FIXTURES = join(__dirname, 'fixtures', 'videos');
/** The valid MP4 H.264/AAC and the invalid file of SI-03.6 (V-04). */
const FIXTURE = readFileSync(join(FIXTURES, 'h264-aac-faststart.mp4'));
const INVALID = readFileSync(join(FIXTURES, 'invalid.mp4'));
const ACCENTED_NAME = 'vídeo de ação.mp4';
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 60_000;

const sha256 = (data: Buffer) =>
  createHash('sha256').update(data).digest('hex');

/** Body of `GET /videos/:publicId/download-url` (200). */
interface DownloadUrlBody {
  url: string;
  expiresAt: string;
}

function downloadBody(res: request.Response): DownloadUrlBody {
  return res.body as DownloadUrlBody;
}

/** The fields of `GET /videos/:publicId` that the scenarios read. */
interface VideoBody {
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  hasThumbnail: boolean;
}

describe('GET /videos/:publicId/download-url (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queues: VideoQueuesControl;
  let fixtures: VideoFixtureContext;
  let ownerEmail: string;
  let ownerToken: string;
  let run: string;
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
        // Removes the jobs of the suite before resuming both queues.
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
    // Both queues paused and idle (including a job the previous scenario resumed), and the jobs of
    // video-processing removed, before any data is removed.
    await queues.prepareScenario();
    await removeStorageOfAllVideos();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    run = `${process.pid}_${++userCounter}`;
    ownerEmail = `download_owner_${run}@example.com`;
    ownerToken = await registerConfirmedUser(app, ownerEmail);
  });

  async function removeStorageOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
      await removeVideoStorage(fixtures, video.id);
    }
  }

  async function ownerChannelId(): Promise<string> {
    const owner = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: ownerEmail });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: owner.id });
    return channel.id;
  }

  function getDownloadUrl(
    publicId: string,
    token: string | null = ownerToken,
  ): SupertestRequest {
    const req = request(app.getHttpServer()).get(
      `/videos/${publicId}/download-url`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function getVideo(publicId: string): SupertestRequest {
    return request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  /** A ready video of the owner named `vídeo de ação.mp4`, whose original is the fixture. */
  async function seedReady(): Promise<Video> {
    const { video } = await seedReadyVideo(fixtures, {
      channelId: await ownerChannelId(),
      original: FIXTURE,
      contentType: 'video/mp4',
      originalFilename: ACCENTED_NAME,
      thumbnail: randomBytes(512),
    });
    return video;
  }

  /** Full GET on the signed URL, without Range, keeping its signed Host. */
  async function download(url: string): Promise<RawHttpResponse> {
    const response = await requestPresignedUrl(url);
    expect(response.status).toBe(200);
    return response;
  }

  describe('1. URL de download sobre estados preparados', () => {
    it('1.1 video-pronto-recebe-url-e-prazo', async () => {
      const video = await seedReady();
      const requestedAt = Date.now();

      const res = await getDownloadUrl(video.public_id).expect(200);

      const body = downloadBody(res);
      expect(Object.keys(body).sort()).toEqual(['expiresAt', 'url']);
      expect(typeof body.url).toBe('string');
      const ttlMs = videoConfig().downloadUrlTtlSeconds * 1_000;
      expect(
        Math.abs(Date.parse(body.expiresAt) - (requestedAt + ttlMs)),
      ).toBeLessThanOrEqual(3_000);
    });

    it('1.2 download-completo-tem-os-bytes-do-original-e-attachment', async () => {
      const video = await seedReady();
      const { url } = downloadBody(
        await getDownloadUrl(video.public_id).expect(200),
      );

      const response = await download(url);

      expect(response.headers['content-disposition']).toMatch(/^attachment/);
      expect(sha256(response.body)).toBe(sha256(FIXTURE));
    });

    it('1.3 nome-com-acentos-chega-preservado-em-filename-star', async () => {
      const video = await seedReady();
      const { url } = downloadBody(
        await getDownloadUrl(video.public_id).expect(200),
      );

      const header = (await download(url)).headers['content-disposition'];

      expect(header).toContain(
        "filename*=UTF-8''v%C3%ADdeo%20de%20a%C3%A7%C3%A3o.mp4",
      );
      expect(parseContentDisposition(header).filenameStar).toBe(ACCENTED_NAME);
    });

    it('1.4 video-fora-de-ready-retorna-409', async () => {
      const draft = videoUploadSessionBody(
        await request(app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({
            fileName: 'clip.mp4',
            contentType: 'video/mp4',
            sizeBytes: FIXTURE.length,
          })
          .expect(201),
      );
      const draftRes = await getDownloadUrl(draft.publicId).expect(409);
      expect(errorBody(draftRes).error).toBe('VIDEO_NOT_READY');

      const { video: errored } = await seedErrorVideo(fixtures, {
        channelId: await ownerChannelId(),
        original: FIXTURE,
        errorCode: 'MEDIA_INVALID',
      });
      expect(errored).toMatchObject({
        status: 'error',
        error_code: 'MEDIA_INVALID',
      });
      const errorRes = await getDownloadUrl(errored.public_id).expect(409);
      expect(errorBody(errorRes).error).toBe('VIDEO_NOT_READY');
    });
  });

  describe('2. Processamento real até ready e até error', () => {
    /**
     * Uploads `body` through the routes of the phase, declared as `video/mp4`, completes the
     * session and checks that the video waits in `processing` with the queue paused.
     */
    async function uploadAndComplete(
      fileName: string,
      body: Buffer,
    ): Promise<{ publicId: string; videoId: string }> {
      const created = videoUploadSessionBody(
        await request(app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ fileName, contentType: 'video/mp4', sizeBytes: body.length })
          .expect(201),
      );
      expect(created.uploadSession.partCount).toBe(1);
      const sessionPath = `/videos/${created.publicId}/upload-sessions/${created.uploadSession.id}`;
      const [part] = partUrlsBody(
        await request(app.getHttpServer())
          .post(`${sessionPath}/part-urls`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({
            parts: [{ partNumber: 1, checksumSha256: sha256Base64(body) }],
          })
          .expect(200),
      ).parts;
      const put = await requestPresignedUrl(part.url, {
        method: part.method,
        headers: part.headers,
        body,
      });
      expect(put.status).toBe(200);
      await request(app.getHttpServer())
        .post(`${sessionPath}/part-urls`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          completedParts: [{ partNumber: 1, etag: put.headers.etag as string }],
        })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${sessionPath}/completion`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(202);
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: created.publicId });

      // The queue is still paused: the job waits, and the video stays in `processing`.
      const waiting = (await getVideo(created.publicId).expect(200))
        .body as VideoBody;
      expect(waiting.status).toBe('processing');
      expect(['waiting', 'paused', 'prioritized']).toContain(
        await queues.processing.getJobState(`video-${video.id}-1-1`),
      );
      return { publicId: created.publicId, videoId: video.id };
    }

    /** GET /videos/{publicId} every second until the video leaves `processing`. */
    async function pollUntilProcessed(publicId: string): Promise<VideoBody> {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        const body = (await getVideo(publicId).expect(200)).body as VideoBody;
        if (body.status !== 'processing') {
          return body;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `The video is still processing after ${POLL_TIMEOUT_MS} ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }

    it(
      '2.1 original-enviado-e-processado-e-baixado-com-os-mesmos-bytes',
      async () => {
        const video = await uploadAndComplete(ACCENTED_NAME, FIXTURE);

        await queues.resumeProcessing();
        const processed = await pollUntilProcessed(video.publicId);

        expect(processed.status).toBe('ready');
        const res = await getDownloadUrl(video.publicId).expect(200);
        const body = downloadBody(res);
        expect(Object.keys(body).sort()).toEqual(['expiresAt', 'url']);
        const response = await download(body.url);
        expect(sha256(response.body)).toBe(sha256(FIXTURE));
        expect(
          parseContentDisposition(response.headers['content-disposition']),
        ).toMatchObject({ type: 'attachment', filenameStar: ACCENTED_NAME });
      },
      POLL_TIMEOUT_MS + 30_000,
    );

    it(
      '2.2 midia-invalida-termina-em-error-e-nao-recebe-url',
      async () => {
        const video = await uploadAndComplete('invalid.mp4', INVALID);

        await queues.resumeProcessing();
        const processed = await pollUntilProcessed(video.publicId);

        expect(processed).toMatchObject({
          status: 'error',
          errorCode: 'MEDIA_INVALID',
          hasThumbnail: false,
        });
        expect(processed.errorMessage).toEqual(expect.any(String));
        expect(processed.errorMessage).not.toBe('');
        const res = await getDownloadUrl(video.publicId).expect(409);
        expect(errorBody(res).error).toBe('VIDEO_NOT_READY');
      },
      POLL_TIMEOUT_MS + 30_000,
    );
  });

  /*
   * Outside the spec: the refusals of authorization of the route, as in playback-url, and its
   * explicit limit ("API Contracts → Throttle"), 30 requests every 60 s.
   */
  describe('Autorização e limite da rota', () => {
    it('outro usuário recebe 404 VIDEO_NOT_FOUND, e sem token a resposta é 401', async () => {
      const video = await seedReady();
      const otherToken = await registerConfirmedUser(
        app,
        `download_other_${run}@example.com`,
      );

      const res = await getDownloadUrl(video.public_id, otherToken).expect(404);
      expect(errorBody(res).error).toBe('VIDEO_NOT_FOUND');

      await getDownloadUrl(video.public_id, null).expect(401);
    });

    it('30 requisições em 60 s respondem 200, e a 31ª recebe 429', async () => {
      const video = await seedReady();
      const statuses: number[] = [];

      for (let attempt = 0; attempt < 31; attempt++) {
        statuses.push((await getDownloadUrl(video.public_id)).status);
      }

      expect(statuses.slice(0, 30)).toEqual(
        Array.from({ length: 30 }, () => 200),
      );
      expect(statuses[30]).toBe(429);
    });
  });
});
