import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Job, Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { gate } from '../../test/locks';
import { VIDEO_QUEUES } from '../../videos/videos.constants';
import { MAINTENANCE_JOBS } from './maintenance.constants';
import { MaintenanceProcessor } from './maintenance.processor';
import {
  MAINTENANCE_TASKS,
  type MaintenanceJobData,
  pendingMaintenanceTasks,
} from './maintenance-task';

jest.setTimeout(30_000);

/** The real `video-maintenance` queue in a keyspace of its own, consumed only by this suite. */
const QUEUE_PREFIX = `test-maintenance-processor-${process.pid}`;
const { host, port } = queueConfig().redis;

type Tasks = Record<string, { run: jest.Mock }>;

function mockTasks(): Tasks {
  return Object.fromEntries(
    Object.values(MAINTENANCE_JOBS).map((name) => [
      name,
      { run: jest.fn().mockResolvedValue({ name }) },
    ]),
  );
}

/**
 * The worker side of the maintenance. `withStorage` adds a module that releases a resource on
 * shutdown (the storage clients, `StorageModule.onModuleDestroy`), as the services of SI-03.24
 * to SI-03.26 will use.
 */
async function startWorker(prefix: string, tasks: Tasks, withStorage = false) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      BullModule.forRoot({ connection: { host, port }, prefix }),
      BullModule.registerQueue({ name: VIDEO_QUEUES.MAINTENANCE }),
      ...(withStorage
        ? [
            ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
            StorageModule,
          ]
        : []),
    ],
    providers: [
      MaintenanceProcessor,
      { provide: MAINTENANCE_TASKS, useValue: tasks },
    ],
  }).compile();
  // Starts the BullMQ worker of the processor (registration on `onModuleInit`).
  await moduleRef.init();
  return {
    moduleRef,
    queue: moduleRef.get<Queue<MaintenanceJobData>>(
      getQueueToken(VIDEO_QUEUES.MAINTENANCE),
    ),
    processor: moduleRef.get(MaintenanceProcessor),
  };
}

