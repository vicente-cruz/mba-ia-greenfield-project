import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request, { type Test as SupertestRequest } from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageUnavailableException } from '../src/storage/storage.exceptions';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  listUploadsUnder,
  realCreateMultipartUpload,
} from '../src/test/storage';
import {
  UploadSession,
  UploadSessionStatus,
} from '../src/videos/entities/upload-session.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { registerConfirmedUser } from './helpers/auth';
import { VideoQueuesControl } from './helpers/queues';
import { errorBody, videoUploadSessionBody } from './helpers/response-bodies';
import {
  closeVideoFixtureContext,
  createVideoFixtureContext,
  removeVideoStorage,
  type VideoFixtureContext,
} from './helpers/video-fixtures';

jest.setTimeout(60_000);

const VALID_BODY = {
  fileName: 'a.mp4',
  sizeBytes: 10_000_000_000,
  contentType: 'video/mp4',
};
const DAY_MS = 24 * 60 * 60 * 1000;

/** A promise resolved from outside the code that awaits it. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('POST /videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let queues: VideoQueuesControl;
  let fixtures: VideoFixtureContext;
  let accessToken: string;
  let userEmail: string;
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
    storage = moduleFixture.get(StorageService);
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
    // The queues are paused and idle before any data is removed.
    await queues.prepareScenario();
    await removeStorageOfAllVideos();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    userEmail = `videos_create_${process.pid}_${++userCounter}@example.com`;
    accessToken = await registerConfirmedUser(app, userEmail);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function removeStorageOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
      await removeVideoStorage(fixtures, video.id);
    }
  }

  function postVideo(
    body: object,
    token: string | null = accessToken,
  ): SupertestRequest {
    const req = request(app.getHttpServer()).post('/videos');
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  }

  async function countVideos(): Promise<number> {
    return dataSource.getRepository(Video).count();
  }

  describe('1. Pré-cadastro do vídeo e primeira sessão', () => {
    it('1.1 criar-video-de-10gb-retorna-rascunho-e-sessao-ativa', async () => {
      const before = Date.now();
      const res = await postVideo(VALID_BODY).expect(201);
      const after = Date.now();

      const body = videoUploadSessionBody(res);
      expect(body).toEqual({
        publicId: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/) as string,
        status: 'draft',
        uploadSession: {
          id: expect.any(String) as string,
          status: 'active',
          partSize: 67108864,
          partCount: 150,
          checksumAlgorithm: 'SHA256',
          expiresAt: expect.any(String) as string,
        },
      });
      const expiresAt = new Date(body.uploadSession.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + DAY_MS - 5_000);
      expect(expiresAt).toBeLessThanOrEqual(after + DAY_MS + 5_000);

      const video = await dataSource.getRepository(Video).findOneOrFail({
        where: { public_id: body.publicId },
        relations: { channel: { user: true } },
      });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.channel.user.email).toBe(userEmail);
      expect(video.current_upload_session_id).toBe(body.uploadSession.id);
      const session = await dataSource
        .getRepository(UploadSession)
        .findOneByOrFail({ id: body.uploadSession.id });
      expect(session.status).toBe(UploadSessionStatus.ACTIVE);
      expect(session.object_key).toBe(`originals/${video.id}/${session.id}`);
      expect(session.upload_id).toEqual(expect.any(String));
      const uploads = await listUploadsUnder(
        fixtures.s3,
        fixtures.bucket,
        session.object_key,
      );
      expect(uploads).toHaveLength(1);

      expect(JSON.stringify(res.body)).not.toContain(video.id);
    });

    it('1.2 tamanho-acima-do-limite-retorna-413', async () => {
      const create = jest.spyOn(storage, 'createMultipartUpload');

      const res = await postVideo({
        ...VALID_BODY,
        sizeBytes: 10_000_000_001,
      }).expect(413);

      expect(errorBody(res).error).toBe('VIDEO_TOO_LARGE');
      expect(errorBody(res).message).toContain('10000000000');
      await expect(countVideos()).resolves.toBe(0);
      expect(create).not.toHaveBeenCalled();
    });

    it('1.3 tipo-nao-suportado-415-e-forma-invalida-400', async () => {
      const unsupported = await postVideo({
        ...VALID_BODY,
        contentType: 'video/quicktime',
      }).expect(415);
      expect(errorBody(unsupported).error).toBe('UNSUPPORTED_VIDEO_TYPE');

      const malformed = await postVideo({
        ...VALID_BODY,
        contentType: 'abc',
      }).expect(400);
      expect(errorBody(malformed).error).toBe('VALIDATION_ERROR');

      await postVideo({
        fileName: VALID_BODY.fileName,
        contentType: VALID_BODY.contentType,
      }).expect(400);
      await postVideo({ ...VALID_BODY, sizeBytes: 1.5 }).expect(400);

      await expect(countVideos()).resolves.toBe(0);
    });

    it('1.4 sem-token-retorna-401', async () => {
      await postVideo(VALID_BODY, null).expect(401);

      await expect(countVideos()).resolves.toBe(0);
    });
  });

  describe('2. Falhas do storage na criação (P1)', () => {
    it('2.1 falha-no-create-multipart-compensa-e-retorna-503', async () => {
      jest
        .spyOn(storage, 'createMultipartUpload')
        .mockRejectedValueOnce(
          new StorageUnavailableException('CreateMultipartUpload'),
        );

      const res = await postVideo(VALID_BODY).expect(503);

      expect(errorBody(res).error).toBe('STORAGE_UNAVAILABLE');
      await expect(countVideos()).resolves.toBe(0);
      await expect(
        dataSource.getRepository(UploadSession).count(),
      ).resolves.toBe(0);
    });

    it('2.2 ativacao-que-perde-a-posse-deixa-o-rascunho-na-condicao-de-reinicio', async () => {
      const reached = deferred<string>();
      const release = deferred();
      jest
        .spyOn(storage, 'createMultipartUpload')
        .mockImplementation(async (key, options) => {
          reached.resolve(key);
          await release.promise;
          return realCreateMultipartUpload(storage, key, options);
        });

      const pending = postVideo(VALID_BODY).then((res) => res);
      const objectKey = await reached.promise;
      const sessions = dataSource.getRepository(UploadSession);
      let sweepToken = '';
      try {
        const held = await sessions.findOneByOrFail({ object_key: objectKey });
        const heldVideo = await dataSource
          .getRepository(Video)
          .findOneByOrFail({ id: held.video_id });
        expect(heldVideo.status).toBe(VideoStatus.DRAFT);
        expect(held.status).toBe(UploadSessionStatus.INITIATING);

        // The takeover that the sweep makes after the claim deadline.
        sweepToken = randomUUID();
        await sessions.update(
          { id: held.id },
          {
            status: UploadSessionStatus.ABORTING,
            claim_token: sweepToken,
            claim_expires_at: new Date(Date.now() + 300_000),
          },
        );
      } finally {
        release.resolve();
      }

      const res = await pending;
      expect(res.status).toBe(503);
      expect(errorBody(res).error).toBe('STORAGE_UNAVAILABLE');
      await expect(
        listUploadsUnder(fixtures.s3, fixtures.bucket, objectKey),
      ).resolves.toEqual([]);

      const session = await sessions.findOneByOrFail({
        object_key: objectKey,
      });
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: session.video_id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.current_upload_session_id).toBe(session.id);
      expect(session.status).toBe(UploadSessionStatus.ABORTING);
      expect(session.claim_token).toBe(sweepToken);
      const [{ usable }] = await dataSource.query<{ usable: number }[]>(
        `SELECT count(*)::int AS usable FROM upload_sessions
         WHERE video_id = $1
           AND (status = 'active'
                OR (status = 'initiating' AND claim_expires_at > now()))`,
        [video.id],
      );
      expect(usable).toBe(0);
    });
  });
});
