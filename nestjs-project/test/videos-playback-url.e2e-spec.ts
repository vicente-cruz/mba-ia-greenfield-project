import { randomBytes } from 'node:crypto';
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
import storageConfig from '../src/config/storage.config';
import videoConfig from '../src/config/video.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { requestPresignedUrl, sha256Base64 } from '../src/test/storage';
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
  seedProcessingVideo,
  seedReadyVideo,
  type VideoFixtureContext,
} from './helpers/video-fixtures';

jest.setTimeout(60_000);

/** 5 MiB, the minimum part of the S3; the fixture fits in a single part (TD-15). */
const PART_SIZE = 5_242_880;
const PART_SIZE_ENV = 'UPLOAD_PART_SIZE_BYTES';
/** The valid MP4 H.264/AAC of SI-03.6 (V-04). */
const FIXTURE = readFileSync(
  join(__dirname, 'fixtures', 'videos', 'h264-aac-faststart.mp4'),
);
const RANGE = 'bytes=0-1023';
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 60_000;

/** Body of `GET /videos/:publicId/playback-url` (200). */
interface PlaybackUrlBody {
  url: string;
  contentType: string;
  expiresAt: string;
}

function playbackBody(res: request.Response): PlaybackUrlBody {
  return res.body as PlaybackUrlBody;
}

/** The fields of `GET /videos/:publicId` that the scenarios read. */
interface VideoBody {
  status: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  hasThumbnail: boolean;
}

