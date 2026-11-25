import { randomBytes } from 'node:crypto';
import {
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request, { type Test as SupertestRequest } from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { gate } from '../src/test/locks';
import {
  realCompleteMultipartUpload,
  requestPresignedUrl,
  sha256Base64,
} from '../src/test/storage';
import { UploadPart } from '../src/videos/entities/upload-part.entity';
import { UploadSession } from '../src/videos/entities/upload-session.entity';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_QUEUES } from '../src/videos/videos.constants';
import { registerConfirmedUser } from './helpers/auth';
import { VideoQueuesControl } from './helpers/queues';
import {
  errorBody,
  partUrlsBody,
  uploadSessionBody,
  videoUploadSessionBody,
} from './helpers/response-bodies';
import {
  blockSessionByFileMismatch,
  closeVideoFixtureContext,
  createVideoFixtureContext,
  removeVideoStorage,
  type VideoFixtureContext,
} from './helpers/video-fixtures';

jest.setTimeout(60_000);

/** 5 MiB, the minimum part of the S3, so each file has few parts (TD-15). */
const PART_SIZE = 5_242_880;
const PART_SIZE_ENV = 'UPLOAD_PART_SIZE_BYTES';
/** Two parts: 5 MiB and a remainder of 1 MiB. */
const FILE_SIZE = PART_SIZE + 1_048_576;

interface CompletionBody {
  publicId: string;
  status: string;
}

