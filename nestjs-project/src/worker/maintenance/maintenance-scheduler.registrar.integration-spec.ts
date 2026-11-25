import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { type JobSchedulerJson, Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import videoConfig from '../../config/video.config';
import { VIDEO_QUEUES } from '../../videos/videos.constants';
import {
  MAINTENANCE_JOB_OPTIONS,
  MAINTENANCE_JOBS,
  MAINTENANCE_SCHEDULERS,
} from './maintenance.constants';
import { MaintenanceSchedulerRegistrar } from './maintenance-scheduler.registrar';

/**
 * The real `video-maintenance` queue in a keyspace of its own: the `video-worker` of the
 * environment registers and consumes the default keyspace. No worker runs here.
 */
const QUEUE_PREFIX = `test-maintenance-schedulers-${process.pid}`;
const { host, port } = queueConfig().redis;

/** One instance of the worker side that registers the schedulers, with its own connections. */
async function bootInstance(
  maintenance?: Partial<ReturnType<typeof videoConfig>['maintenance']>,
): Promise<TestingModule> {
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [videoConfig] }),
      BullModule.forRoot({ connection: { host, port }, prefix: QUEUE_PREFIX }),
      BullModule.registerQueue({ name: VIDEO_QUEUES.MAINTENANCE }),
    ],
    providers: [MaintenanceSchedulerRegistrar],
  });
  if (maintenance) {
    const config = videoConfig();
    builder = builder.overrideProvider(videoConfig.KEY).useValue({
      ...config,
      maintenance: { ...config.maintenance, ...maintenance },
    });
  }
  const instance = await builder.compile();
  // `onApplicationBootstrap` registers the schedulers.
  await instance.init();
  return instance;
}

describe('MaintenanceSchedulerRegistrar (integration)', () => {
  const config = videoConfig().maintenance;
  let queue: Queue;
  let processingQueue: Queue;
  const instances: TestingModule[] = [];

  beforeAll(() => {
    queue = new Queue(VIDEO_QUEUES.MAINTENANCE, {
      connection: { host, port },
      prefix: QUEUE_PREFIX,
    });
    processingQueue = new Queue(VIDEO_QUEUES.PROCESSING, {
      connection: { host, port },
      prefix: QUEUE_PREFIX,
    });
  });

  afterAll(async () => {
    try {
      await queue.obliterate({ force: true });
      await processingQueue.obliterate({ force: true });
    } finally {
      await queue.close();
      await processingQueue.close();
    }
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.close()));
  });

  async function boot(
    maintenance?: Partial<ReturnType<typeof videoConfig>['maintenance']>,
  ): Promise<TestingModule> {
    const instance = await bootInstance(maintenance);
    instances.push(instance);
    return instance;
  }

  async function schedulersById(): Promise<Map<string, JobSchedulerJson>> {
    const schedulers = await queue.getJobSchedulers();
    return new Map(schedulers.map((scheduler) => [scheduler.key, scheduler]));
  }

  /** The jobs produced by the schedulers that have not run yet (no worker consumes here). */
  async function pendingJobs(): Promise<{ id: string; name: string }[]> {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs
      .map((job) => ({ id: job.id ?? '', name: job.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  it('should leave exactly one scheduler per stable id after two instances boot at the same time', async () => {
    await Promise.all([boot(), boot()]);

    expect(await queue.getJobSchedulersCount()).toBe(3);
    const schedulers = await schedulersById();
    expect([...schedulers.keys()].sort()).toEqual(
      Object.values(MAINTENANCE_SCHEDULERS).sort(),
    );
    expect(schedulers.get('upload-session-sweep')).toMatchObject({
      every: config.sweepIntervalMs,
      template: {
        data: { batchSize: config.batchSize },
        opts: MAINTENANCE_JOB_OPTIONS,
      },
    });
    expect(schedulers.get('processing-reconciliation')).toMatchObject({
      every: config.reconcileIntervalMs,
      template: { data: { batchSize: config.batchSize } },
    });
    expect(schedulers.get('storage-cleanup')).toMatchObject({
      every: config.cleanupIntervalMs,
      template: { data: { batchSize: config.batchSize } },
    });
    // One job per scheduler, named for the dispatch of MaintenanceProcessor.
    expect((await pendingJobs()).map((job) => job.name).sort()).toEqual(
      Object.values(MAINTENANCE_JOBS).sort(),
    );
  });

  it('should reuse the schedulers on a restart, keeping their next run and their jobs', async () => {
    const first = await boot();
    const before = await schedulersById();
    const jobsBefore = await pendingJobs();
    await first.close();
    instances.splice(instances.indexOf(first), 1);

    await boot();

    const after = await schedulersById();
    expect(await queue.getJobSchedulersCount()).toBe(3);
    for (const [id, scheduler] of before) {
      expect(after.get(id)).toMatchObject({
        every: scheduler.every,
        next: scheduler.next,
      });
    }
    expect(await pendingJobs()).toEqual(jobsBefore);
  });

  it('should update the interval and the batch of the configuration on the next boot, still one scheduler per id', async () => {
    await boot();

    await boot({ sweepIntervalMs: 15_000, batchSize: 7 });

    expect(await queue.getJobSchedulersCount()).toBe(3);
    const schedulers = await schedulersById();
    expect(schedulers.get('upload-session-sweep')).toMatchObject({
      every: 15_000,
      template: { data: { batchSize: 7 } },
    });
    expect(schedulers.get('storage-cleanup')).toMatchObject({
      every: config.cleanupIntervalMs,
      template: { data: { batchSize: 7 } },
    });
  });

  it('should register nothing in the video-processing queue', async () => {
    await boot();

    expect(await processingQueue.getJobSchedulersCount()).toBe(0);
    expect(
      await processingQueue.getJobCountByTypes(
        'waiting',
        'delayed',
        'prioritized',
      ),
    ).toBe(0);
  });
});