describe('GET /videos/:publicId/playback-url (e2e)', () => {
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
    const run = `${process.pid}_${++userCounter}`;
    ownerEmail = `playback_owner_${run}@example.com`;
    ownerToken = await registerConfirmedUser(app, ownerEmail);
    otherToken = await registerConfirmedUser(
      app,
      `playback_other_${run}@example.com`,
    );
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

  function getPlaybackUrl(
    publicId: string,
    token: string | null = ownerToken,
  ): SupertestRequest {
    const req = request(app.getHttpServer()).get(
      `/videos/${publicId}/playback-url`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function getVideo(publicId: string): SupertestRequest {
    return request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  /** A ready video of the owner whose original is the fixture, with its thumbnail. */
  async function seedReady(): Promise<Video> {
    const { video } = await seedReadyVideo(fixtures, {
      channelId: await ownerChannelId(),
      original: FIXTURE,
      contentType: 'video/mp4',
      thumbnail: randomBytes(512),
    });
    return video;
  }

  /** GET with `Range: bytes=0-1023` on the signed URL, keeping its signed Host. */
  async function expectFirstKilobyte(url: string): Promise<void> {
    const response = await requestPresignedUrl(url, {
      headers: { range: RANGE },
    });
    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe(
      `bytes 0-1023/${FIXTURE.length}`,
    );
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.body).toHaveLength(1024);
    expect(response.body.equals(FIXTURE.subarray(0, 1024))).toBe(true);
  }

  describe('1. URL de reprodução sobre estados preparados', () => {
    it('1.1 video-pronto-recebe-url-com-tipo-e-prazo', async () => {
      const video = await seedReady();
      const requestedAt = Date.now();

      const res = await getPlaybackUrl(video.public_id).expect(200);

      const body = playbackBody(res);
      expect(Object.keys(body).sort()).toEqual([
        'contentType',
        'expiresAt',
        'url',
      ]);
      expect(body.contentType).toBe('video/mp4');
      const ttlMs = videoConfig().playbackUrlTtlSeconds * 1_000;
      const expiresAt = Date.parse(body.expiresAt);
      expect(Math.abs(expiresAt - (requestedAt + ttlMs))).toBeLessThanOrEqual(
        3_000,
      );
      const url = new URL(body.url);
      expect(url.host).toBe(new URL(storageConfig().publicEndpoint).host);
      expect(decodeURIComponent(url.pathname)).toContain(
        `/${video.original_key}`,
      );
    });

    it('1.2 url-responde-206-com-content-range', async () => {
      const video = await seedReady();

      const res = await getPlaybackUrl(video.public_id).expect(200);

      await expectFirstKilobyte(playbackBody(res).url);
    });

    it('1.3 video-em-processing-retorna-409', async () => {
      const { video, session } = await seedProcessingVideo(fixtures, {
        channelId: await ownerChannelId(),
        original: FIXTURE,
        contentType: 'video/mp4',
      });
      expect(video).toMatchObject({
        status: 'processing',
        processing_run: 1,
        original_key: session.object_key,
      });

      const res = await getPlaybackUrl(video.public_id).expect(409);

      expect(errorBody(res).error).toBe('VIDEO_NOT_READY');
    });

    it('1.4 nao-dono-recebe-404', async () => {
      const video = await seedReady();

      const res = await getPlaybackUrl(video.public_id, otherToken).expect(404);
      expect(errorBody(res).error).toBe('VIDEO_NOT_FOUND');

      await getPlaybackUrl(video.public_id, null).expect(401);
    });
  });

  describe('2. Processamento real até ready', () => {
    /** Uploads the fixture through the routes of the phase and completes the session. */
    async function uploadFixture(): Promise<{
      publicId: string;
      videoId: string;
    }> {
      const created = videoUploadSessionBody(
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
      expect(created.uploadSession.partCount).toBe(1);
      const sessionPath = `/videos/${created.publicId}/upload-sessions/${created.uploadSession.id}`;
      const [part] = partUrlsBody(
        await request(app.getHttpServer())
          .post(`${sessionPath}/part-urls`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({
            parts: [{ partNumber: 1, checksumSha256: sha256Base64(FIXTURE) }],
          })
          .expect(200),
      ).parts;
      const put = await requestPresignedUrl(part.url, {
        method: part.method,
        headers: part.headers,
        body: FIXTURE,
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
      '2.1 upload-real-passa-por-processing-e-chega-a-ready-com-url-funcional',
      async () => {
        const video = await uploadFixture();

        // The queue is paused: the job exists and nobody consumed it.
        await expect(
          getVideo(video.publicId).then(
            (res) => (res.body as VideoBody).status,
          ),
        ).resolves.toBe('processing');
        const jobId = `video-${video.videoId}-1-1`;
        const state = await queues.processing.getJobState(jobId);
        expect(['waiting', 'paused', 'prioritized']).toContain(state);
        const notReady = await getPlaybackUrl(video.publicId).expect(409);
        expect(errorBody(notReady).error).toBe('VIDEO_NOT_READY');

        await queues.resumeProcessing();
        const processed = await pollUntilProcessed(video.publicId);

        expect(processed).toMatchObject({
          status: 'ready',
          videoCodec: 'h264',
          hasThumbnail: true,
        });
        expect(processed.durationSeconds).toBeGreaterThan(0);
        expect(processed.width).toBeGreaterThan(0);
        expect(processed.height).toBeGreaterThan(0);
        const res = await getPlaybackUrl(video.publicId).expect(200);
        expect(playbackBody(res).contentType).toBe('video/mp4');
        await expectFirstKilobyte(playbackBody(res).url);
      },
      POLL_TIMEOUT_MS + 30_000,
    );
  });

  /*
   * Outside the spec: the explicit limit of the route ("API Contracts → Throttle"), 30 requests
   * every 60 s, above the unnamed global throttler of 10.
   */
  describe('Limite da rota', () => {
    it('30 requisições em 60 s respondem 200, e a 31ª recebe 429', async () => {
      const video = await seedReady();
      const statuses: number[] = [];

      for (let attempt = 0; attempt < 31; attempt++) {
        statuses.push((await getPlaybackUrl(video.public_id)).status);
      }

      expect(statuses.slice(0, 30)).toEqual(
        Array.from({ length: 30 }, () => 200),
      );
      expect(statuses[30]).toBe(429);
    });
  });
});
