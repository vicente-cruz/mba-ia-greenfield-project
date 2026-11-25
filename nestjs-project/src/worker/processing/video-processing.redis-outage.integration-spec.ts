import { spawnSync } from 'node:child_process';
import {
  createServer as createHttpServer,
  request,
  type Server,
} from 'node:http';
import {
  connect,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from 'node:net';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { createStorageClient } from '../../storage/storage.clients';
import { STORAGE_INTERNAL_CLIENT } from '../../storage/storage.constants';
import { StorageModule } from '../../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  reloadVideo,
  removeStorageOfVideos,
  saveProcessingVideo,
  thumbnailKeysOf,
  uploadOriginal,
} from '../../test/processing-fixtures';
import { gate } from '../../test/locks';
import { saveTestChannel } from '../../test/video-entity-fixtures';
import { User } from '../../users/entities/user.entity';
import { UploadPart } from '../../videos/entities/upload-part.entity';
import { UploadSession } from '../../videos/entities/upload-session.entity';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../../videos/jobs/video-job-id';
import {
  PROCESS_VIDEO_JOB_NAME,
  VIDEO_QUEUES,
} from '../../videos/videos.constants';
import { MediaProbeService } from '../media/media-probe.service';
import { MediaProcessRunner } from '../media/media-process.runner';
import { ProcessingStateService } from './processing-state.service';
import type {
  ProcessVideoResult,
  VideoProcessingProcessor as VideoProcessingProcessorType,
} from './video-processing.processor';

jest.setTimeout(90_000);

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

/**
 * Short lock and stall for the test (TD-10 asks for short values in the tests). They are read by
 * the `@Processor` decorator when the processor module is evaluated, so they are set before its
 * import in `beforeAll`.
 */
const SHORT_LOCK_ENV = {
  QUEUE_LOCK_DURATION_MS: '2000',
  QUEUE_STALLED_INTERVAL_MS: '1000',
  QUEUE_MAX_STALLED_COUNT: '1',
};
const QUEUE_PREFIX = `test-redis-outage-${process.pid}`;
const REDIS = queueConfig().redis;
/** Each request of the worker under test to the storage waits this long: its job stays active. */
const STORAGE_DELAY_MS = 3_000;

/** A TCP proxy to the Redis of the environment that the test can cut and restore. */
class RedisLink {
  private readonly sockets = new Set<Socket>();
  private down = false;
  private server!: TcpServer;
  port = 0;
  /** Connections refused or cut while the link was down. */
  refused = 0;

  async start(): Promise<void> {
    this.server = createTcpServer((client) => {
      if (this.down) {
        this.refused += 1;
        client.destroy();
        return;
      }
      const upstream = connect({ host: REDIS.host, port: REDIS.port });
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => undefined);
      }
      client.pipe(upstream).pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    this.port = (this.server.address() as { port: number }).port;
  }

  /** Redis becomes unreachable for the clients of this link: open and new connections fail. */
  cut(): void {
    this.down = true;
    this.refused += this.sockets.size;
    this.sockets.forEach((socket) => socket.destroy());
  }

  restore(): void {
    this.down = false;
  }

