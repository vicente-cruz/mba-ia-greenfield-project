import { randomBytes, randomUUID } from 'node:crypto';
import { ListPartsCommand } from '@aws-sdk/client-s3';
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
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { gate } from '../src/test/locks';
import {
  realCompleteMultipartUpload,
  realCreateMultipartUpload,
  requestPresignedUrl,
  sha256Base64,
} from '../src/test/storage';
import { User } from '../src/users/entities/user.entity';
import {
  UploadSession,
  UploadSessionStatus,
} from '../src/videos/entities/upload-session.entity';
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
/** One part of 1 MiB, for the scenarios that only need a session. */
const SMALL_FILE = 1_048_576;
/** File A of the T-06 flow: two parts of 5 MiB and a remainder of 1 MiB. */
const FILE_A_SIZE = 2 * PART_SIZE + 1_048_576;

interface CreatedVideo {
  publicId: string;
  sessionId: string;
}

describe('POST /videos/:publicId/upload-sessions (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queues: VideoQueuesControl;
  let fixtures: VideoFixtureContext;
  let ownerEmail: string;
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
    // Listening once, on an ephemeral local port, keeps supertest from opening and closing the
    // server per request: the request that opened it would only finish after `server.close()`,
    // which waits for every connection, including a request held at a barrier (SI-03.16).
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
    // The queues are paused and idle before any data is removed: neither the worker nor the
    // sweep acts on the states prepared by the scenarios.
    await queues.prepareScenario();
    await removeStorageOfAllVideos();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const run = `${process.pid}_${++userCounter}`;
    ownerEmail = `restart_owner_${run}@example.com`;
    ownerToken = await registerConfirmedUser(app, ownerEmail);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function removeStorageOfAllVideos(): Promise<void> {
    for (const video of await dataSource.getRepository(Video).find()) {
      await removeVideoStorage(fixtures, video.id);
    }
  }

  function authorized(test: SupertestRequest): SupertestRequest {
    return test.set('Authorization', `Bearer ${ownerToken}`);
  }

  function postVideo(sizeBytes = SMALL_FILE): SupertestRequest {
    return authorized(request(app.getHttpServer()).post('/videos')).send({
      fileName: 'video.mp4',
      sizeBytes,
      contentType: 'video/mp4',
    });
  }

  async function createVideo(sizeBytes = SMALL_FILE): Promise<CreatedVideo> {
    const body = videoUploadSessionBody(await postVideo(sizeBytes).expect(201));
    expect(body.uploadSession.partSize).toBe(PART_SIZE);
    return { publicId: body.publicId, sessionId: body.uploadSession.id };
  }

  function postRestart(
    publicId: string,
    declaration: object = {
      fileName: 'again.mp4',
      sizeBytes: SMALL_FILE,
      contentType: 'video/mp4',
    },
  ): SupertestRequest {
    return authorized(
      request(app.getHttpServer()).post(`/videos/${publicId}/upload-sessions`),
    ).send(declaration);
  }

  function sessionPath(video: CreatedVideo): string {
    return `/videos/${video.publicId}/upload-sessions/${video.sessionId}`;
  }

  function postPartUrls(video: CreatedVideo, body: object): SupertestRequest {
    return authorized(
      request(app.getHttpServer()).post(`${sessionPath(video)}/part-urls`),
    ).send(body);
  }

  function postCompletion(video: CreatedVideo): SupertestRequest {
    return authorized(
      request(app.getHttpServer()).post(`${sessionPath(video)}/completion`),
    );
  }

  /** Signs and sends the parts of `file`; registers their ETags when `register`. */
  async function sendParts(
    video: CreatedVideo,
    file: Buffer,
    partNumbers: number[],
    register = true,
  ): Promise<void> {
    const partOf = (partNumber: number) =>
      file.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE);
    const signed = partUrlsBody(
      await postPartUrls(video, {
        parts: partNumbers.map((partNumber) => ({
          partNumber,
          checksumSha256: sha256Base64(partOf(partNumber)),
        })),
      }).expect(200),
    ).parts;
    const completedParts: { partNumber: number; etag: string }[] = [];
    for (const part of signed) {
      const put = await requestPresignedUrl(part.url, {
        method: part.method,
        headers: part.headers,
        body: partOf(part.partNumber),
      });
      expect(put.status).toBe(200);
      completedParts.push({
        partNumber: part.partNumber,
        etag: put.headers.etag as string,
      });
    }
    if (register) {
      await postPartUrls(video, { completedParts }).expect(200);
    }
  }

  async function storedSession(sessionId: string): Promise<UploadSession> {
    return dataSource
      .getRepository(UploadSession)
      .findOneByOrFail({ id: sessionId });
  }

  async function videoOf(publicId: string): Promise<Video> {
    return dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
  }

  async function sessionsOf(publicId: string): Promise<UploadSession[]> {
    const video = await videoOf(publicId);
    return dataSource.getRepository(UploadSession).find({
      where: { video_id: video.id },
      order: { created_at: 'ASC' },
    });
  }

  async function listPartsOf(session: UploadSession): Promise<string> {
    try {
      await fixtures.s3.send(
        new ListPartsCommand({
          Bucket: fixtures.bucket,
          Key: session.object_key,
          UploadId: session.upload_id ?? '',
        }),
      );
      return 'found';
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchUpload') {
        return 'NoSuchUpload';
      }
      throw error;
    }
  }

  async function takeOverInDatabase(sessionId: string): Promise<void> {
    await dataSource.query(
      `UPDATE upload_sessions
          SET status = 'aborting', claim_token = $2,
              claim_expires_at = now() + interval '5 minutes'
        WHERE id = $1`,
      [sessionId, randomUUID()],
    );
  }

  /**
   * Holds the first call of a real StorageService method until the test releases it; later calls
   * go straight to the storage. `arrived` fails with the answer of the held request when it
   * answers before reaching the barrier.
   */
  function holdFirst(
    method: 'createMultipartUpload' | 'completeMultipartUpload',
  ) {
    const storage = app.get(StorageService);
    const arrival = gate();
    const release = gate();
    let calls = 0;
    const hold = async () => {
      if (calls++ === 0) {
        arrival.open();
        await release.opened;
      }
    };
    if (method === 'createMultipartUpload') {
      jest
        .spyOn(storage, 'createMultipartUpload')
        .mockImplementation(async (key, options) => {
          await hold();
          return realCreateMultipartUpload(storage, key, options);
        });
    } else {
      jest
        .spyOn(storage, 'completeMultipartUpload')
        .mockImplementation(async (key, uploadId, parts) => {
          await hold();
          return realCompleteMultipartUpload(storage, key, uploadId, parts);
        });
    }
    return {
      arrived: async (pending: Promise<request.Response>): Promise<void> => {
        const answered = pending.then((res) => {
          throw new Error(
            `The held request answered ${res.status} before the barrier: ${JSON.stringify(res.body)}`,
          );
        });
        // An answer after the arrival is expected; only the race below reports an early one.
        void answered.catch(() => undefined);
        await Promise.race([arrival.opened, answered]);
      },
      release: () => release.open(),
    };
  }

  describe('1. Reinício de rascunho', () => {
    it('1.1 reinicio-com-sessao-ativa-cria-nova-sessao-e-aborta-a-anterior', async () => {
      const video = await createVideo();
      await sendParts(video, randomBytes(SMALL_FILE), [1], false);
      const first = await storedSession(video.sessionId);

      const res = await postRestart(video.publicId).expect(201);

      const body = videoUploadSessionBody(res);
      expect(body.publicId).toBe(video.publicId);
      expect(body.status).toBe('draft');
      expect(body.uploadSession.id).not.toBe(video.sessionId);
      expect(body.uploadSession.status).toBe('active');
      const restarted = await storedSession(body.uploadSession.id);
      expect(restarted.object_key).not.toBe(first.object_key);
      await expect(videoOf(video.publicId)).resolves.toMatchObject({
        current_upload_session_id: body.uploadSession.id,
        original_filename: 'again.mp4',
      });
      await expect(storedSession(video.sessionId)).resolves.toMatchObject({
        status: 'aborted',
      });
      await expect(listPartsOf(first)).resolves.toBe('NoSuchUpload');
    });

    it('1.2 rascunho-com-sessao-expirada-reinicia', async () => {
      const video = await createVideo();
      await dataSource.query(
        `UPDATE upload_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [video.sessionId],
      );

      const res = await postRestart(video.publicId).expect(201);

      expect(videoUploadSessionBody(res).uploadSession.status).toBe('active');
      await expect(videoOf(video.publicId)).resolves.toMatchObject({
        status: 'draft',
      });
      await expect(storedSession(video.sessionId)).resolves.toMatchObject({
        status: 'aborted',
      });
    });

    it('1.3 video-fora-de-rascunho-retorna-409', async () => {
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
        original_key: session.object_key,
        current_upload_session_id: session.id,
      });

      const res = await postRestart(video.public_id).expect(409);

      expect(errorBody(res).error).toBe('VIDEO_INVALID_STATE');
      await expect(sessionsOf(video.public_id)).resolves.toHaveLength(1);
      await expect(videoOf(video.public_id)).resolves.toMatchObject({
        status: 'processing',
      });
    });

    it('1.4 rascunho-deixado-por-ativacao-que-perdeu-a-posse-aceita-reinicio', async () => {
      /** POST /videos held before its Create while the sweep takes S1 over; it answers 503. */
      const createLosingTheActivation = async (): Promise<CreatedVideo> => {
        const barrier = holdFirst('createMultipartUpload');
        const creation = postVideo().then((res) => res);
        try {
          await barrier.arrived(creation);
          const [video] = await dataSource
            .getRepository(Video)
            .find({ order: { created_at: 'DESC' }, take: 1 });
          await takeOverInDatabase(video.current_upload_session_id ?? '');
          barrier.release();
          const res = await creation;
          expect(res.status).toBe(503);
          expect(errorBody(res).error).toBe('STORAGE_UNAVAILABLE');
          const left = await videoOf(video.public_id);
          expect(left.status).toBe('draft');
          await expect(
            storedSession(left.current_upload_session_id ?? ''),
          ).resolves.toMatchObject({ status: 'aborting' });
          return {
            publicId: video.public_id,
            sessionId: left.current_upload_session_id ?? '',
          };
        } finally {
          barrier.release();
          await Promise.allSettled([creation]);
          jest.restoreAllMocks();
        }
      };

      // S1 still aborting, within the claim of the sweep.
      const aborting = await createLosingTheActivation();
      const restarted = videoUploadSessionBody(
        await postRestart(aborting.publicId).expect(201),
      );
      expect(restarted.uploadSession.id).not.toBe(aborting.sessionId);
      expect(restarted.uploadSession.status).toBe('active');
      await expect(videoOf(aborting.publicId)).resolves.toMatchObject({
        current_upload_session_id: restarted.uploadSession.id,
      });

      // S1 already aborted, as the sweep leaves it when it concludes.
      const aborted = await createLosingTheActivation();
      await dataSource.query(
        `UPDATE upload_sessions SET status = 'aborted', claim_token = NULL, claim_expires_at = NULL WHERE id = $1`,
        [aborted.sessionId],
      );
      const res = await postRestart(aborted.publicId).expect(201);
      expect(videoUploadSessionBody(res).uploadSession.status).toBe('active');
    });
  });

  describe('2. Reinícios e conclusão concorrentes (intercalação controlada)', () => {
    it('2.1 segundo-reinicio-durante-a-retencao-recebe-409-initiating', async () => {
      const video = await createVideo();
      const barrier = holdFirst('createMultipartUpload');
      const first = postRestart(video.publicId).then((res) => res);
      try {
        await barrier.arrived(first);
        const current = await videoOf(video.publicId);
        const held = await storedSession(
          current.current_upload_session_id ?? '',
        );
        expect(held.id).not.toBe(video.sessionId);
        expect(held.status).toBe('initiating');
        const [{ claimInFuture }] = await dataSource.query<
          { claimInFuture: boolean }[]
        >(
          `SELECT claim_expires_at > now() AS "claimInFuture" FROM upload_sessions WHERE id = $1`,
          [held.id],
        );
        expect(claimInFuture).toBe(true);

        const second = await postRestart(video.publicId).expect(409);
        expect(errorBody(second).error).toBe('UPLOAD_SESSION_INITIATING');

        barrier.release();
        const firstResponse = await first;
        expect(firstResponse.status).toBe(201);
        expect(videoUploadSessionBody(firstResponse).uploadSession.id).toBe(
          held.id,
        );
      } finally {
        barrier.release();
        await Promise.allSettled([first]);
      }

      const active = (await sessionsOf(video.publicId)).filter(
        (session) => session.status === UploadSessionStatus.ACTIVE,
      );
      expect(active).toHaveLength(1);
    });

    it('2.2 reinicio-depois-da-ativacao-e-legitimo', async () => {
      const video = await createVideo();

      const first = videoUploadSessionBody(
        await postRestart(video.publicId).expect(201),
      );
      expect(first.uploadSession.status).toBe('active');
      const second = videoUploadSessionBody(
        await postRestart(video.publicId).expect(201),
      );

      expect(second.uploadSession.id).not.toBe(first.uploadSession.id);
      await expect(
        storedSession(first.uploadSession.id),
      ).resolves.toMatchObject({ status: 'aborted' });
      const active = (await sessionsOf(video.publicId)).filter(
        (session) => session.status === UploadSessionStatus.ACTIVE,
      );
      expect(active.map((session) => session.id)).toEqual([
        second.uploadSession.id,
      ]);
    });

    it('2.3 reinicio-e-conclusao-concorrentes-tem-um-unico-vencedor', async () => {
      // Order A: the completion claims first and is held before its Complete.
      const videoA = await createVideo();
      await sendParts(videoA, randomBytes(SMALL_FILE), [1]);
      const completeBarrier = holdFirst('completeMultipartUpload');
      const completion = postCompletion(videoA).then((res) => res);
      try {
        await completeBarrier.arrived(completion);
        const restart = await postRestart(videoA.publicId).expect(409);
        expect(errorBody(restart).error).toBe('UPLOAD_SESSION_COMPLETING');
        completeBarrier.release();
        expect((await completion).status).toBe(202);
      } finally {
        completeBarrier.release();
        await Promise.allSettled([completion]);
        jest.restoreAllMocks();
      }
      await expect(sessionsOf(videoA.publicId)).resolves.toHaveLength(1);
      await expect(videoOf(videoA.publicId)).resolves.toMatchObject({
        status: 'processing',
        processing_run: 1,
      });

      // Order B: the restart claims first and is held after T1.
      const videoB = await createVideo();
      await sendParts(videoB, randomBytes(SMALL_FILE), [1]);
      const createBarrier = holdFirst('createMultipartUpload');
      const restart = postRestart(videoB.publicId).then((res) => res);
      try {
        await createBarrier.arrived(restart);
        await expect(storedSession(videoB.sessionId)).resolves.toMatchObject({
          status: 'aborting',
        });
        const refused = await postCompletion(videoB).expect(409);
        expect(errorBody(refused).error).toBe('UPLOAD_SESSION_NOT_ACTIVE');
        createBarrier.release();
        expect((await restart).status).toBe(201);
      } finally {
        createBarrier.release();
        await Promise.allSettled([restart]);
      }
      await expect(videoOf(videoB.publicId)).resolves.toMatchObject({
        status: 'draft',
        processing_run: 0,
      });
      await expect(storedSession(videoB.sessionId)).resolves.toMatchObject({
        status: 'aborted',
      });
      const jobs = await queues.processing.getJobs();
      const videoBId = (await videoOf(videoB.publicId)).id;
      expect(jobs.filter((job) => job.id?.includes(videoBId))).toEqual([]);
    });
  });

  describe('3. Arquivo trocado na retomada (T-06, fluxo completo)', () => {
    it('3.1 conferencia-reprovada-bloqueia-a-conclusao-ate-o-reinicio-explicito', async () => {
      const fileA = randomBytes(FILE_A_SIZE);
      const fileA2 = Buffer.from(fileA);
      fileA2[1_000] = fileA2[1_000] ^ 0xff;
      const checksumOf = (file: Buffer, partNumber: number) =>
        sha256Base64(
          file.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE),
        );
      const video = await createVideo(FILE_A_SIZE);
      await sendParts(video, fileA, [1, 2]);

      // The resumption with A' fails the file verification and blocks S1.
      const verification = await authorized(
        request(app.getHttpServer()).post(
          `${sessionPath(video)}/file-verifications`,
        ),
      )
        .send({
          parts: [1, 2].map((partNumber) => ({
            partNumber,
            checksumSha256: checksumOf(fileA2, partNumber),
          })),
        })
        .expect(409);
      expect(errorBody(verification).error).toBe('UPLOAD_FILE_MISMATCH');
      const blocked = await storedSession(video.sessionId);
      expect(blocked.file_mismatch_at).toBeInstanceOf(Date);

      // The completion stays blocked.
      const completion = await postCompletion(video).expect(409);
      expect(errorBody(completion).error).toBe('UPLOAD_FILE_MISMATCH');
      await expect(videoOf(video.publicId)).resolves.toMatchObject({
        status: 'draft',
        processing_run: 0,
      });
      await expect(queues.processing.getJobs()).resolves.toEqual([]);

      // Only the explicit restart, declaring A', continues the upload.
      const restarted = videoUploadSessionBody(
        await postRestart(video.publicId, {
          fileName: 'a-prime.mp4',
          sizeBytes: FILE_A_SIZE,
          contentType: 'video/mp4',
        }).expect(201),
      );
      expect(restarted.uploadSession.status).toBe('active');
      const newSession: CreatedVideo = {
        publicId: video.publicId,
        sessionId: restarted.uploadSession.id,
      };
      const state = uploadSessionBody(
        await authorized(
          request(app.getHttpServer()).get(sessionPath(newSession)),
        ).expect(200),
      );
      expect(state.fileMismatch).toBe(false);
      await expect(storedSession(video.sessionId)).resolves.toMatchObject({
        status: 'aborted',
      });
      await postPartUrls(newSession, {
        parts: [{ partNumber: 1, checksumSha256: checksumOf(fileA2, 1) }],
      }).expect(200);
    });
  });
});
