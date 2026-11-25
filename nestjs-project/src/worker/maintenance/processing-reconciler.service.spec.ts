import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import videoConfig from '../../config/video.config';
import {
  VideoPendingJobAction,
  VideoStatus,
} from '../../videos/entities/video.entity';
import { VideoJobDispatcherService } from '../../videos/jobs/video-job-dispatcher.service';
import { VIDEO_QUEUES } from '../../videos/videos.constants';
import {
  decideResumption,
  decideWithoutPendingAction,
  type JobObservation,
  MISSING_JOB,
  type ProcessingSnapshot,
  STALL_FAILED_REASON,
} from './processing-reconciliation.decisions';
import { ProcessingReconciliationRepository } from './processing-reconciliation.repository';
import {
  isCollectable,
  ProcessingReconcilerService,
} from './processing-reconciler.service';

const VIDEO_ID = '0b5c3f0e-4a59-4c5b-9a43-6b2f6f1d8e21';
const NOW = 1_800_000_000_000;
const POLICY = { maxRecoveries: 2, stuckAlertMs: 600_000, now: NOW };

function snapshot(
  overrides: Partial<ProcessingSnapshot> = {},
): ProcessingSnapshot {
  return {
    videoId: VIDEO_ID,
    run: 1,
    dispatch: 1,
    recoveries: 0,
    attemptId: null,
    fenceDispatch: null,
    fenceSeq: null,
    pendingAction: null,
    pendingDispatch: null,
    pendingToken: null,
    pendingExpired: false,
    ...overrides,
  };
}

/** A page of `findSnapshots` with these retratos and no further position. */
function page(...snapshots: ProcessingSnapshot[]) {
  return { snapshots, last: null };
}

function job(
  state: JobObservation['state'],
  overrides: Partial<JobObservation> = {},
): JobObservation {
  return {
    state,
    attemptsStarted: 1,
    failedReason: null,
    timestamp: NOW,
    ...overrides,
  };
}

