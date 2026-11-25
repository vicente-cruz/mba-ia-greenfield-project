import { randomBytes } from 'node:crypto';
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
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { registerConfirmedUser } from './helpers/auth';
import { VideoQueuesControl } from './helpers/queues';
import { errorBody, videoUploadSessionBody } from './helpers/response-bodies';
import {
  closeVideoFixtureContext,
  createVideoFixtureContext,
  removeVideoStorage,
  seedDraftVideo,
  seedErrorVideo,
  seedReadyVideo,
  type VideoFixtureContext,
} from './helpers/video-fixtures';

jest.setTimeout(60_000);

/** Body of `GET /videos/:publicId` (200). */
interface VideoBody {
  publicId: string;
  status: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasThumbnail: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  uploadSession: { id: string; status: string; expiresAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

function videoBody(res: request.Response): VideoBody {
  return res.body as VideoBody;
}

describe('GET /videos/:publicId (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queues: VideoQueuesControl;
  let fixtures: VideoFixtureContext;
  let ownerEmail: string;
  let ownerToken: string;
  let otherToken: string;
  let userCounter = 0;

  beforeAll(async () => {
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
      }
    }
  });

  beforeEach(async () => {
    // The queues are paused and idle before any data is removed: neither the worker nor the
    // maintenance changes the states prepared by the scenarios.
    await queues.prepareScenario();
    await removeStorageOfAllVideos();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const run = `${process.pid}_${++userCounter}`;
    ownerEmail = `video_get_owner_${run}@example.com`;
    ownerToken = await registerConfirmedUser(app, ownerEmail);
    otherToken = await registerConfirmedUser(
      app,
      `video_get_other_${run}@example.com`,
    );
  });

  async function removeStorageOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
      await removeVideoStorage(fixtures, video.id);
    }
  }

  async function createVideo(): Promise<{
    publicId: string;
    sessionId: string;
  }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1_048_576,
      })
      .expect(201);
    const body = videoUploadSessionBody(res);
    return { publicId: body.publicId, sessionId: body.uploadSession.id };
  }

  function getVideo(
    publicId: string,
    token: string | null = ownerToken,
  ): SupertestRequest {
    const req = request(app.getHttpServer()).get(`/videos/${publicId}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
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

  describe('1. Estado e metadados do vídeo', () => {
    it('1.1 dono-recebe-estado-metadados-e-sessao-vigente', async () => {
      const video = await createVideo();

      const res = await getVideo(video.publicId).expect(200);

      const body = videoBody(res);
      expect(body).toMatchObject({
        publicId: video.publicId,
        status: 'draft',
        originalFilename: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1_048_576,
        hasThumbnail: false,
      });
      expect(body.uploadSession).toEqual({
        id: video.sessionId,
        status: 'active',
        expiresAt: expect.any(String) as unknown,
      });
      expect(
        Number.isNaN(Date.parse(body.uploadSession?.expiresAt ?? '')),
      ).toBe(false);
      for (const field of [
        'durationSeconds',
        'width',
        'height',
        'videoCodec',
        'audioCodec',
        'errorCode',
        'errorMessage',
      ] as const) {
        expect(body[field]).toBeNull();
      }
    });

    it('1.2 nao-dono-e-publicid-malformado-recebem-404', async () => {
      const video = await createVideo();

      const foreign = await getVideo(video.publicId, otherToken).expect(404);
      expect(errorBody(foreign).error).toBe('VIDEO_NOT_FOUND');

      const malformed = await getVideo('abc').expect(404);
      expect(errorBody(malformed).error).toBe('VIDEO_NOT_FOUND');
      // The same answer as for a video of another channel: the format rule is not revealed.
      expect(errorBody(malformed).message).toBe(errorBody(foreign).message);

      await getVideo(video.publicId, null).expect(401);
    });

    it('1.3 video-em-error-expoe-codigo-e-mensagem', async () => {
      const { video, session } = await seedErrorVideo(fixtures, {
        channelId: await ownerChannelId(),
        original: randomBytes(4_096),
        errorCode: 'MEDIA_INVALID',
        errorMessage: 'The original is not a valid video',
      });
      expect(video).toMatchObject({
        processing_run: 1,
        original_key: session.object_key,
        thumbnail_key: null,
      });

      const res = await getVideo(video.public_id).expect(200);

      expect(videoBody(res)).toMatchObject({
        status: 'error',
        errorCode: 'MEDIA_INVALID',
        errorMessage: 'The original is not a valid video',
        hasThumbnail: false,
      });
    });

    it('1.4 polling-de-30-requisicoes-em-60s-nao-recebe-429', async () => {
      const video = await createVideo();
      const statuses: number[] = [];

      for (let request = 0; request < 30; request++) {
        statuses.push((await getVideo(video.publicId)).status);
      }

      expect(statuses).toEqual(Array.from({ length: 30 }, () => 200));
    });
  });

  /*
   * Outside the spec: the fields of a video after the processing, prepared by fixture, and a draft
   * without a current session. The processing itself starts in SI-03.20.
   */
  describe('Metadados preenchidos e sessão nula', () => {
    it('vídeo ready traz os metadados, a duração numérica e a thumbnail, sem campos internos', async () => {
      const { video, session } = await seedReadyVideo(fixtures, {
        channelId: await ownerChannelId(),
        original: randomBytes(4_096),
        thumbnail: randomBytes(512),
        metadata: { duration_seconds: '12.345', width: 1280, height: 720 },
      });

      const res = await getVideo(video.public_id).expect(200);

      const body = videoBody(res);
      expect(body).toMatchObject({
        status: 'ready',
        durationSeconds: 12.345,
        width: 1280,
        height: 720,
        videoCodec: 'h264',
        audioCodec: 'aac',
        hasThumbnail: true,
        errorCode: null,
        errorMessage: null,
        uploadSession: { id: session.id, status: 'completed' },
      });
      expect(typeof body.durationSeconds).toBe('number');
      expect(Object.keys(body).sort()).toEqual([
        'audioCodec',
        'contentType',
        'createdAt',
        'durationSeconds',
        'errorCode',
        'errorMessage',
        'hasThumbnail',
        'height',
        'originalFilename',
        'publicId',
        'sizeBytes',
        'status',
        'updatedAt',
        'uploadSession',
        'videoCodec',
        'width',
      ]);
    });

    it('rascunho sem sessão vigente traz uploadSession nula', async () => {
      const { video } = await seedDraftVideo(fixtures, {
        channelId: await ownerChannelId(),
      });

      const res = await getVideo(video.public_id).expect(200);

      expect(videoBody(res)).toMatchObject({
        status: 'draft',
        uploadSession: null,
        durationSeconds: null,
      });
    });
  });
});
