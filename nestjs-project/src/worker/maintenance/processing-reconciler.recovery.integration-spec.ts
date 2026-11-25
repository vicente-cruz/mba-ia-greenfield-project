import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { JobState, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { cleanAllTables } from '../../test/create-test-data-source';
import { gate } from '../../test/locks';
import {
  reloadVideo,
  saveProcessingVideo,
} from '../../test/processing-fixtures';
import {
  createReconciliationModule,
  driveJob,
} from '../../test/reconciliation-fixtures';
import { saveTestChannel } from '../../test/video-entity-fixtures';
import {
  type Video,
  VideoPendingJobAction,
  VideoStatus,
} from '../../videos/entities/video.entity';
import { VideoJobDispatcherService } from '../../videos/jobs/video-job-dispatcher.service';
import type { ProcessVideoJobData } from '../../videos/jobs/video-job-id';
import {
  VIDEO_JOB_PUBLISH_TIMEOUT_MS,
  VIDEO_QUEUES,
} from '../../videos/videos.constants';
import { MAINTENANCE_QUEUE_TIMEOUT_MS } from './maintenance.constants';
import { ProcessingReconciliationRepository } from './processing-reconciliation.repository';
import { ProcessingReconcilerService } from './processing-reconciler.service';

jest.setTimeout(30_000);

const QUEUE_PREFIX = `test-reconcile-recovery-${process.pid}`;
const BATCH = { batchSize: 100 };

describe('ProcessingReconcilerService recoveries (integration, T-09 scenarios 2 to 7)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let reconciler: ProcessingReconcilerService;
  let repository: ProcessingReconciliationRepository;
  let dispatcher: VideoJobDispatcherService;
  let queue: Queue<ProcessVideoJobData>;
  let channel: Channel;

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

  const jobIdOf = (video: Video, dispatch: number) =>
    `video-${video.id}-${video.processing_run}-${dispatch}`;

  async function jobIdsOf(video: Video): Promise<string[]> {
    const jobs = await queue.getJobs();
    return jobs
      .map((job) => job.id ?? '')
      .filter((id) => id.startsWith(`video-${video.id}-`))
      .sort();
  }

  async function expirePendingAction(video: Video): Promise<void> {
    await dataSource.query(
      `UPDATE videos SET pending_job_expires_at = now() - interval '1 second' WHERE id = $1`,
      [video.id],
    );
  }

  /** Holds every call of the reservation until `count` calls arrived, so they share one retrato. */
  function reservationBarrier(count: number): void {
    const real = repository.reserveGeneration.bind(
      repository,
    ) as ProcessingReconciliationRepository['reserveGeneration'];
    const all = gate();
    let arrived = 0;
    jest
      .spyOn(repository, 'reserveGeneration')
      .mockImplementation(async (...args) => {
        arrived += 1;
        if (arrived === count) {
          all.open();
        }
        await all.opened;
        return real(...args);
      });
  }

  describe('two reconciliations over the same retrato (scenario 2)', () => {
    it('should reserve exactly one generation, count one recovery and add one job', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      reservationBarrier(2);
      const publish = jest.spyOn(dispatcher, 'publish');

      const results = await Promise.all([
        reconciler.run(BATCH),
        reconciler.run(BATCH),
      ]);

      expect(results.map((r) => r.recovered).sort()).toEqual([0, 1]);
      expect(results.map((r) => r.discarded).sort()).toEqual([0, 1]);
      expect(publish).toHaveBeenCalledTimes(1);
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: null,
      });
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 2)]);
    });

    it('should never pass the limit of recoveries, and end in PROCESSING_INCONSISTENT at the limit', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        processing_recoveries: 1,
      });
      reservationBarrier(2);

      await Promise.all([reconciler.run(BATCH), reconciler.run(BATCH)]);

      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 2,
      });
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 2)]);

      // The job of the last generation disappears: at the limit, no new generation.
      jest.restoreAllMocks();
      await queue.remove(jobIdOf(video, 2));
      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        closed: 1,
        recovered: 0,
      });
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'PROCESSING_INCONSISTENT',
        processing_recoveries: 2,
        processing_dispatch: 2,
      });
      expect(await jobIdsOf(video)).toEqual([]);
    });
  });

  describe('order of the reads (scenario 3)', () => {
    /** Holds the first observation of the queue after it was made, until released. */
    function holdFirstObservation() {
      const reached = gate();
      const released = gate();
      const real = queue.getJobState.bind(queue) as Queue['getJobState'];
      let calls = 0;
      jest
        .spyOn(queue, 'getJobState')
        .mockImplementation(async (jobId: string) => {
          calls += 1;
          const state = await real(jobId);
          if (calls === 1) {
            reached.open();
            await released.opened;
          }
          return state;
        });
      return { reached: reached.opened, release: released.open };
    }

    it('should discard the R1 of a reconciliation whose retrato another one superseded, with a new attempt assumed meanwhile', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      const g1 = jobIdOf(video, 1);
      await dispatcher.publish({ videoId: video.id, run: 1, dispatch: 1 });
      await driveJob(queue, QUEUE_PREFIX, g1, () => Promise.resolve(), [
        'completed',
      ]);
      const held = holdFirstObservation();
      const publish = jest.spyOn(dispatcher, 'publish');

      // A reads R (generation 1) and sees the job completed.
      const first = reconciler.run(BATCH);
      await held.reached;
      // B, with the same R, reserves generation 2 and publishes; an attempt of 2 assumes.
      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        recovered: 1,
      });
      const attemptId = randomUUID();
      await dataSource.query(
        `UPDATE videos SET current_attempt_id = $2, attempt_fence_dispatch = 2, attempt_fence_seq = 1 WHERE id = $1`,
        [video.id, attemptId],
      );
      held.release();

      await expect(first).resolves.toMatchObject({
        recovered: 0,
        discarded: 1,
      });
      expect(publish).toHaveBeenCalledTimes(1);
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        processing_dispatch: 2,
        processing_recoveries: 1,
        current_attempt_id: attemptId,
        attempt_fence_dispatch: 2,
      });
    });

    it('should discard the closure of a reconciliation whose retrato changed, leaving the video in processing', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        processing_dispatch: 3,
        processing_recoveries: 2,
      });
      const g3 = jobIdOf(video, 3);
      await dispatcher.publish({ videoId: video.id, run: 1, dispatch: 3 });
      await driveJob(queue, QUEUE_PREFIX, g3, () => Promise.resolve(), [
        'completed',
      ]);
      const held = holdFirstObservation();

      const first = reconciler.run(BATCH);
      await held.reached;
      // A late attempt of the generation assumes after the observation.
      await dataSource.query(
        `UPDATE videos SET current_attempt_id = $2, attempt_fence_dispatch = 3, attempt_fence_seq = 2 WHERE id = $1`,
        [video.id, randomUUID()],
      );
      held.release();

      await expect(first).resolves.toMatchObject({ closed: 0, discarded: 1 });
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        error_code: null,
      });
      expect((await queue.getJobState(g3)) as JobState).toBe('completed');
    });
  });

  describe('failure between the database and the queue (scenario 4)', () => {
    it('should, after a failure between R1 and the add, add the same generation on the resumption without counting again', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      jest
        .spyOn(dispatcher, 'publish')
        .mockRejectedValueOnce(new Error('redis unreachable'));

      await expect(reconciler.run(BATCH)).rejects.toThrow(
        'reconciliation of the processing: 1 failures',
      );
      const reserved = await reloadVideo(dataSource, video.id);
      expect(reserved).toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: VideoPendingJobAction.REPUBLISH,
        pending_job_dispatch: 2,
      });
      expect(await jobIdsOf(video)).toEqual([]);

      // Within the deadline of the action, nobody acts; once expired, it is resumed.
      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        untouched: 1,
      });
      await expirePendingAction(video);
      const publish = jest.spyOn(dispatcher, 'publish');

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        resumed: 1,
        recovered: 0,
      });

      expect(publish).toHaveBeenCalledWith({
        videoId: video.id,
        run: 1,
        dispatch: 2,
      });
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: null,
        pending_job_token: null,
      });
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 2)]);
    });

    it('should, after a failure between the add and R3, only confirm on the resumption', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      jest
        .spyOn(dispatcher, 'confirm')
        .mockRejectedValueOnce(new Error('database unreachable'));
      await expect(reconciler.run(BATCH)).rejects.toThrow();
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 2)]);
      await expirePendingAction(video);
      const publish = jest.spyOn(dispatcher, 'publish');

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        resumed: 1,
      });

      expect(publish).not.toHaveBeenCalled();
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: null,
      });
    });
  });

  describe('concurrent resumptions of the same expired action', () => {
    it('should let one reconciliation take the action over and add the job once', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: VideoPendingJobAction.REPUBLISH,
        pending_job_dispatch: 2,
        pending_job_token: randomUUID(),
        pending_job_expires_at: new Date(Date.now() - 1_000),
      });
      const real = repository.takeOverAction.bind(
        repository,
      ) as ProcessingReconciliationRepository['takeOverAction'];
      const both = gate();
      let arrived = 0;
      jest
        .spyOn(repository, 'takeOverAction')
        .mockImplementation(async (...args) => {
          arrived += 1;
          if (arrived === 2) {
            both.open();
          }
          await both.opened;
          return real(...args);
        });
      const publish = jest.spyOn(dispatcher, 'publish');

      const results = await Promise.all([
        reconciler.run(BATCH),
        reconciler.run(BATCH),
      ]);

      expect(results.map((r) => r.resumed).sort()).toEqual([0, 1]);
      expect(results.map((r) => r.discarded).sort()).toEqual([0, 1]);
      expect(publish).toHaveBeenCalledTimes(1);
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: null,
      });
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 2)]);
    });
  });

  describe('waits on the queue (limit of SI-03.16)', () => {
    it('should stop waiting for a slow add, keep the action for P5, and only confirm after the late add', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      const realPublish = dispatcher.publish.bind(
        dispatcher,
      ) as VideoJobDispatcherService['publish'];
      const lateAdd = gate();
      let added: Promise<unknown> = Promise.resolve();
      const publish = jest.spyOn(dispatcher, 'publish');
      publish.mockImplementationOnce((identity) => {
        // The add only reaches Redis after the reconciliation gave up waiting.
        added = lateAdd.opened.then(() => realPublish(identity));
        return added as ReturnType<VideoJobDispatcherService['publish']>;
      });
      const startedAt = Date.now();

      await expect(reconciler.run(BATCH)).rejects.toThrow('queue unavailable');

      expect(Date.now() - startedAt).toBeLessThan(
        VIDEO_JOB_PUBLISH_TIMEOUT_MS + 3_000,
      );
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: VideoPendingJobAction.REPUBLISH,
        pending_job_dispatch: 2,
      });
      expect(await jobIdsOf(video)).toEqual([]);

      // The add completes late: the job of the reserved generation exists.
      lateAdd.open();
      await added;
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 2)]);
      await expirePendingAction(video);
      publish.mockClear();

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        resumed: 1,
        recovered: 0,
      });

      expect(publish).not.toHaveBeenCalled();
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: null,
      });
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 2)]);
    }, 20_000);

    it('should not stay stuck on a queue that never answers: the run ends within the limit and changes nothing', async () => {
      const silent = await createReconciliationModule(QUEUE_PREFIX);
      const silentQueue = silent.get<Queue>(
        getQueueToken(VIDEO_QUEUES.PROCESSING),
      );
      try {
        const first = await saveProcessingVideo(dataSource, channel.id);
        const second = await saveProcessingVideo(dataSource, channel.id);
        const before = [
          await reloadVideo(dataSource, first.id),
          await reloadVideo(dataSource, second.id),
        ];
        // The queue never answers, as when Redis is unreachable (the add of BullMQ waits).
        jest
          .spyOn(silentQueue, 'getJobState')
          .mockImplementation(() => new Promise(() => undefined));
        const startedAt = Date.now();

        await expect(
          silent.get(ProcessingReconcilerService).run(BATCH),
        ).rejects.toThrow('queue unavailable');

        expect(Date.now() - startedAt).toBeLessThan(
          MAINTENANCE_QUEUE_TIMEOUT_MS + 3_000,
        );
        expect([
          await reloadVideo(dataSource, first.id),
          await reloadVideo(dataSource, second.id),
        ]).toEqual(before);
      } finally {
        await silent.close();
      }
    }, 20_000);
  });

  describe('resumption after a new anomaly (scenario 5)', () => {
    it('should only confirm a job that already completed without a transition, and count a new recovery in the next cycle', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      jest
        .spyOn(dispatcher, 'confirm')
        .mockRejectedValueOnce(new Error('process ended before R3'));
      await expect(reconciler.run(BATCH)).rejects.toThrow();
      // The job of generation 2 runs and completes without a transition.
      await driveJob(
        queue,
        QUEUE_PREFIX,
        jobIdOf(video, 2),
        () => Promise.resolve({ outcome: 'skipped' }),
        ['completed'],
      );
      await expirePendingAction(video);
      const publish = jest.spyOn(dispatcher, 'publish');

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        resumed: 1,
        recovered: 0,
      });
      expect(publish).not.toHaveBeenCalled();
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: null,
      });

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        recovered: 1,
        collected: 1,
      });
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 3,
        processing_recoveries: 2,
      });
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 3)]);
    });
  });

  describe('late executor with a lost token (scenario 6)', () => {
    it('should ignore the late add of the current generation and refuse its R3', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      jest
        .spyOn(dispatcher, 'publish')
        .mockRejectedValueOnce(new Error('executor stalled before the add'));
      await expect(reconciler.run(BATCH)).rejects.toThrow();
      const { pending_job_token: lateToken } = await reloadVideo(
        dataSource,
        video.id,
      );
      await expirePendingAction(video);
      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        resumed: 1,
      });
      const before = await reloadVideo(dataSource, video.id);
      const job = await queue.getJob(jobIdOf(video, 2));

      // The executor that lost its token wakes up: add of its generation, then R3.
      const late = await dispatcher.publish({
        videoId: video.id,
        run: 1,
        dispatch: 2,
      });
      const confirmed = await dispatcher.confirm({
        videoId: video.id,
        dispatch: 2,
        token: lateToken ?? '',
      });

      expect(late.stored?.data).toEqual(job?.data);
      expect(late.stored?.attemptsStarted).toBe(job?.attemptsStarted);
      expect(confirmed).toBe(false);
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 2)]);
      expect(await reloadVideo(dataSource, video.id)).toEqual(before);
    });

    it('should leave the late add of a superseded generation without effect on the database, collected once finished', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id);
      jest
        .spyOn(dispatcher, 'publish')
        .mockRejectedValueOnce(new Error('executor stalled before the add'));
      await expect(reconciler.run(BATCH)).rejects.toThrow();
      const { pending_job_token: lateToken } = await reloadVideo(
        dataSource,
        video.id,
      );
      await expirePendingAction(video);
      await reconciler.run(BATCH);
      // Generation 2 completes without a transition; the next cycle reserves 3 and collects 2.
      await driveJob(
        queue,
        QUEUE_PREFIX,
        jobIdOf(video, 2),
        () => Promise.resolve(),
        ['completed'],
      );
      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        recovered: 1,
        collected: 1,
      });
      // Generation 3 runs and completes as well; the database is still in processing.
      await driveJob(
        queue,
        QUEUE_PREFIX,
        jobIdOf(video, 3),
        () => Promise.resolve(),
        ['completed'],
      );
      const before = await reloadVideo(dataSource, video.id);

      // The late executor of generation 2 adds its job again and tries its R3.
      await dispatcher.publish({ videoId: video.id, run: 1, dispatch: 2 });
      const confirmed = await dispatcher.confirm({
        videoId: video.id,
        dispatch: 2,
        token: lateToken ?? '',
      });
      expect(confirmed).toBe(false);
      expect(await reloadVideo(dataSource, video.id)).toEqual(before);
      // Its delivery finds nothing to assume (P3) and completes; the collection removes it.
      await driveJob(
        queue,
        QUEUE_PREFIX,
        jobIdOf(video, 2),
        () => Promise.resolve({ outcome: 'skipped' }),
        ['completed'],
      );
      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        collected: 2,
      });
      expect(await queue.getJob(jobIdOf(video, 2))).toBeUndefined();
    });
  });

  describe('job of the current generation removed from outside after an accepted delivery (scenario 7)', () => {
    it('should not repeat the add, close the action, and count a new recovery in the next cycle', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        processing_dispatch: 2,
        processing_recoveries: 1,
        current_attempt_id: randomUUID(),
        attempt_fence_dispatch: 2,
        attempt_fence_seq: 1,
        pending_job_action: VideoPendingJobAction.REPUBLISH,
        pending_job_dispatch: 2,
        pending_job_token: randomUUID(),
        pending_job_expires_at: new Date(Date.now() - 1_000),
      });
      const publish = jest.spyOn(dispatcher, 'publish');
      const error = jest.spyOn(Logger.prototype, 'error');

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        resumed: 1,
        recovered: 0,
      });

      expect(publish).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'video-maintenance.reconcile-lost-job',
          jobId: jobIdOf(video, 2),
        }),
      );
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 2,
        processing_recoveries: 1,
        pending_job_action: null,
      });
      expect(await jobIdsOf(video)).toEqual([]);

      await expect(reconciler.run(BATCH)).resolves.toMatchObject({
        recovered: 1,
      });
      await expect(reloadVideo(dataSource, video.id)).resolves.toMatchObject({
        processing_dispatch: 3,
        processing_recoveries: 2,
        current_attempt_id: null,
      });
      expect(await jobIdsOf(video)).toEqual([jobIdOf(video, 3)]);
    });
  });
});