/** The job once finished; the state is read before the job, as in SI-03.22. */
async function waitUntilFinished(
  queue: Queue<MaintenanceJobData>,
  jobId: string,
): Promise<Job<MaintenanceJobData>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await queue.getJobState(jobId);
    if (state === 'completed' || state === 'failed') {
      return (await queue.getJob(jobId)) as Job<MaintenanceJobData>;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} is still ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForCall(task: jest.Mock): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (task.mock.calls.length === 0) {
    if (Date.now() > deadline) {
      throw new Error('the task was not called');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('MaintenanceProcessor (integration)', () => {
  let tasks: Tasks;
  let moduleRef: TestingModule;
  let queue: Queue<MaintenanceJobData>;
  let processor: MaintenanceProcessor;

  beforeAll(async () => {
    tasks = mockTasks();
    ({ moduleRef, queue, processor } = await startWorker(QUEUE_PREFIX, tasks));
  });

  afterAll(async () => {
    try {
      await queue.obliterate({ force: true });
    } finally {
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    for (const [name, task] of Object.entries(tasks)) {
      task.run.mockReset();
      task.run.mockResolvedValue({ name });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should consume video-maintenance, apart from video-processing, with concurrency 1 and the lock and stall of the configuration', () => {
    const { worker } = queueConfig();

    expect(processor.worker.name).toBe(VIDEO_QUEUES.MAINTENANCE);
    expect(processor.worker.opts).toMatchObject({
      concurrency: 1,
      lockDuration: worker.lockDurationMs,
      stalledInterval: worker.stalledIntervalMs,
      maxStalledCount: worker.maxStalledCount,
      prefix: QUEUE_PREFIX,
    });
  });

  it('should run one maintenance job at a time', async () => {
    const releaseSweep = gate();
    const sweep = tasks[MAINTENANCE_JOBS.SWEEP_UPLOAD_SESSIONS].run;
    const reconcile = tasks[MAINTENANCE_JOBS.RECONCILE_PROCESSING].run;
    sweep.mockImplementation(async () => {
      await releaseSweep.opened;
      return { swept: 0 };
    });
    const first = await queue.add(MAINTENANCE_JOBS.SWEEP_UPLOAD_SESSIONS, {
      batchSize: 10,
    });
    await waitForCall(sweep);
    const second = await queue.add(MAINTENANCE_JOBS.RECONCILE_PROCESSING, {
      batchSize: 10,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(reconcile).not.toHaveBeenCalled();
      expect(await queue.getActiveCount()).toBe(1);
    } finally {
      // Even when an expectation fails, the held job ends and the suite can close.
      releaseSweep.open();
    }

    expect(await (await waitUntilFinished(queue, first.id!)).getState()).toBe(
      'completed',
    );
    const secondJob = await waitUntilFinished(queue, second.id!);
    expect(await secondJob.getState()).toBe('completed');
    expect(reconcile).toHaveBeenCalledWith({ batchSize: 10 });
  });

  it('should log an unknown job name as an error and fail it without retries and without running a task', async () => {
    const error = jest.spyOn(Logger.prototype, 'error');

    const added = await queue.add(
      'purge-everything',
      { batchSize: 10 },
      { attempts: 3 },
    );
    const job = await waitUntilFinished(queue, added.id!);

    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    expect(job.failedReason).toBe('unknown maintenance job "purge-everything"');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'video-maintenance.unknown-job',
        name: 'purge-everything',
      }),
    );
    for (const task of Object.values(tasks)) {
      expect(task.run).not.toHaveBeenCalled();
    }
  });

  it('should fail, never complete, a job whose maintenance is still pending', async () => {
    const pending = pendingMaintenanceTasks();
    tasks[MAINTENANCE_JOBS.CLEANUP_STORAGE].run.mockImplementation(
      (data: MaintenanceJobData) =>
        pending[MAINTENANCE_JOBS.CLEANUP_STORAGE].run(data),
    );

    const added = await queue.add(MAINTENANCE_JOBS.CLEANUP_STORAGE, {
      batchSize: 10,
    });
    const job = await waitUntilFinished(queue, added.id!);

    expect(await job.getState()).toBe('failed');
    expect(job.failedReason).toBe(
      'maintenance "cleanup-storage" is not implemented yet (SI-03.26); nothing was done',
    );
  });

  it('should drain the active maintenance job before the other modules release their resources (shutdown)', async () => {
    const shutdownTasks = mockTasks();
    const started = await startWorker(
      `${QUEUE_PREFIX}-shutdown`,
      shutdownTasks,
      true,
    );
    try {
      const release = gate();
      const sweep = shutdownTasks[MAINTENANCE_JOBS.SWEEP_UPLOAD_SESSIONS].run;
      sweep.mockImplementation(async () => {
        await release.opened;
        return { swept: 0 };
      });
      const added = await started.queue.add(
        MAINTENANCE_JOBS.SWEEP_UPLOAD_SESSIONS,
        { batchSize: 10 },
      );
      await waitForCall(sweep);
      // Call-through spy: the real storage clients are released.
      const storageDestroyed = jest.spyOn(S3Client.prototype, 'destroy');
      let closed = false;

      const closing = started.moduleRef.close().then(() => (closed = true));
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(closed).toBe(false);
        expect(storageDestroyed).not.toHaveBeenCalled();
      } finally {
        release.open();
        await closing;
      }
      expect(storageDestroyed).toHaveBeenCalled();

      const state = new Queue(VIDEO_QUEUES.MAINTENANCE, {
        connection: { host, port },
        prefix: `${QUEUE_PREFIX}-shutdown`,
      });
      try {
        expect(await state.getJobState(added.id!)).toBe('completed');
      } finally {
        await state.obliterate({ force: true });
        await state.close();
      }
    } finally {
      jest.restoreAllMocks();
    }
  });
});
