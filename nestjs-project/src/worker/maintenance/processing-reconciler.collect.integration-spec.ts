import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { getQueueToken } from '@nestjs/bullmq';
import type { TestingModule } from '@nestjs/testing';
import { type Job, type Queue, UnrecoverableError, Worker } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { cleanAllTables } from '../../test/create-test-data-source';
import {
  reloadVideo,
  saveProcessingVideo,
} from '../../test/processing-fixtures';
import {
  createReconciliationModule,
  REDIS_CONNECTION,
  waitForJobState,
} from '../../test/reconciliation-fixtures';
import { saveTestChannel } from '../../test/video-entity-fixtures';
import { type Video, VideoStatus } from '../../videos/entities/video.entity';
import { VideoJobDispatcherService } from '../../videos/jobs/video-job-dispatcher.service';
import type { ProcessVideoJobData } from '../../videos/jobs/video-job-id';
import { VIDEO_QUEUES } from '../../videos/videos.constants';
import { STALL_FAILED_REASON } from './processing-reconciliation.decisions';
import { ProcessingReconciliationRepository } from './processing-reconciliation.repository';
import { ProcessingReconcilerService } from './processing-reconciler.service';

jest.setTimeout(60_000);

const QUEUE_PREFIX = `test-reconcile-collect-${process.pid}`;
const BATCH = { batchSize: 100 };
/** Short lock and stall, as in V-11, so a killed worker stalls within seconds. */
const SHORT_LOCK = {
  lockDuration: 1_000,
  stalledInterval: 500,
  maxStalledCount: 1,
};

/**
 * A worker of `video-processing` in another Node process, so it can be killed with SIGKILL in the
 * middle of a job (T-12). Each delivery assumes the attempt as P3 does (the fence takes the
 * generation and `attemptsStarted`) and then hangs, as an FFmpeg that never ends.
 */
const CHILD_WORKER = `
const { randomUUID } = require('node:crypto');
const { Worker } = require('bullmq');
const { Client } = require('pg');
const cfg = JSON.parse(process.argv[1]);
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
(async () => {
  const db = new Client(cfg.db);
  await db.connect();
  const worker = new Worker(cfg.queue, async (job) => {
    await db.query(
      "UPDATE videos SET current_attempt_id = $2, attempt_fence_dispatch = $3, attempt_fence_seq = $4 WHERE id = $1 AND status = 'processing'",
      [job.data.videoId, randomUUID(), cfg.dispatch, job.attemptsStarted],
    );
    say({ ev: 'start', jobId: job.id, attemptsStarted: job.attemptsStarted });
    await new Promise(() => undefined);
  }, { connection: cfg.connection, prefix: cfg.prefix, ...cfg.options });
  worker.on('ready', () => say({ ev: 'ready' }));
})();
`;

interface ChildEvent {
  ev: string;
  jobId?: string;
  attemptsStarted?: number;
}

class ChildWorker {
  private readonly events: ChildEvent[] = [];
  private readonly exited: Promise<void>;