  close(): Promise<void> {
    this.sockets.forEach((socket) => socket.destroy());
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** An HTTP proxy to the storage that delays every request, keeping the signed Host header. */
async function startSlowStorage(): Promise<{ server: Server; port: number }> {
  const { endpoint } = storageConfig();
  const target = new URL(endpoint);
  const server = createHttpServer((req, res) => {
    setTimeout(() => {
      const upstream = request(
        {
          host: target.hostname,
          port: Number(target.port),
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', (error) => res.destroy(error));
      req.pipe(upstream);
    }, STORAGE_DELAY_MS);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
}

/** The processes of this name that are children of the test process. */
function childProcesses(name: string): string[] {
  const listed = spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], {
    encoding: 'utf8',
  }).stdout;
  return listed
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, comm]) => comm === name && Number(ppid) === process.pid)
    .map(([pid]) => pid);
}

async function waitUntil(
  description: string,
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('VideoProcessingProcessor with Redis unavailable while a job is active (integration, TD-10)', () => {
  const config = storageConfig();
  const s3 = createStorageClient(config, config.endpoint);
  let Processor: typeof VideoProcessingProcessorType;
  let link: RedisLink;
  let slowStorage: { server: Server; port: number };
  let base: TestingModule;
  let dataSource: DataSource;
  let queue: Queue<ProcessVideoJobData>;
  const modules: TestingModule[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  /** One worker of the processing, with its own connections to Redis and to the storage. */
  async function startWorker(options: {
    redis: { host: string; port: number };
    storageEndpoint: string;
  }): Promise<{
    moduleRef: TestingModule;
    processor: VideoProcessingProcessorType;
    state: ProcessingStateService;
    errors: string[];
  }> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        BullModule.forRoot({
          connection: options.redis,
          prefix: QUEUE_PREFIX,
        }),
        BullModule.registerQueue({ name: VIDEO_QUEUES.PROCESSING }),
      ],
      providers: [
        MediaProcessRunner,
        MediaProbeService,
        ProcessingStateService,
        Processor,
      ],
    })
      .overrideProvider(STORAGE_INTERNAL_CLIENT)
      .useValue(createStorageClient(config, options.storageEndpoint))
      .compile();
    modules.push(moduleRef);
    const errors: string[] = [];
    moduleRef
      .get<Queue>(getQueueToken(VIDEO_QUEUES.PROCESSING))
      .on('error', (error) => errors.push(error.message));
    await moduleRef.init();
    const processor = moduleRef.get(Processor);
    processor.worker.on('error', (error) => errors.push(error.message));
    return {
      moduleRef,
      processor,
      state: moduleRef.get(ProcessingStateService),
      errors,
    };
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(SHORT_LOCK_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    // Evaluated only now, after the short lock and stall were set for its decorator.
    ({ VideoProcessingProcessor: Processor } = jest.requireActual<{
      VideoProcessingProcessor: typeof VideoProcessingProcessorType;
    }>('./video-processing.processor'));
    link = new RedisLink();
    await link.start();
    slowStorage = await startSlowStorage();
    base = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
      ],
    }).compile();
    dataSource = base.get(DataSource);
    queue = new Queue(VIDEO_QUEUES.PROCESSING, {
      connection: { host: REDIS.host, port: REDIS.port },
      prefix: QUEUE_PREFIX,
    });
  });

  afterAll(async () => {
    try {
      await Promise.all(modules.map((moduleRef) => moduleRef.close()));
      await removeStorageOfVideos(dataSource, s3, config.bucket);
      await cleanAllTables(dataSource);
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
      await link.close();
      await new Promise((resolve) => slowStorage.server.close(resolve));
      s3.destroy();
      await base.close();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('should let the redelivered attempt publish, keep the stale one from publishing, end its FFmpeg children and resume after Redis returns', async () => {
    await removeStorageOfVideos(dataSource, s3, config.bucket);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    const channel = await saveTestChannel(dataSource);
    const saved = await saveProcessingVideo(dataSource, channel.id);
    const originalKey = await uploadOriginal(
      s3,
      config.bucket,
      saved.id,
      'h264-aac-faststart.mp4',
    );
    await dataSource
      .getRepository(Video)
      .update(saved.id, { original_key: originalKey });

    // Worker A: Redis through the link, the storage through the slow proxy.
    const a = await startWorker({
      redis: { host: '127.0.0.1', port: link.port },
      storageEndpoint: `http://127.0.0.1:${slowStorage.port}`,
    });
    expect(a.processor.worker.opts).toMatchObject({
      lockDuration: 2_000,
      stalledInterval: 1_000,
      maxStalledCount: 1,
    });
    const publishedByA: boolean[] = [];
    const realPublishA = a.state.publishReady.bind(
      a.state,
    ) as ProcessingStateService['publishReady'];
    jest.spyOn(a.state, 'publishReady').mockImplementation(async (...args) => {
      const published = await realPublishA(...args);
      publishedByA.push(published);
      return published;
    });
    const warnings = jest.spyOn(Logger.prototype, 'warn');
    const jobId = `video-${saved.id}-1-1`;
    await queue.add(
      PROCESS_VIDEO_JOB_NAME,
      { videoId: saved.id, run: 1 },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'fixed', delay: 500 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    // A assumes the attempt, and its ffprobe, a child of this process, reads the original.
    await waitUntil(
      'the attempt of worker A',
      async () =>
        (await reloadVideo(dataSource, saved.id)).attempt_fence_seq === 1,
    );
    const attemptOfA = (await reloadVideo(dataSource, saved.id))
      .current_attempt_id;
    await waitUntil(
      'the ffprobe of worker A',
      () => childProcesses('ffprobe').length > 0,
    );

    // Redis becomes unreachable for A while its job is active.
    const cutAt = Date.now();
    link.cut();
    // Worker B, with a working Redis, finds the lock of A expired and takes the job again. Its
    // publication waits until A has tried its own, so A ends while the video is still in
    // processing and only the current attempt (P3) can keep it from publishing.
    const b = await startWorker({
      redis: { host: REDIS.host, port: REDIS.port },
      storageEndpoint: config.endpoint,
    });
    const releaseB = gate();
    const realPublishB = b.state.publishReady.bind(
      b.state,
    ) as ProcessingStateService['publishReady'];
    jest.spyOn(b.state, 'publishReady').mockImplementation(async (...args) => {
      await releaseB.opened;
      return realPublishB(...args);
    });
    let attemptOfB: string | null = null;
    let outageMs = 0;
    try {
      await waitUntil(
        'the redelivered attempt to assume',
        async () =>
          (await reloadVideo(dataSource, saved.id)).attempt_fence_seq === 2,
        40_000,
      );
      attemptOfB = (await reloadVideo(dataSource, saved.id)).current_attempt_id;
      expect(attemptOfB).not.toBe(attemptOfA);
      // A is still processing, through its FFmpeg children, while Redis is down.
      expect(publishedByA).toEqual([]);
      expect(
        childProcesses('ffprobe').length + childProcesses('ffmpeg').length,
      ).toBeGreaterThan(0);

      // Redis comes back for A.
      link.restore();
      outageMs = Date.now() - cutAt;
      await waitUntil(
        'the stale attempt of A to end',
        () => publishedByA.length === 1,
        60_000,
      );
      await expect(reloadVideo(dataSource, saved.id)).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        current_attempt_id: attemptOfB,
        thumbnail_key: null,
      });
    } finally {
      // Even when an expectation fails, B publishes and its job ends, so the suite can close.
      releaseB.open();
    }
    await waitUntil(
      'the redelivered attempt to publish ready',
      async () =>
        (await reloadVideo(dataSource, saved.id)).status === VideoStatus.READY,
      40_000,
    );
    const ready = await reloadVideo(dataSource, saved.id);
    expect(ready).toMatchObject({
      current_attempt_id: attemptOfB,
      attempt_fence_dispatch: 1,
      attempt_fence_seq: 2,
      thumbnail_key: `thumbnails/${saved.id}/${attemptOfB}.jpg`,
    });

    // The stale attempt could not publish over the redelivered one.
    expect(publishedByA).toEqual([false]);
    const events = warnings.mock.calls.map(([message]) => message as unknown);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'video-processing.stalled',
        jobId,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'video-processing.attempt-lost',
        jobId,
        attemptId: attemptOfA,
        outcome: 'ready',
      }),
    );
    await expect(reloadVideo(dataSource, saved.id)).resolves.toEqual(ready);
    await waitUntil(
      'the job to be completed',
      async () => (await queue.getJobState(jobId)) === 'completed',
    );
    const job = await queue.getJob(jobId);
    expect(job?.attemptsStarted).toBe(2);
    expect((job?.returnvalue as ProcessVideoResult).attemptId).toBe(
      ready.current_attempt_id,
    );
    // Both attempts wrote their own key; only the redelivered one is referenced.
    expect((await thumbnailKeysOf(s3, config.bucket, saved.id)).sort()).toEqual(
      [
        `thumbnails/${saved.id}/${attemptOfA}.jpg`,
        `thumbnails/${saved.id}/${ready.current_attempt_id}.jpg`,
      ].sort(),
    );
    // No FFmpeg child of the worker is left behind.
    expect(childProcesses('ffprobe')).toEqual([]);
    expect(childProcesses('ffmpeg')).toEqual([]);
    expect(link.refused).toBeGreaterThan(0);
    expect(a.errors.length).toBeGreaterThan(0);
    expect(outageMs).toBeGreaterThan(2_000);

    // After the restoration, A takes and finishes a new job.
    await b.moduleRef.close();
    modules.splice(modules.indexOf(b.moduleRef), 1);
    const next = await saveProcessingVideo(dataSource, channel.id);
    await dataSource.getRepository(Video).update(next.id, {
      original_key: await uploadOriginal(
        s3,
        config.bucket,
        next.id,
        'h264-aac-faststart.mp4',
      ),
    });
    await queue.add(
      PROCESS_VIDEO_JOB_NAME,
      { videoId: next.id, run: 1 },
      {
        jobId: `video-${next.id}-1-1`,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    await waitUntil(
      'worker A to process a new job after Redis returned',
      async () =>
        (await reloadVideo(dataSource, next.id)).status === VideoStatus.READY,
      60_000,
    );
    expect(childProcesses('ffprobe')).toEqual([]);
    expect(childProcesses('ffmpeg')).toEqual([]);
  });
});