describe('POST /videos/:publicId/upload-sessions/:sessionId/completion (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queues: VideoQueuesControl;
  let fixtures: VideoFixtureContext;
  let ownerToken: string;
  let userCounter = 0;
  /** Value of UPLOAD_PART_SIZE_BYTES before the suite, restored in `afterAll`. */
  let previousPartSize: string | undefined;
  const file = randomBytes(FILE_SIZE);

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
    // Listening once, on an ephemeral local port, keeps supertest from opening and closing the
    // server per request: the request that opened it would only finish after `server.close()`,
    // which waits for every connection, including a concurrent request held at a barrier (2.2).
    await app.listen(0, '127.0.0.1');

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
    // The queues are paused and idle, and the jobs of video-processing removed, before any data.
    await queues.prepareScenario();
    await removeStorageOfAllVideos();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const run = `${process.pid}_${++userCounter}`;
    ownerToken = await registerConfirmedUser(
      app,
      `completion_owner_${run}@example.com`,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function removeStorageOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
      await removeVideoStorage(fixtures, video.id);
    }
  }

  interface CreatedVideo {
    publicId: string;
    sessionId: string;
    videoId: string;
  }

  function partOf(partNumber: number): Buffer {
    return file.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE);
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
    expect(body.uploadSession.partCount).toBe(2);
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: body.publicId });
    return {
      publicId: body.publicId,
      sessionId: body.uploadSession.id,
      videoId: video.id,
    };
  }

  function sessionPath(video: CreatedVideo): string {
    return `/videos/${video.publicId}/upload-sessions/${video.sessionId}`;
  }

  function postCompletion(video: CreatedVideo): SupertestRequest {
    return request(app.getHttpServer())
      .post(`${sessionPath(video)}/completion`)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  function postPartUrls(video: CreatedVideo, body: object): SupertestRequest {
    return request(app.getHttpServer())
      .post(`${sessionPath(video)}/part-urls`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body);
  }

  /** Signs and sends the parts through the URLs of the response; returns their ETags. */
  async function sendParts(
    video: CreatedVideo,
    partNumbers: number[],
  ): Promise<string[]> {
    const signed = partUrlsBody(
      await postPartUrls(video, {
        parts: partNumbers.map((partNumber) => ({
          partNumber,
          checksumSha256: sha256Base64(partOf(partNumber)),
        })),
      }).expect(200),
    ).parts;
    const etags: string[] = [];
    for (const part of signed) {
      const put = await requestPresignedUrl(part.url, {
        method: part.method,
        headers: part.headers,
        body: partOf(part.partNumber),
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

  /** Creates the video and sends and registers both parts. */
  async function readyVideo(): Promise<CreatedVideo> {
    const video = await createVideo();
    const etags = await sendParts(video, [1, 2]);
    await registerEtags(video, [
      { partNumber: 1, etag: etags[0] },
      { partNumber: 2, etag: etags[1] },
    ]);
    return video;
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  async function storedVideo(videoId: string): Promise<Video> {
    return dataSource.getRepository(Video).findOneByOrFail({ id: videoId });
  }

  /** Jobs of `video-processing` for the executions of the video. */
  async function jobIdsOf(videoId: string): Promise<string[]> {
    const jobs = await queues.processing.getJobs();
    return jobs
      .map((job) => job.id ?? '')
      .filter((id) => id.startsWith(`video-${videoId}-`));
  }

  function body(res: request.Response): CompletionBody {
    return res.body as CompletionBody;
  }

  /** The video did not move, and no job was created for it. */
  async function expectNoTransition(video: CreatedVideo): Promise<void> {
    await expect(storedVideo(video.videoId)).resolves.toMatchObject({
      status: 'draft',
      processing_run: 0,
      original_key: null,
    });
    await expect(jobIdsOf(video.videoId)).resolves.toEqual([]);
  }

  /**
   * Holds each call of the real `completeMultipartUpload` until the test releases it, in the order
   * of the calls, after the claim and the conference of that call.
   */
  function holdCompletes(count: number) {
    const storage = app.get(StorageService);
    const arrivals = Array.from({ length: count }, () => gate());
    const releases = Array.from({ length: count }, () => gate());
    let calls = 0;
    jest
      .spyOn(storage, 'completeMultipartUpload')
      .mockImplementation(async (key, uploadId, parts) => {
        const index = calls++;
        if (index < count) {
          arrivals[index].open();
          await releases[index].opened;
        }
        return realCompleteMultipartUpload(storage, key, uploadId, parts);
      });
    return {
      /**
       * Waits for call `index` to reach the barrier. If its request answers first, the test fails
       * with that answer instead of waiting forever.
       */
      arrived: async (
        index: number,
        pending: Promise<request.Response>,
      ): Promise<void> => {
        const answered = pending.then((res) => {
          throw new Error(
            `Call ${index} answered ${res.status} before the barrier: ${JSON.stringify(res.body)}`,
          );
        });
        // An answer after the arrival is expected; only the race below reports an early one.
        void answered.catch(() => undefined);
        await Promise.race([arrivals[index].opened, answered]);
      },
      release: (index: number) => releases[index].open(),
      releaseAll: () => releases.forEach((release) => release.open()),
    };
  }

  describe('1. Conclusão bem-sucedida', () => {
    it('1.1 conclusao-publica-a-geracao-1-e-grava-o-original', async () => {
      const video = await readyVideo();

      const res = await postCompletion(video).expect(202);

      expect(body(res)).toEqual({
        publicId: video.publicId,
        status: 'processing',
      });
      const session = await storedSession(video.sessionId);
      expect(session.status).toBe('completed');
      const stored = await storedVideo(video.videoId);
      expect(stored).toMatchObject({
        status: 'processing',
        processing_run: 1,
        processing_dispatch: 1,
        pending_job_action: null,
        original_key: session.object_key,
      });
      const job = await queues.processing.getJob(`video-${video.videoId}-1-1`);
      expect(job).toBeDefined();
      expect(job?.opts).toMatchObject({
        removeOnComplete: false,
        removeOnFail: false,
      });
      expect(['active', 'completed', 'failed']).not.toContain(
        await job?.getState(),
      );
      const head = await fixtures.s3.send(
        new HeadObjectCommand({
          Bucket: fixtures.bucket,
          Key: stored.original_key ?? '',
        }),
      );
      expect(head.ContentLength).toBe(FILE_SIZE);
    });

    it('1.2 repeticao-depois-do-sucesso-retorna-200-sem-novo-job', async () => {
      const video = await readyVideo();
      await postCompletion(video).expect(202);

      const res = await postCompletion(video).expect(200);

      expect(body(res)).toEqual({
        publicId: video.publicId,
        status: 'processing',
      });
      await expect(storedVideo(video.videoId)).resolves.toMatchObject({
        processing_run: 1,
      });
      const jobs = await jobIdsOf(video.videoId);
      expect(
        jobs.filter((id) => id.startsWith(`video-${video.videoId}-1-`)),
      ).toHaveLength(1);
      expect(jobs).toHaveLength(1);
    });

    it('1.3 complete-ja-feito-no-storage-conclui-com-202', async () => {
      const video = await readyVideo();
      const session = await storedSession(video.sessionId);
      const registered = await dataSource.getRepository(UploadPart).find({
        where: { upload_session_id: video.sessionId },
        order: { part_number: 'ASC' },
      });
      await fixtures.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: fixtures.bucket,
          Key: session.object_key,
          UploadId: session.upload_id ?? '',
          MultipartUpload: {
            Parts: registered.map((part) => ({
              PartNumber: part.part_number,
              ETag: part.etag ?? '',
              ChecksumSHA256: part.checksum_sha256,
            })),
          },
        }),
      );

      const res = await postCompletion(video).expect(202);

      expect(body(res).status).toBe('processing');
      const stored = await storedVideo(video.videoId);
      expect(stored.original_key).toBe(session.object_key);
      const head = await fixtures.s3.send(
        new HeadObjectCommand({
          Bucket: fixtures.bucket,
          Key: session.object_key,
        }),
      );
      expect(head.ContentLength).toBe(FILE_SIZE);
    });
  });

  describe('2. Conclusões concorrentes', () => {
    it('2.1 duas-conclusoes-em-paralelo-fazem-uma-unica-transicao', async () => {
      const video = await readyVideo();

      const responses = await Promise.all([
        postCompletion(video).then((res) => res),
        postCompletion(video).then((res) => res),
      ]);

      const statuses = responses.map((res) => res.status).sort();
      expect(statuses.filter((status) => status === 202)).toHaveLength(1);
      const other = responses.find((res) => res.status !== 202);
      if (other?.status === 409) {
        expect(errorBody(other).error).toBe('UPLOAD_SESSION_COMPLETING');
      } else {
        expect(other?.status).toBe(200);
      }
      await expect(storedVideo(video.videoId)).resolves.toMatchObject({
        processing_run: 1,
      });
      await expect(jobIdsOf(video.videoId)).resolves.toEqual([
        `video-${video.videoId}-1-1`,
      ]);
    });

    it('2.2 chamada-que-perde-a-posse-retorna-409-e-nunca-200', async () => {
      const video = await readyVideo();
      const barrier = holdCompletes(2);
      try {
        const first = postCompletion(video).then((res) => res);
        await barrier.arrived(0, first);
        const claimedByFirst = await storedSession(video.sessionId);
        expect(claimedByFirst.status).toBe('completing');
        expect(claimedByFirst.claim_token).toEqual(expect.any(String));

        await dataSource.query(
          `UPDATE upload_sessions SET claim_expires_at = now() - interval '1 second' WHERE id = $1`,
          [video.sessionId],
        );
        const second = postCompletion(video).then((res) => res);
        await barrier.arrived(1, second);
        const claimedBySecond = await storedSession(video.sessionId);
        expect(claimedBySecond.status).toBe('completing');
        expect(claimedBySecond.claim_token).toEqual(expect.any(String));
        expect(claimedBySecond.claim_token).not.toBe(
          claimedByFirst.claim_token,
        );

        barrier.release(0);
        const firstResponse = await first;
        expect(firstResponse.status).toBe(409);
        expect(errorBody(firstResponse).error).toBe(
          'UPLOAD_SESSION_COMPLETING',
        );

        barrier.release(1);
        const secondResponse = await second;
        expect(secondResponse.status).toBe(202);
      } finally {
        barrier.releaseAll();
      }

      await expect(storedVideo(video.videoId)).resolves.toMatchObject({
        processing_run: 1,
      });
      await expect(jobIdsOf(video.videoId)).resolves.toEqual([
        `video-${video.videoId}-1-1`,
      ]);
    });
  });

  describe('3. Falhas, bloqueio e publicação', () => {
    it('3.1 parte-sem-etag-registrado-retorna-409-incomplete', async () => {
      const video = await createVideo();
      const etags = await sendParts(video, [1, 2]);
      await registerEtags(video, [{ partNumber: 1, etag: etags[0] }]);
      const states = uploadSessionBody(
        await request(app.getHttpServer())
          .get(sessionPath(video))
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200),
      ).parts.map((part) => part.state);
      expect(states).toEqual(['confirmed', 'unregistered']);

      const res = await postCompletion(video).expect(409);

      expect(errorBody(res).error).toBe('UPLOAD_INCOMPLETE');
      await expect(storedSession(video.sessionId)).resolves.toMatchObject({
        status: 'active',
        claim_token: null,
      });
      await expectNoTransition(video);
    });

    it('3.2 falha-na-publicacao-deixa-a-acao-pendente', async () => {
      const video = await readyVideo();
      const queue = app.get<Queue>(getQueueToken(VIDEO_QUEUES.PROCESSING));
      jest
        .spyOn(queue, 'add')
        .mockRejectedValueOnce(new Error('Connection is closed.'));

      const res = await postCompletion(video).expect(202);

      expect(body(res).status).toBe('processing');
      const stored = await storedVideo(video.videoId);
      expect(stored).toMatchObject({
        status: 'processing',
        pending_job_action: 'publish',
        pending_job_dispatch: 1,
      });
      expect(stored.pending_job_token).toEqual(expect.any(String));
      await expect(
        queues.processing.getJob(`video-${video.videoId}-1-1`),
      ).resolves.toBeUndefined();
    });

    it('3.3 sessao-bloqueada-por-conferencia-reprovada-retorna-409', async () => {
      const video = await readyVideo();
      await blockSessionByFileMismatch(fixtures, video.sessionId);

      const res = await postCompletion(video).expect(409);

      expect(errorBody(res).error).toBe('UPLOAD_FILE_MISMATCH');
      const session = await storedSession(video.sessionId);
      expect(session.status).toBe('active');
      expect(session.file_mismatch_at).toBeInstanceOf(Date);
      await expectNoTransition(video);
      const listed = await fixtures.s3.send(
        new ListPartsCommand({
          Bucket: fixtures.bucket,
          Key: session.object_key,
          UploadId: session.upload_id ?? '',
        }),
      );
      expect(listed.Parts).toHaveLength(2);
    });
  });
});
