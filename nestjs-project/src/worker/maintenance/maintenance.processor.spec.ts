import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UnrecoverableError, type Job } from 'bullmq';
import { MAINTENANCE_JOBS } from './maintenance.constants';
import { MaintenanceProcessor } from './maintenance.processor';
import {
  MAINTENANCE_TASKS,
  type MaintenanceJobData,
  MaintenanceTaskPendingError,
  pendingMaintenanceTasks,
} from './maintenance-task';

function jobNamed(name: string): Job<MaintenanceJobData> {
  return {
    id: `repeat:${name}:1`,
    name,
    data: { batchSize: 25 },
  } as Job<MaintenanceJobData>;
}

describe('MaintenanceProcessor', () => {
  let processor: MaintenanceProcessor;
  let tasks: Record<string, { run: jest.Mock }>;

  beforeEach(async () => {
    tasks = {
      [MAINTENANCE_JOBS.SWEEP_UPLOAD_SESSIONS]: {
        run: jest.fn().mockResolvedValue({ swept: 1 }),
      },
      [MAINTENANCE_JOBS.RECONCILE_PROCESSING]: {
        run: jest.fn().mockResolvedValue({ reconciled: 2 }),
      },
      [MAINTENANCE_JOBS.CLEANUP_STORAGE]: {
        run: jest.fn().mockResolvedValue({ removed: 3 }),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MaintenanceProcessor,
        { provide: MAINTENANCE_TASKS, useValue: tasks },
      ],
    }).compile();
    processor = moduleRef.get(MaintenanceProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    [MAINTENANCE_JOBS.SWEEP_UPLOAD_SESSIONS, { swept: 1 }],
    [MAINTENANCE_JOBS.RECONCILE_PROCESSING, { reconciled: 2 }],
    [MAINTENANCE_JOBS.CLEANUP_STORAGE, { removed: 3 }],
  ])(
    'should dispatch %s to its task only, with the payload of the job',
    async (name, result) => {
      await expect(processor.process(jobNamed(name))).resolves.toEqual(result);

      for (const [taskName, task] of Object.entries(tasks)) {
        if (taskName === name) {
          expect(task.run).toHaveBeenCalledWith({ batchSize: 25 });
        } else {
          expect(task.run).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(['purge-everything', 'constructor', 'toString', ''])(
    'should log an unknown job name "%s" as an error and fail without retries, running no task',
    async (name) => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await expect(processor.process(jobNamed(name))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'video-maintenance.unknown-job',
          name,
        }),
      );
      for (const task of Object.values(tasks)) {
        expect(task.run).not.toHaveBeenCalled();
      }
    },
  );

  it('should let the failure of a task fail the job', async () => {
    tasks[MAINTENANCE_JOBS.CLEANUP_STORAGE].run.mockRejectedValue(
      new Error('storage unavailable'),
    );

    await expect(
      processor.process(jobNamed(MAINTENANCE_JOBS.CLEANUP_STORAGE)),
    ).rejects.toThrow('storage unavailable');
  });

  describe('pending tasks', () => {
    it.each([
      [MAINTENANCE_JOBS.SWEEP_UPLOAD_SESSIONS, 'SI-03.24'],
      [MAINTENANCE_JOBS.RECONCILE_PROCESSING, 'SI-03.25'],
      [MAINTENANCE_JOBS.CLEANUP_STORAGE, 'SI-03.26'],
    ])(
      'should fail %s until %s implements it, never as maintenance done',
      async (name, implementedBy) => {
        const pending = pendingMaintenanceTasks();

        const error = await pending[name]
          .run({ batchSize: 25 })
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(MaintenanceTaskPendingError);
        expect(error).toMatchObject({ jobName: name, implementedBy });
        expect((error as Error).message).toContain('nothing was done');
      },
    );
  });
});
