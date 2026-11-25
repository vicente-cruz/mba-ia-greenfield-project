import { createHash, randomBytes } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request, { type Test as SupertestRequest } from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import videoConfig from '../src/config/video.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { UploadPart } from '../src/videos/entities/upload-part.entity';
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
  closeVideoFixtureContext,
  createVideoFixtureContext,
  removeVideoStorage,
  type VideoFixtureContext,
} from './helpers/video-fixtures';

jest.setTimeout(60_000);

const PART_SIZE = 67_108_864;

/** SHA-256 of the bytes of a part, in base64 with padding. */
function checksumOf(size: number): string {
  return createHash('sha256').update(randomBytes(size)).digest('base64');
}

describe('POST /videos/:publicId/upload-sessions/:sessionId/part-urls (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queues: VideoQueuesControl;
  let fixtures: VideoFixtureContext;
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
    // The queues are paused and idle before any data is removed.
    await queues.prepareScenario();
    await removeStorageOfAllVideos();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const run = `${process.pid}_${++userCounter}`;
    ownerToken = await registerConfirmedUser(
      app,
      `part_urls_owner_${run}@example.com`,
    );
    otherToken = await registerConfirmedUser(
      app,
      `part_urls_other_${run}@example.com`,
    );
  });

  async function removeStorageOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
      await removeVideoStorage(fixtures, video.id);
    }
  }

  async function createVideo(
    sizeBytes: number,
  ): Promise<{ publicId: string; sessionId: string; partCount: number }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ fileName: 'video.mp4', sizeBytes, contentType: 'video/mp4' })
      .expect(201);
    const body = videoUploadSessionBody(res);
    return {
      publicId: body.publicId,
      sessionId: body.uploadSession.id,
      partCount: body.uploadSession.partCount,
    };
  }

  function postPartUrls(
    video: { publicId: string; sessionId: string },
    body: object,
    token: string | null = ownerToken,
  ): SupertestRequest {
    const req = request(app.getHttpServer()).post(
      `/videos/${video.publicId}/upload-sessions/${video.sessionId}/part-urls`,
    );
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  }

  async function partsOf(sessionId: string): Promise<UploadPart[]> {
    return dataSource
      .getRepository(UploadPart)
      .find({ where: { upload_session_id: sessionId } });
  }

  describe('1. Assinatura em lote', () => {
    it('1.1 assina-a-ultima-parte-com-tamanho-e-header-separados', async () => {
      const video = await createVideo(10_000_000_000);
      expect(video.partCount).toBe(150);
      const checksum = checksumOf(779_264);

      const before = Date.now();
      const res = await postPartUrls(video, {
        parts: [{ partNumber: 150, checksumSha256: checksum }],
      }).expect(200);
      const after = Date.now();

      const [part] = partUrlsBody(res).parts;
      expect(part.partNumber).toBe(150);
      expect(part.expectedSize).toBe(779_264);
      expect(part.method).toBe('PUT');
      expect(new URL(part.url).host).toBe(
        new URL(storageConfig().publicEndpoint).host,
      );
      expect(Object.keys(part.headers)).toEqual(['x-amz-checksum-sha256']);
      expect(part.headers['x-amz-checksum-sha256']).toBe(checksum);
      const ttlMs = videoConfig().uploadPartUrlTtlSeconds * 1000;
      const expiresAt = new Date(part.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before - 1_000 + ttlMs);
      expect(expiresAt).toBeLessThanOrEqual(after + ttlMs);
      expect(partUrlsBody(res).registeredParts).toEqual([]);

      const [stored] = await partsOf(video.sessionId);
      expect(stored).toMatchObject({
        part_number: 150,
        expected_size: 779_264,
        checksum_sha256: checksum,
        etag: null,
      });
    });

    it('1.2 tamanho-esperado-em-arquivo-multiplo-exato', async () => {
      const video = await createVideo(134_217_728);
      expect(video.partCount).toBe(2);

      const res = await postPartUrls(video, {
        parts: [
          { partNumber: 1, checksumSha256: checksumOf(64) },
          { partNumber: 2, checksumSha256: checksumOf(64) },
        ],
      }).expect(200);

      const sizes = partUrlsBody(res).parts.map((part) => part.expectedSize);
      expect(sizes).toEqual([PART_SIZE, PART_SIZE]);
      expect(sizes).not.toContain(0);
    });
  });

  describe('2. Validação e conflitos', () => {
    it('2.1 numero-de-parte-fora-do-plano-retorna-400', async () => {
      const video = await createVideo(10_000_000_000);

      const outside = await postPartUrls(video, {
        parts: [{ partNumber: 151, checksumSha256: checksumOf(64) }],
      }).expect(400);
      expect(errorBody(outside).error).toBe('INVALID_PART_NUMBER');
      await expect(partsOf(video.sessionId)).resolves.toEqual([]);

      const empty = await postPartUrls(video, {
        parts: [],
        completedParts: [],
      }).expect(400);
      expect(errorBody(empty).error).toBe('VALIDATION_ERROR');
    });

    it('2.2 checksum-divergente-bloqueia-a-sessao', async () => {
      const video = await createVideo(10_000_000_000);
      const checksumA = checksumOf(64);
      const checksumB = checksumOf(64);

      await postPartUrls(video, {
        parts: [{ partNumber: 3, checksumSha256: checksumA }],
      }).expect(200);

      const mismatch = await postPartUrls(video, {
        parts: [{ partNumber: 3, checksumSha256: checksumB }],
      }).expect(409);
      expect(errorBody(mismatch).error).toBe('UPLOAD_FILE_MISMATCH');
      const session = await dataSource
        .getRepository(UploadSession)
        .findOneByOrFail({ id: video.sessionId });
      expect(session.file_mismatch_at).toBeInstanceOf(Date);
      const [part3] = await partsOf(video.sessionId);
      expect(part3).toMatchObject({
        part_number: 3,
        checksum_sha256: checksumA,
      });

      const blocked = await postPartUrls(video, {
        parts: [{ partNumber: 4, checksumSha256: checksumOf(64) }],
      }).expect(409);
      expect(errorBody(blocked).error).toBe('UPLOAD_FILE_MISMATCH');
    });

    it('2.3 etag-de-parte-nao-assinada-retorna-409', async () => {
      const video = await createVideo(10_000_000_000);

      const unsigned = await postPartUrls(video, {
        completedParts: [{ partNumber: 10, etag: '"abc"' }],
      }).expect(409);
      expect(errorBody(unsigned).error).toBe('UPLOAD_PART_NOT_SIGNED');

      await postPartUrls(video, {
        parts: [{ partNumber: 1, checksumSha256: checksumOf(64) }],
      }).expect(200);
      const registered = await postPartUrls(video, {
        completedParts: [{ partNumber: 1, etag: '"abc"' }],
      }).expect(200);
      expect(partUrlsBody(registered).registeredParts).toEqual([1]);

      const [part1] = await partsOf(video.sessionId);
      expect(part1.etag).toBe('"abc"');
      expect(part1.etag_registered_at).toBeInstanceOf(Date);
    });
  });

  describe('3. Autorização', () => {
    it('3.1 usuario-que-nao-e-dono-recebe-404', async () => {
      const video = await createVideo(10_000_000_000);
      const body = {
        parts: [{ partNumber: 1, checksumSha256: checksumOf(64) }],
      };

      const foreign = await postPartUrls(video, body, otherToken).expect(404);
      expect(errorBody(foreign).error).toBe('VIDEO_NOT_FOUND');
      await expect(partsOf(video.sessionId)).resolves.toEqual([]);

      await postPartUrls(video, body, null).expect(401);
    });
  });

  // Regression of the review of SI-03.13: items that are not objects passed the ValidationPipe.
  describe('Regressão: itens de parts e completedParts que não são objetos', () => {
    const CHECKSUM_A = checksumOf(64);
    const CHECKSUM_B = checksumOf(64);
    let video: { publicId: string; sessionId: string };

    /** Part 1 signed with checksum A and its ETag registered, before each invalid request. */
    beforeEach(async () => {
      video = await createVideo(10_000_000_000);
      await postPartUrls(video, {
        parts: [{ partNumber: 1, checksumSha256: CHECKSUM_A }],
      }).expect(200);
      await postPartUrls(video, {
        completedParts: [{ partNumber: 1, etag: '"etag-1"' }],
      }).expect(200);
    });

    async function snapshot() {
      const session = await dataSource
        .getRepository(UploadSession)
        .findOneByOrFail({ id: video.sessionId });
      const parts = await partsOf(video.sessionId);
      return {
        fileMismatchAt: session.file_mismatch_at,
        parts: parts
          .map((part) => ({
            partNumber: part.part_number,
            checksum: part.checksum_sha256,
            etag: part.etag,
            etagRegisteredAt: part.etag_registered_at?.toISOString(),
          }))
          .sort((a, b) => a.partNumber - b.partNumber),
      };
    }

    it.each([
      ['parts com um array vazio', { parts: [[]] }],
      ['completedParts com um array vazio', { completedParts: [[]] }],
      [
        'parts com um array aninhado contendo um objeto válido',
        { parts: [[{ partNumber: 1, checksumSha256: CHECKSUM_B }]] },
      ],
      [
        'completedParts com um array aninhado contendo um objeto válido',
        { completedParts: [[{ partNumber: 1, etag: '"etag-new"' }]] },
      ],
      [
        'parts inválido com completedParts válido de uma parte já registrada',
        {
          parts: [[]],
          completedParts: [{ partNumber: 1, etag: '"etag-new"' }],
        },
      ],
    ])(
      '%s retorna 400 sem alterar checksums, ETags ou file_mismatch_at',
      async (_case, body) => {
        const before = await snapshot();

        const res = await postPartUrls(video, body).expect(400);

        expect(errorBody(res).error).toBe('VALIDATION_ERROR');
        await expect(snapshot()).resolves.toEqual(before);
        expect(before).toMatchObject({
          fileMismatchAt: null,
          parts: [{ partNumber: 1, checksum: CHECKSUM_A, etag: '"etag-1"' }],
        });
      },
    );

    it('pedidos válidos continuam funcionando depois dos inválidos', async () => {
      await postPartUrls(video, { parts: [[]] }).expect(400);

      const res = await postPartUrls(video, {
        parts: [{ partNumber: 2, checksumSha256: CHECKSUM_B }],
        completedParts: [{ partNumber: 1, etag: '"etag-1b"' }],
      }).expect(200);

      expect(partUrlsBody(res).registeredParts).toEqual([1]);
      expect(partUrlsBody(res).parts.map((part) => part.partNumber)).toEqual([
        2,
      ]);
      await expect(snapshot()).resolves.toMatchObject({
        fileMismatchAt: null,
        parts: [
          { partNumber: 1, checksum: CHECKSUM_A, etag: '"etag-1b"' },
          { partNumber: 2, checksum: CHECKSUM_B, etag: null },
        ],
      });
    });
  });
});