describe('ProcessingReconcilerService', () => {
  describe('decision for the job of the retrato without a pending action (G-05)', () => {
    it.each<[string, JobObservation, number, string, string | null]>([
      ['missing', MISSING_JOB, 0, 'reserve-generation', null],
      [
        'missing at the limit',
        MISSING_JOB,
        2,
        'close',
        'PROCESSING_INCONSISTENT',
      ],
      [
        'completed without transition',
        job('completed'),
        1,
        'reserve-generation',
        null,
      ],
      [
        'completed at the limit',
        job('completed'),
        2,
        'close',
        'PROCESSING_INCONSISTENT',
      ],
      [
        'failed by stall above maxStalledCount',
        job('failed', { failedReason: STALL_FAILED_REASON }),
        0,
        'close',
        'PROCESSING_STALLED',
      ],
      [
        'failed by its last attempt',
        job('failed', { failedReason: 'storage reset' }),
        0,
        'close',
        'PROCESSING_FAILED',
      ],
      [
        'failed, even with recoveries left',
        job('failed', { failedReason: 'x' }),
        1,
        'close',
        'PROCESSING_FAILED',
      ],
      ['waiting', job('waiting'), 0, 'wait', null],
      ['delayed', job('delayed'), 0, 'wait', null],
      ['prioritized', job('prioritized'), 0, 'wait', null],
      ['active', job('active'), 0, 'none', null],
    ])('%s → %s', (_, observation, recoveries, kind, code) => {
      const decision = decideWithoutPendingAction(
        snapshot({ recoveries }),
        observation,
        POLICY,
      );

      expect(decision.kind).toBe(kind);
      if (decision.kind === 'close') {
        expect(decision.code).toBe(code);
        expect(decision.failedJob).toBe(observation.state === 'failed');
      }
    });

    it.each([
      [POLICY.stuckAlertMs + 1, true],
      [POLICY.stuckAlertMs, false],
    ])('should alert a job waiting for %s ms: %s', (waitingMs, stuck) => {
      expect(
        decideWithoutPendingAction(
          snapshot(),
          job('waiting', { timestamp: NOW - waitingMs }),
          POLICY,
        ),
      ).toEqual({ kind: 'wait', stuck });
    });
  });

  describe('decision of the resumption by evidence (P5)', () => {
    const pending = (fenceDispatch: number | null) =>
      snapshot({
        dispatch: 3,
        pendingAction: VideoPendingJobAction.REPUBLISH,
        pendingDispatch: 3,
        pendingToken: 'old-token',
        pendingExpired: true,
        fenceDispatch,
        fenceSeq: fenceDispatch === null ? null : 1,
      });

    it.each(['waiting', 'delayed', 'active', 'completed', 'failed'] as const)(
      'should only confirm when the job g exists, %s',
      (state) => {
        expect(decideResumption(pending(2), job(state))).toBe('confirm');
      },
    );

    it.each([null, 2])(
      'should publish g again and confirm when the job is missing and the fence (%s) has no token of g',
      (fenceDispatch) => {
        expect(decideResumption(pending(fenceDispatch), MISSING_JOB)).toBe(
          'publish-and-confirm',
        );
      },
    );

    it('should close the action without an add when the job of g is missing after an accepted delivery', () => {
      expect(decideResumption(pending(3), MISSING_JOB)).toBe('close-lost-job');
    });
  });

  describe('confirmations of the collection (P5)', () => {
    it.each<
      [
        string,
        { run: number; dispatch: number },
        VideoStatus,
        number,
        number,
        boolean,
      ]
    >([
      [
        'terminal ready, same run',
        { run: 1, dispatch: 1 },
        VideoStatus.READY,
        1,
        1,
        true,
      ],
      [
        'terminal error, same run',
        { run: 1, dispatch: 2 },
        VideoStatus.ERROR,
        1,
        2,
        true,
      ],
      [
        'superseded generation',
        { run: 1, dispatch: 1 },
        VideoStatus.PROCESSING,
        1,
        2,
        true,
      ],
      [
        'older run',
        { run: 1, dispatch: 3 },
        VideoStatus.PROCESSING,
        2,
        1,
        true,
      ],
      [
        'current generation in processing',
        { run: 1, dispatch: 2 },
        VideoStatus.PROCESSING,
        1,
        2,
        false,
      ],
      [
        'terminal of another run is not this one',
        { run: 2, dispatch: 1 },
        VideoStatus.READY,
        1,
        1,
        false,
      ],
    ])('%s → %s', (_, jobIdentity, status, run, dispatch, collectable) => {
      expect(isCollectable(jobIdentity, { status, run, dispatch })).toBe(
        collectable,
      );
    });
  });

  describe('order of P5 with doubles', () => {
    let service: ProcessingReconcilerService;
    let repository: {
      findSnapshots: jest.Mock;
      reserveGeneration: jest.Mock;
      closeInError: jest.Mock;
      takeOverAction: jest.Mock;
      collectionFacts: jest.Mock;
    };
    let dispatcher: { publish: jest.Mock; confirm: jest.Mock };
    let queue: {
      getJobState: jest.Mock;
      getJob: jest.Mock;
      getJobs: jest.Mock;
      remove: jest.Mock;
    };

    beforeEach(async () => {
      repository = {
        findSnapshots: jest.fn().mockResolvedValue(page(snapshot())),
        reserveGeneration: jest.fn().mockResolvedValue(2),
        closeInError: jest.fn().mockResolvedValue(true),
        takeOverAction: jest.fn().mockResolvedValue(true),
        collectionFacts: jest.fn().mockResolvedValue(new Map()),
      };
      dispatcher = {
        publish: jest.fn().mockResolvedValue({ jobId: 'j', stored: null }),
        confirm: jest.fn().mockResolvedValue(true),
      };
      queue = {
        getJobState: jest.fn().mockResolvedValue('unknown'),
        getJob: jest.fn().mockResolvedValue(undefined),
        getJobs: jest.fn().mockResolvedValue([]),
        remove: jest.fn().mockResolvedValue(1),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          ProcessingReconcilerService,
          { provide: ProcessingReconciliationRepository, useValue: repository },
          { provide: VideoJobDispatcherService, useValue: dispatcher },
          { provide: getQueueToken(VIDEO_QUEUES.PROCESSING), useValue: queue },
          {
            provide: videoConfig.KEY,
            useValue: {
              processingReconcileGraceMs: 300_000,
              processingJobActionTtlSeconds: 120,
              processingMaxRecoveries: 2,
              processingStuckAlertMs: 600_000,
            },
          },
        ],
      }).compile();
      service = moduleRef.get(ProcessingReconcilerService);
    });

    it('should ask the queue about the job of the retrato, reserve with its guard and publish the reserved generation', async () => {
      await expect(service.run({ batchSize: 10 })).resolves.toMatchObject({
        examined: 1,
        recovered: 1,
      });

      expect(queue.getJobState).toHaveBeenCalledWith(`video-${VIDEO_ID}-1-1`);
      expect(repository.reserveGeneration).toHaveBeenCalledWith(
        snapshot(),
        expect.any(String),
        120,
        2,
      );
      const [, token] = repository.reserveGeneration.mock.calls[0] as [
        unknown,
        string,
      ];
      expect(dispatcher.publish).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        run: 1,
        dispatch: 2,
      });
      expect(dispatcher.confirm).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        dispatch: 2,
        token,
      });
      expect(queue.getJobState.mock.invocationCallOrder[0]).toBeLessThan(
        repository.reserveGeneration.mock.invocationCallOrder[0],
      );
    });

    it('should discard the retrato and its observation when the reservation affects zero rows, without any add', async () => {
      repository.reserveGeneration.mockResolvedValue(null);

      await expect(service.run({ batchSize: 10 })).resolves.toMatchObject({
        recovered: 0,
        discarded: 1,
      });

      expect(dispatcher.publish).not.toHaveBeenCalled();
      expect(dispatcher.confirm).not.toHaveBeenCalled();
      expect(repository.closeInError).not.toHaveBeenCalled();
    });

    it('should discard a closure that affects zero rows and keep the job', async () => {
      repository.findSnapshots.mockResolvedValue(
        page(snapshot({ recoveries: 2 })),
      );
      repository.closeInError.mockResolvedValue(false);
      queue.getJobState.mockResolvedValue('completed');
      queue.getJob.mockResolvedValue({ attemptsStarted: 1, timestamp: NOW });

      await expect(service.run({ batchSize: 10 })).resolves.toMatchObject({
        closed: 0,
        discarded: 1,
      });

      expect(queue.remove).not.toHaveBeenCalled();
    });

    it('should resume an expired action with the generation it reserved, never a re-read dispatch, and count no recovery', async () => {
      repository.findSnapshots.mockResolvedValue(
        page(
          snapshot({
            dispatch: 3,
            recoveries: 1,
            pendingAction: VideoPendingJobAction.REPUBLISH,
            pendingDispatch: 2,
            pendingToken: 'old-token',
            pendingExpired: true,
          }),
        ),
      );

      await expect(service.run({ batchSize: 10 })).resolves.toMatchObject({
        resumed: 1,
        recovered: 0,
      });

      expect(queue.getJobState).toHaveBeenCalledWith(`video-${VIDEO_ID}-1-2`);
      expect(repository.reserveGeneration).not.toHaveBeenCalled();
      expect(dispatcher.publish).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        run: 1,
        dispatch: 2,
      });
    });

    it('should leave a pending action within its deadline to its owner', async () => {
      repository.findSnapshots.mockResolvedValue(
        page(
          snapshot({
            pendingAction: VideoPendingJobAction.PUBLISH,
            pendingDispatch: 1,
            pendingToken: 't',
            pendingExpired: false,
          }),
        ),
      );

      await expect(service.run({ batchSize: 10 })).resolves.toMatchObject({
        untouched: 1,
      });

      expect(queue.getJobState).not.toHaveBeenCalled();
      expect(repository.takeOverAction).not.toHaveBeenCalled();
    });

    it('should not publish nor confirm when the takeover of the action affects zero rows', async () => {
      repository.findSnapshots.mockResolvedValue(
        page(
          snapshot({
            pendingAction: VideoPendingJobAction.REPUBLISH,
            pendingDispatch: 2,
            pendingToken: 'old-token',
            pendingExpired: true,
          }),
        ),
      );
      repository.takeOverAction.mockResolvedValue(false);

      await expect(service.run({ batchSize: 10 })).resolves.toMatchObject({
        discarded: 1,
        resumed: 0,
      });

      expect(dispatcher.publish).not.toHaveBeenCalled();
      expect(dispatcher.confirm).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'should refuse a batchSize of %s',
      async (batchSize) => {
        await expect(service.run({ batchSize })).rejects.toThrow(
          'invalid batchSize',
        );
      },
    );
  });
});
