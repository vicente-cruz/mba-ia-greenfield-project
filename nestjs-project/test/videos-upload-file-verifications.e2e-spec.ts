import { randomBytes } from 'node:crypto';
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
import { UploadPart } from '../src/videos/entities/upload-part.entity';
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
  type VideoFixtureContext,
} from './helpers/video-fixtures';

jest.setTimeout(60_000);

/** 5 MiB, the minimum part of the S3, so each file has few parts (TD-15). */
const PART_SIZE = 5_242_880;
const PART_SIZE_ENV = 'UPLOAD_PART_SIZE_BYTES';
/** File A: two parts of 5 MiB and a remainder. */
const FILE_SIZE = 2 * PART_SIZE + 1_048_576;

/** The bytes of part `partNumber` (from 1) of `file`. */
function partOf(file: Buffer, partNumber: number): Buffer {
  return file.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE);
}

function checksumOf(file: Buffer, partNumber: number): string {
  return sha256Base64(partOf(file, partNumber));
}

/** Checksums recalculated from `file` for `partNumbers`, as the client sends them. */
function recalculated(file: Buffer, partNumbers: number[]) {
  return partNumbers.map((partNumber) => ({
    partNumber,
    checksumSha256: checksumOf(file, partNumber),
  }));
}

describe('POST /videos/:publicId/upload-sessions/:sessionId/file-verifications (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queues: VideoQueuesControl;
  let fixtures: VideoFixtureContext;
  let ownerToken: string;
  let userCounter = 0;
  /** Value of UPLOAD_PART_SIZE_BYTES before the suite, restored in `afterAll`. */
  let previousPartSize: string | undefined;
  /** File A of the scenarios, generated in memory once. */
  const fileA = randomBytes(FILE_SIZE);
  /** File A' is file A with 1 byte changed inside part 1. */
  const fileA2 = Buffer.from(fileA);
  fileA2[1_000] = fileA2[1_000] ^ 0xff;

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
    ownerToken = await registerConfirmedUser(
      app,
      `file_verifications_owner_${run}@example.com`,
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
    expect(body.uploadSession.partCount).toBe(3);
    return { publicId: body.publicId, sessionId: body.uploadSession.id };
  }

  function sessionPath(video: CreatedVideo): string {
    return `/videos/${video.publicId}/upload-sessions/${video.sessionId}`;
  }

  function postFileVerifications(
    video: CreatedVideo,
    body: unknown,
  ): SupertestRequest {
    return request(app.getHttpServer())
      .post(`${sessionPath(video)}/file-verifications`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body as object);
  }

  function postPartUrls(video: CreatedVideo, body: object): SupertestRequest {
    return request(app.getHttpServer())
      .post(`${sessionPath(video)}/part-urls`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body);
  }

  function getSession(video: CreatedVideo): SupertestRequest {
    return request(app.getHttpServer())
      .get(sessionPath(video))
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  /** Signs the parts of A and sends them through the URLs of the response; returns the ETags. */
  async function sendParts(
    video: CreatedVideo,
    partNumbers: number[],
  ): Promise<string[]> {
    const signed = partUrlsBody(
      await postPartUrls(video, {
        parts: recalculated(fileA, partNumbers),
      }).expect(200),
    ).parts;
    const etags: string[] = [];
    for (const part of signed) {
      const body = partOf(fileA, part.partNumber);
      expect(part.expectedSize).toBe(body.length);
      const put = await requestPresignedUrl(part.url, {
        method: part.method,
        headers: part.headers,
        body,
      });
      expect(put.status).toBe(200);
      etags.push(put.headers.etag as string);
    }
    return etags;
  }

  async function registerEtags(
    video: CreatedVideo,
    completedParts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    await postPartUrls(video, { completedParts }).expect(200);
  }

  async function sendAndRegister(
    video: CreatedVideo,
    partNumbers: number[],
  ): Promise<void> {
    const etags = await sendParts(video, partNumbers);
    await registerEtags(
      video,
      partNumbers.map((partNumber, index) => ({
        partNumber,
        etag: etags[index],
      })),
    );
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  async function storedParts(sessionId: string): Promise<UploadPart[]> {
    return dataSource.getRepository(UploadPart).find({
      where: { upload_session_id: sessionId },
      order: { part_number: 'ASC' },
    });
  }

  describe('1. Conferência do arquivo na retomada', () => {
    it('1.1 retomada-sem-partes-recebidas-aceita-lista-vazia', async () => {
      const video = await createVideo();

      const res = await postFileVerifications(video, { parts: [] }).expect(200);

      expect(res.body).toEqual({ result: 'match', verifiedParts: 0 });
      await expect(storedSession(video.sessionId)).resolves.toMatchObject({
        status: 'active',
        file_mismatch_at: null,
      });
      await postPartUrls(video, {
        parts: recalculated(fileA, [1]),
      }).expect(200);
    });

    it('1.2 checksums-iguais-confirmam-o-mesmo-arquivo', async () => {
      const video = await createVideo();
      const etags = await sendParts(video, [1, 2]);
      await registerEtags(video, [{ partNumber: 1, etag: etags[0] }]);
      const states = uploadSessionBody(
        await getSession(video).expect(200),
      ).parts.map((part) => part.state);
      expect(states).toEqual(['confirmed', 'unregistered', 'missing']);

      const res = await postFileVerifications(video, {
        parts: recalculated(fileA, [1, 2]),
      }).expect(200);

      expect(res.body).toEqual({ result: 'match', verifiedParts: 2 });
    });

    it('1.3 parte-confirmada-faltando-retorna-400', async () => {
      const video = await createVideo();
      await sendAndRegister(video, [1, 2]);

      const res = await postFileVerifications(video, {
        parts: recalculated(fileA, [1]),
      }).expect(400);

      expect(errorBody(res).error).toBe('UPLOAD_VERIFICATION_INCOMPLETE');
      await expect(storedSession(video.sessionId)).resolves.toMatchObject({
        file_mismatch_at: null,
      });
    });
  });

  describe('2. Arquivo trocado na retomada (T-06, detecção)', () => {
    it('2.1 arquivo-com-um-byte-alterado-bloqueia-a-sessao', async () => {
      expect(checksumOf(fileA2, 1)).not.toBe(checksumOf(fileA, 1));
      expect(checksumOf(fileA2, 2)).toBe(checksumOf(fileA, 2));
      const video = await createVideo();
      await sendAndRegister(video, [1, 2]);
      const states = uploadSessionBody(
        await getSession(video).expect(200),
      ).parts.map((part) => part.state);
      expect(states).toEqual(['confirmed', 'confirmed', 'missing']);

      const res = await postFileVerifications(video, {
        parts: recalculated(fileA2, [1, 2]),
      }).expect(409);

      expect(errorBody(res).error).toBe('UPLOAD_FILE_MISMATCH');
      const session = await storedSession(video.sessionId);
      expect(session.file_mismatch_at).toBeInstanceOf(Date);
      expect(
        (await storedParts(video.sessionId)).map(
          (part) => part.checksum_sha256,
        ),
      ).toEqual([checksumOf(fileA, 1), checksumOf(fileA, 2)]);
      expect(
        uploadSessionBody(await getSession(video).expect(200)).fileMismatch,
      ).toBe(true);

      const signing = await postPartUrls(video, {
        parts: recalculated(fileA2, [3]),
      }).expect(409);
      expect(errorBody(signing).error).toBe('UPLOAD_FILE_MISMATCH');
      await expect(storedParts(video.sessionId)).resolves.toHaveLength(2);
    });
  });

  /*
   * Outside the spec: the structural validation of the body (SI-03.15, action 1), including the
   * protection against nested arrays found in the review of SI-03.13. Each body is refused with
   * 400 and leaves the registry and the session as they were.
   */
  describe('Validação do corpo: 400 sem alterar dados', () => {
    let video: CreatedVideo;

    beforeEach(async () => {
      video = await createVideo();
      await sendAndRegister(video, [1, 2]);
    });

    async function snapshot() {
      const session = await storedSession(video.sessionId);
      return {
        fileMismatchAt: session.file_mismatch_at,
        parts: (await storedParts(video.sessionId)).map((part) => ({
          partNumber: part.part_number,
          checksum: part.checksum_sha256,
          etag: part.etag,
          etagRegisteredAt: part.etag_registered_at,
        })),
      };
    }

    const changedPart1 = () => recalculated(fileA2, [1])[0];
    const validPart = (partNumber: number) =>
      recalculated(fileA, [partNumber])[0];

    it.each<[string, () => unknown]>([
      ['sem parts', () => ({})],
      ['parts nulo', () => ({ parts: null })],
      ['parts que não é array', () => ({ parts: changedPart1() })],
      ['item que é array vazio', () => ({ parts: [[]] })],
      [
        'array aninhado com objeto válido do arquivo alterado',
        () => ({ parts: [[changedPart1()], validPart(2)] }),
      ],
      ['item nulo', () => ({ parts: [null] })],
      [
        'partNumber repetido',
        () => ({ parts: [validPart(1), validPart(1), validPart(2)] }),
      ],
      [
        'mais de 150 itens',
        () => {
          const checksumSha256 = checksumOf(fileA, 1);
          return {
            parts: Array.from({ length: 151 }, (_, index) => ({
              partNumber: index + 1,
              checksumSha256,
            })),
          };
        },
      ],
      [
        'checksum sem o padding',
        () => ({
          parts: [
            {
              partNumber: 1,
              checksumSha256: changedPart1().checksumSha256.slice(0, 43),
            },
            validPart(2),
          ],
        }),
      ],
      [
        'partNumber zero',
        () => ({ parts: [{ ...changedPart1(), partNumber: 0 }] }),
      ],
      [
        'partNumber em texto',
        () => ({ parts: [{ ...changedPart1(), partNumber: '1' }] }),
      ],
      [
        'propriedade desconhecida',
        () => ({ parts: [changedPart1(), validPart(2)], extra: true }),
      ],
    ])('%s', async (_, body) => {
      const before = await snapshot();

      const res = await postFileVerifications(video, body()).expect(400);

      expect(errorBody(res).error).toBe('VALIDATION_ERROR');
      await expect(snapshot()).resolves.toEqual(before);
      expect(before.fileMismatchAt).toBeNull();
    });

    it('pedido válido continua funcionando depois dos inválidos', async () => {
      await postFileVerifications(video, { parts: [[changedPart1()]] }).expect(
        400,
      );

      const res = await postFileVerifications(video, {
        parts: recalculated(fileA, [1, 2]),
      }).expect(200);

      expect(res.body).toEqual({ result: 'match', verifiedParts: 2 });
      await expect(storedSession(video.sessionId)).resolves.toMatchObject({
        file_mismatch_at: null,
      });
    });
  });
});
