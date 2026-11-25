import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { type Queue, UnrecoverableError } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { cleanAllTables } from '../../test/create-test-data-source';
import {
  reloadVideo,
  saveProcessingVideo,
} from '../../test/processing-fixtures';
import {
  createReconciliationModule,
  driveJob,
  waitForJobState,
} from '../../test/reconciliation-fixtures';
import { saveTestChannel } from '../../test/video-entity-fixtures';
import {
  type Video,
  VideoPendingJobAction,
  VideoStatus,
} from '../../videos/entities/video.entity';
import { VideoJobDispatcherService } from '../../videos/jobs/video-job-dispatcher.service';
import type { ProcessVideoJobData } from '../../videos/jobs/video-job-id';
import { VIDEO_QUEUES } from '../../videos/videos.constants';
import { ProcessingReconcilerService } from './processing-reconciler.service';

jest.setTimeout(30_000);

const QUEUE_PREFIX = `test-reconcile-states-${process.pid}`;
const BATCH = { batchSize: 100 };

describe('ProcessingReconcilerService states (integration, T-08, T-09 scenario 1)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let reconciler: ProcessingReconcilerService;
  let dispatcher: VideoJobDispatcherService;
  let queue: Queue<ProcessVideoJobData>;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await createReconciliationModule(QUEUE_PREFIX);
    dataSource = moduleRef.get(DataSource);
    reconciler = moduleRef.get(ProcessingReconcilerService);
    dispatcher = moduleRef.get(VideoJobDispatcherService);
    queue = moduleRef.get(getQueueToken(VIDEO_QUEUES.PROCESSING));
  });

  afterAll(async () => {
    try {
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const jobIdOf = (video: Video, dispatch = video.processing_dispatch) =>
    `video-${video.id}-${video.processing_run}-${dispatch}`;

  /** The job of the current generation, as R2 adds it. */
  async function publishCurrent(video: Video): Promise<string> {
    const { jobId } = await dispatcher.publish({
      videoId: video.id,
      run: video.processing_run,
      dispatch: video.processing_dispatch,
    });
    return jobId;
  }

  async function expectRecovered(video: Video, generation: number) {
    const after = await reloadVideo(dataSource, video.id);
    expect(after).toMatchObject({
      status: VideoStatus.PROCESSING,
      processing_dispatch: generation,
      processing_recoveries: video.processing_recoveries + 1,
      current_attempt_id: null,
      pending_job_action: null,
      pending_job_dispatch: null,
      pending_job_token: null,
    });
    const job = await queue.getJob(jobIdOf(video, generation));
    expect(job?.data).toEqual({ videoId: video.id, run: 1 });
    expect(job?.opts).toMatchObject({
      removeOnComplete: false,
      removeOnFail: false,
    });
    await waitForJobState(queue, jobIdOf(video, generation), ['waiting']);
  }

  describe('video in processing without the job of its generation (T-08)', () => {
    it('should reserve a new generation, count one recovery and add the job of that generation', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        current_attempt_id: randomUUID(),
        attempt_fence_dispatch: 1,
        attempt_fence_seq: 1,
      });
      // The test removes the job of the generation.
      await queue.remove(await publishCurrent(video));

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        examined: 1,
        recovered: 1,
        failed: 0,
      });

      await expectRecovered(video, 2);
      expect(await queue.getJob(jobIdOf(video, 1))).toBeUndefined();
    });

    it('should recover a video whose job was never added and no worker ever started (empty fence)', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);

      await reconciler.run(BATCH);

      await expectRecovered(video, 2);
    });

    it('should close in PROCESSING_INCONSISTENT at the limit of recoveries, without a new job', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        processing_dispatch: 3,
        processing_recoveries: 2,
      });

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        closed: 1,
        recovered: 0,
      });

      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'PROCESSING_INCONSISTENT',
        processing_dispatch: 3,
        processing_recoveries: 2,
      });
      expect(await queue.getJobCounts()).toMatchObject({
        waiting: 0,
        delayed: 0,
      });
    });
  });

  describe('conduct for each state of the job of the generation (T-09, scenario 1)', () => {
    it.each<[string, (jobId: string, video: Video) => Promise<void>]>([
      ['waiting', () => Promise.resolve()],
      [
        'delayed',
        async (_, video) => {
          await queue.remove(jobIdOf(video));
          await queue.add(
            'process-video',
            { videoId: video.id, run: 1 },
            { jobId: jobIdOf(video), delay: 60_000 },
          );
        },
      ],
      [
        'prioritized',
        async (_, video) => {
          await queue.remove(jobIdOf(video));
          await queue.add(
            'process-video',
            { videoId: video.id, run: 1 },
            { jobId: jobIdOf(video), priority: 5 },
          );
        },
      ],
      [
        'active',
        (jobId) =>
          driveJob(
            queue,
            QUEUE_PREFIX,
            jobId,
            () => new Promise(() => undefined),
            ['active'],
          ),
      ],
    ])(
      'should change nothing in the database for a job %s',
      async (state, prepare) => {
        const video = await saveProcessingVideo(dataSource, channel.id);
        const jobId = await publishCurrent(video);
        await prepare(jobId, video);
        await waitForJobState(queue, jobId, [
          state as 'waiting' | 'delayed' | 'prioritized' | 'active',
        ]);
        const before = await reloadVideo(dataSource, video.id);

        await expect(reconciler.run(BATCH)).resolves.toMatchObject({
          examined: 1,
          untouched: 1,
          recovered: 0,
          closed: 0,
          stuckAlerts: 0,
        });

        expect(await reloadVideo(dataSource, video.id)).toEqual(before);
        expect(await queue.getJobState(jobId)).toBe(state);
      },
    );

    it('should alert a job waiting above PROCESSING_STUCK_ALERT_MS, still without touching the database', async () => {
      const alerting = await createReconciliationModule(QUEUE_PREFIX, {
        processingStuckAlertMs: 0,
      });
      try {
        const video = await saveProcessingVideo(dataSource, channel.id);
        await publishCurrent(video);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const before = await reloadVideo(dataSource, video.id);
        const warn = jest.spyOn(Logger.prototype, 'warn');

        await expect(
          alerting.get(ProcessingReconcilerService).run(BATCH),
        ).resolves.toMatchObject({ untouched: 1, stuckAlerts: 1 });

        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'video-processing.stuck',
            jobId: jobIdOf(video),
          }),
        );
        expect(await reloadVideo(dataSource, video.id)).toEqual(before);
      } finally {
        await alerting.close();
      }
    });

    it('should close a failed job in PROCESSING_FAILED with its reason, and collect the job after the closure', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      const jobId = await publishCurrent(video);
      await driveJob(
        queue,
        QUEUE_PREFIX,
        jobId,
        () => Promise.reject(new UnrecoverableError('ffprobe exhausted')),
        ['failed'],
      );

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        closed: 1,
        collected: 1,
      });

      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'PROCESSING_FAILED',
        error_message: `job ${jobId} failed: ffprobe exhausted`,
      });
      expect(await queue.getJob(jobId)).toBeUndefined();
    });

    it('should not close a failed job whose generation already has a later attempt in the fence', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        current_attempt_id: randomUUID(),
        attempt_fence_dispatch: 1,
        attempt_fence_seq: 5,
      });
      const jobId = await publishCurrent(video);
      await driveJob(
        queue,
        QUEUE_PREFIX,
        jobId,
        () => Promise.reject(new UnrecoverableError('an old delivery')),
        ['failed'],
      );
      const before = await reloadVideo(dataSource, video.id);

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        closed: 0,
        discarded: 1,
        collected: 0,
      });

      expect(await reloadVideo(dataSource, video.id)).toEqual(before);
      expect(await queue.getJobState(jobId)).toBe('failed');
    });

    it('should recover a job completed without a transition in the database, and collect the superseded job', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      const jobId = await publishCurrent(video);
      await driveJob(
        queue,
        QUEUE_PREFIX,
        jobId,
        () => Promise.resolve({ outcome: 'skipped' }),
        ['completed'],
      );

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        recovered: 1,
        collected: 1,
      });

      await expectRecovered(video, 2);
      expect(await queue.getJob(jobId)).toBeUndefined();
    });

    it('should leave a pending action within its deadline to its owner, even with the job missing', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        pending_job_action: VideoPendingJobAction.PUBLISH,
        pending_job_dispatch: 1,
        pending_job_token: randomUUID(),
        pending_job_expires_at: new Date(Date.now() + 60_000),
      });
      const before = await reloadVideo(dataSource, video.id);

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        untouched: 1,
      });

      expect(await reloadVideo(dataSource, video.id)).toEqual(before);
      expect(await queue.getJobCounts()).toMatchObject({ waiting: 0 });
    });

    it('should not examine a video still within the grace of the reconciliation', async () => {
      const graceful = await createReconciliationModule(QUEUE_PREFIX, {
        processingReconcileGraceMs: 300_000,
      });
      try {
        const video = await saveProcessingVideo(dataSource, channel.id);
        const before = await reloadVideo(dataSource, video.id);

        await expect(
          graceful.get(ProcessingReconcilerService).run(BATCH),
        ).resolves.toMatchObject({ examined: 0 });

        expect(await reloadVideo(dataSource, video.id)).toEqual(before);
      } finally {
        await graceful.close();
      }
    });

    it('should reach, in later runs, a video that comes after one that must stay untouched (batchSize 1)', async () => {
      // The oldest video has its job waiting: it stays untouched in every run.
      const waiting = await saveProcessingVideo(dataSource, channel.id, {
        processing_started_at: new Date(Date.now() - 10 * 60_000),
      });
      await publishCurrent(waiting);
      // The next one has lost its job and needs a recovery.
      const lost = await saveProcessingVideo(dataSource, channel.id, {
        processing_started_at: new Date(Date.now() - 5 * 60_000),
      });
      const examined: number[] = [];

      for (let cycle = 0; cycle < 4; cycle++) {
        const result = await reconciler.run({ batchSize: 1 });
        examined.push(result.examined);
      }

      await expect(reloadVideo(dataSource, lost.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: null,
      });
      await expect(reloadVideo(dataSource, waiting.id)).resolves.toMatchObject({
        processing_dispatch: 1,
        processing_recoveries: 0,
      });
      // Never more than one video per run.
      expect(Math.max(...examined)).toBeLessThanOrEqual(1);
    });

    it('should keep examining every candidate in a cycle, without recovering a video twice (batchSize 1)', async () => {
      const videos: Video[] = [];
      for (const minutesAgo of [30, 20, 10]) {
        videos.push(
          await saveProcessingVideo(dataSource, channel.id, {
            processing_started_at: new Date(Date.now() - minutesAgo * 60_000),
          }),
        );
      }

      for (let cycle = 0; cycle < 8; cycle++) {
        await reconciler.run({ batchSize: 1 });
      }

      for (const video of videos) {
        await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
          processing_dispatch: 2,
          processing_recoveries: 1,
        });
      }
    });

    it('should ignore videos that are not in processing', async () => {
      await saveProcessingVideo(dataSource, channel.id, {
        status: VideoStatus.READY,
      });
      await saveProcessingVideo(dataSource, channel.id, {
        status: VideoStatus.DRAFT,
        processing_run: 0,
        processing_dispatch: 0,
      });

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        examined: 0,
      });
    });
  });
});
