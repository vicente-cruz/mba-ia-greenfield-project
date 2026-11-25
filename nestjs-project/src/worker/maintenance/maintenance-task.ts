import type { MaintenanceJobName } from './maintenance.constants';

/** Payload of the maintenance jobs ("Events/Messages"). */
export interface MaintenanceJobData {
  batchSize: number;
}

/** One kind of maintenance, run for a job of its name. */
export interface MaintenanceTask {
  run(data: MaintenanceJobData): Promise<unknown>;
}

export type MaintenanceTasks = Record<MaintenanceJobName, MaintenanceTask>;

/** The task of each job name, consumed by `MaintenanceProcessor`. */
export const MAINTENANCE_TASKS = Symbol('MAINTENANCE_TASKS');

/** The service of this maintenance does not exist yet: the job fails, it never counts as done. */
export class MaintenanceTaskPendingError extends Error {
  constructor(
    readonly jobName: MaintenanceJobName,
    readonly implementedBy: string,
  ) {
    super(
      `maintenance "${jobName}" is not implemented yet (${implementedBy}); nothing was done`,
    );
    this.name = 'MaintenanceTaskPendingError';
  }
}

function pendingTask(
  jobName: MaintenanceJobName,
  implementedBy: string,
): MaintenanceTask {
  return {
    run: () =>
      Promise.reject(new MaintenanceTaskPendingError(jobName, implementedBy)),
  };
}

/**
 * The tasks until their services exist: the sweep (SI-03.24), the reconciliation (SI-03.25) and
 * the cleanup (SI-03.26). Each SI replaces its entry with the real service.
 */
export function pendingMaintenanceTasks(): MaintenanceTasks {
  return {
    'sweep-upload-sessions': pendingTask('sweep-upload-sessions', 'SI-03.24'),
    'reconcile-processing': pendingTask('reconcile-processing', 'SI-03.25'),
    'cleanup-storage': pendingTask('cleanup-storage', 'SI-03.26'),
  };
}