  constructor(private readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        this.events.push(JSON.parse(line) as ChildEvent);
      } catch {
        // Not an event of the script.
      }
    });
    this.exited = new Promise((resolve) => child.once('exit', () => resolve()));
  }

  static start(dispatch: number): ChildWorker {
    const config = {
      queue: VIDEO_QUEUES.PROCESSING,
      prefix: QUEUE_PREFIX,
      connection: REDIS_CONNECTION,
      options: SHORT_LOCK,
      dispatch,
      db: {
        host: process.env.DB_HOST ?? 'db',
        port: Number(process.env.DB_PORT ?? 5432),
        user: process.env.DB_USERNAME ?? 'streamtube',
        password: process.env.DB_PASSWORD ?? 'streamtube',
        database: process.env.DB_NAME ?? 'streamtube',
      },
    };
    return new ChildWorker(
      spawn(process.execPath, ['-e', CHILD_WORKER, JSON.stringify(config)], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
    );
  }

  async waitFor(
    predicate: (event: ChildEvent) => boolean,
    timeoutMs = 20_000,
  ): Promise<ChildEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(predicate);
      if (found) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `child worker: no expected event in ${JSON.stringify(this.events)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }
    await this.exited;
  }

  get signal(): NodeJS.Signals | null {
    return this.child.signalCode;
  }
}

describe('ProcessingReconcilerService collection (integration, T-09 scenario 8, T-12)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let reconciler: ProcessingReconcilerService;
  let repository: ProcessingReconciliationRepository;
  let dispatcher: VideoJobDispatcherService;
  let queue: Queue<ProcessVideoJobData>;
  let channel: Channel;
  const children: ChildWorker[] = [];

  beforeAll(async () => {
    moduleRef = await createReconciliationModule(QUEUE_PREFIX);
    dataSource = moduleRef.get(DataSource);
    reconciler = moduleRef.get(ProcessingReconcilerService);
    repository = moduleRef.get(ProcessingReconciliationRepository);
    dispatcher = moduleRef.get(VideoJobDispatcherService);
    queue = moduleRef.get(getQueueToken(VIDEO_QUEUES.PROCESSING));
  });

  afterAll(async () => {
    try {
      await Promise.all(children.map((child) => child.kill()));
      await cleanAllTables(dataSource);
      await queue.obliterate({ force: true });
    } finally {
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    channel = await saveTestChannel(dataSource);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(children.splice(0).map((child) => child.kill()));
  });

  const jobIdOf = (
    video: Video,
    dispatch: number,
    run = video.processing_run,
  ) => `video-${video.id}-${run}-${dispatch}`;

  /**
   * Adds the jobs and runs one worker of the test until each reaches the state of the plan:
   * `completed` or `failed` (by `UnrecoverableError`).
   */
  async function finishJobs(
    plan: {
      jobId: string;
      videoId: string;
      run: number;
      state: 'completed' | 'failed';
    }[],
  ): Promise<void> {
    for (const { jobId, videoId, run } of plan) {
      await queue.add(
        'process-video',
        { videoId, run },
        { jobId, removeOnComplete: false, removeOnFail: false },
      );
    }
    const byId = new Map(plan.map((entry) => [entry.jobId, entry.state]));
    const worker = new Worker<ProcessVideoJobData>(
      VIDEO_QUEUES.PROCESSING,
      (job: Job<ProcessVideoJobData>) =>
        byId.get(job.id ?? '') === 'failed'
          ? Promise.reject(new UnrecoverableError('failed by the test'))
          : Promise.resolve(),
      { connection: REDIS_CONNECTION, prefix: QUEUE_PREFIX },
    );
    try {
      for (const { jobId, state } of plan) {
        await waitForJobState(queue, jobId, [state]);
      }
    } finally {
      await worker.close();
    }
  }

  describe('collection of finished jobs (scenario 8)', () => {
    it('should keep a failed job while the closure affects zero rows, and remove it only after the terminal execution', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      const jobId = jobIdOf(video, 1);
      await finishJobs([{ jobId, videoId: video.id, run: 1, state: 'failed' }]);
      const realClose = repository.closeInError.bind(
        repository,
      ) as ProcessingReconciliationRepository['closeInError'];
      jest
        .spyOn(repository, 'closeInError')
        .mockImplementationOnce(async (...args) => {
          // A late attempt advances the fence after the observation: the retrato is stale.
          await dataSource.query(
            `UPDATE videos SET current_attempt_id = $2, attempt_fence_dispatch = 1, attempt_fence_seq = 1 WHERE id = $1`,
            [video.id, randomUUID()],
          );
          return realClose(...args);
        });

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        closed: 0,
        discarded: 1,
        collected: 0,
      });
      expect(await queue.getJobState(jobId)).toBe('failed');
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
      });

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        closed: 1,
        collected: 1,
      });
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'PROCESSING_FAILED',
      });
      expect(await queue.getJob(jobId)).toBeUndefined();
    });

    it('should remove the jobs of superseded generations, older runs and terminal executions, and keep the rest', async () => {
      const inGrace = await createReconciliationModule(QUEUE_PREFIX, {
        processingReconcileGraceMs: 300_000,
      });
      try {
        const current = await saveProcessingVideo(dataSource, channel.id, {
          processing_dispatch: 3,
          processing_recoveries: 2,
        });
        const rerun = await saveProcessingVideo(dataSource, channel.id, {
          processing_run: 2,
        });
        const ready = await saveProcessingVideo(dataSource, channel.id, {
          status: VideoStatus.READY,
        });
        const failed = await saveProcessingVideo(dataSource, channel.id, {
          status: VideoStatus.ERROR,
          processing_dispatch: 2,
        });
        await finishJobs([
          {
            jobId: jobIdOf(current, 1),
            videoId: current.id,
            run: 1,
            state: 'completed',
          },
          {
            jobId: jobIdOf(current, 2),
            videoId: current.id,
            run: 1,
            state: 'failed',
          },
          {
            jobId: jobIdOf(current, 3),
            videoId: current.id,
            run: 1,
            state: 'completed',
          },
          {
            jobId: jobIdOf(rerun, 1, 1),
            videoId: rerun.id,
            run: 1,
            state: 'completed',
          },
          {
            jobId: jobIdOf(ready, 1),
            videoId: ready.id,
            run: 1,
            state: 'completed',
          },
          {
            jobId: jobIdOf(failed, 2),
            videoId: failed.id,
            run: 1,
            state: 'failed',
          },
          {
            jobId: 'not-a-video-job',
            videoId: current.id,
            run: 1,
            state: 'completed',
          },
        ]);
        // Jobs that are not finished are never collected, even of a terminal video.
        await queue.add(
          'process-video',
          { videoId: failed.id, run: 1 },
          { jobId: jobIdOf(failed, 1) },
        );
        await queue.add(
          'process-video',
          { videoId: rerun.id, run: 2 },
          { jobId: jobIdOf(rerun, 1), delay: 60_000 },
        );

        await expect(
          inGrace.get(ProcessingReconcilerService).run(BATCH),
        ).resolves.toMatchObject({ examined: 0, collected: 5 });

        const left = (await queue.getJobs()).map((job) => job.id).sort();
        expect(left).toEqual(
          [
            jobIdOf(current, 3),
            jobIdOf(failed, 1),
            jobIdOf(rerun, 1),
            'not-a-video-job',
          ].sort(),
        );
      } finally {
        await inGrace.close();
      }
    });
  });

  describe('progress of the collection between runs', () => {
    it('should reach, in later runs, the collectable jobs after retained ones in both finished sets (batchSize 1)', async () => {
      const inGrace = await createReconciliationModule(QUEUE_PREFIX, {
        processingReconcileGraceMs: 300_000,
      });
      try {
        const current = await saveProcessingVideo(dataSource, channel.id, {
          processing_dispatch: 2,
        });
        const ready = await saveProcessingVideo(dataSource, channel.id, {
          status: VideoStatus.READY,
        });
        // Older finished jobs that must stay, then collectable ones.
        await finishJobs([
          {
            jobId: 'not-a-video-job',
            videoId: current.id,
            run: 1,
            state: 'completed',
          },
          {
            jobId: jobIdOf(current, 2),
            videoId: current.id,
            run: 1,
            state: 'failed',
          },
        ]);
        await finishJobs([
          {
            jobId: jobIdOf(ready, 1),
            videoId: ready.id,
            run: 1,
            state: 'completed',
          },
          {
            jobId: jobIdOf(current, 1),
            videoId: current.id,
            run: 1,
            state: 'failed',
          },
        ]);
        const service = inGrace.get(ProcessingReconcilerService);
        let collected = 0;

        for (let cycle = 0; cycle < 4; cycle++) {
          collected += (await service.run({ batchSize: 1 })).collected;
        }

        expect(collected).toBe(2);
        expect((await queue.getJobs()).map((job) => job.id).sort()).toEqual(
          [jobIdOf(current, 2), 'not-a-video-job'].sort(),
        );
      } finally {
        await inGrace.close();
      }
    });
  });

  describe('worker killed in the middle of the processing (T-12)', () => {
    it('should redeliver after the first stall and, above maxStalledCount, end the video in PROCESSING_STALLED through the reconciliation', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      const jobId = jobIdOf(video, 1);

      const first = ChildWorker.start(1);
      children.push(first);
      await first.waitFor((event) => event.ev === 'ready');
      await dispatcher.publish({ videoId: video.id, run: 1, dispatch: 1 });
      await first.waitFor(
        (event) => event.ev === 'start' && event.attemptsStarted === 1,
      );
      await first.kill();
      expect(first.signal).toBe('SIGKILL');

      // A new worker finds the stalled job and receives it again.
      const second = ChildWorker.start(1);
      children.push(second);
      await second.waitFor(
        (event) => event.ev === 'start' && event.attemptsStarted === 2,
      );
      await second.kill();
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        attempt_fence_dispatch: 1,
        attempt_fence_seq: 2,
      });

      // Above maxStalledCount, a worker moves the job to failed without calling its processor.
      let processorCalls = 0;
      const third = new Worker<ProcessVideoJobData>(
        VIDEO_QUEUES.PROCESSING,
        () => {
          processorCalls += 1;
          return Promise.resolve();
        },
        { connection: REDIS_CONNECTION, prefix: QUEUE_PREFIX, ...SHORT_LOCK },
      );
      try {
        await waitForJobState(queue, jobId, ['failed'], 20_000);
      } finally {
        await third.close();
      }
      const failedJob = await queue.getJob(jobId);
      expect(failedJob?.failedReason).toBe(STALL_FAILED_REASON);
      expect(processorCalls).toBe(0);
      // The job is still the evidence of the execution until the database is terminal.
      expect(await queue.getJobState(jobId)).toBe('failed');

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        closed: 1,
        collected: 1,
      });

      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'PROCESSING_STALLED',
        error_message: `job ${jobId} failed: ${STALL_FAILED_REASON}`,
        attempt_fence_seq: 2,
      });
      expect(await queue.getJob(jobId)).toBeUndefined();
    });
  });
});
