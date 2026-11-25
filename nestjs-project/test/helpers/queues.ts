import { Queue } from 'bullmq';
import queueConfig from '../../src/config/queue.config';
import { VIDEO_QUEUES } from '../../src/videos/videos.constants';

/** `clean` removes at most this many jobs per call; the helper repeats it until fewer come back. */
const CLEAN_BATCH = 1000;
const POLL_INTERVAL_MS = 100;
/** A job of `video-processing` runs at most a few FFmpeg calls of `VIDEO_PROCESSING_TIMEOUT_MS`. */
const DEFAULT_ACTIVE_WAIT_MS = 3 * queueConfig().videoProcessing.timeoutMs;

/**
 * Controls the real queues of the environment from the E2E specs of the phase, without replacing
 * them (R-10). It opens its own connections, with the Redis of `.env`, so it does not depend on
 * the application under test.
 *
 * Lifecycle of a suite:
 * - `beforeAll`: `pauseAll()`;
 * - before each scenario: `prepareScenario()`;
 * - in a scenario that needs real processing, after checking the intermediate state:
 *   `resumeProcessing()`;
 * - `afterAll`: `restore()`, which leaves both queues running, the normal state of the
 *   environment.
 *
 * A run interrupted before `afterAll` leaves the queues paused until another suite finishes or a
 * manual `resume`.
 */
export class VideoQueuesControl {
  readonly processing: Queue;
  readonly maintenance: Queue;

  constructor() {
    const { host, port } = queueConfig().redis;
    const connection = { host, port };
    this.processing = new Queue(VIDEO_QUEUES.PROCESSING, { connection });
    this.maintenance = new Queue(VIDEO_QUEUES.MAINTENANCE, { connection });
  }

  /**
   * Pauses both queues globally and waits until no job of them is active: a global pause does not
   * interrupt the job a worker already holds.
   */
  async pauseAll(activeWaitMs = DEFAULT_ACTIVE_WAIT_MS): Promise<void> {
    await this.processing.pause();
    await this.maintenance.pause();
    await this.waitUntilIdle(this.processing, activeWaitMs);
    await this.waitUntilIdle(this.maintenance, activeWaitMs);
  }

  /**
   * Makes sure both queues are paused and idle, then removes the jobs of `video-processing` only:
   * waiting and delayed (`drain(true)`), completed and failed. `video-maintenance` is never
   * cleaned, so the next job of its Job Schedulers is kept.
   */
  async prepareScenario(activeWaitMs = DEFAULT_ACTIVE_WAIT_MS): Promise<void> {
    await this.pauseAll(activeWaitMs);
    await this.cleanProcessing();
  }

  /** Lets the worker take jobs of `video-processing`; `video-maintenance` stays paused. */
  async resumeProcessing(): Promise<void> {
    await this.processing.resume();
  }

  /** Resumes both queues without removing any job: the schedulers and their jobs are kept. */
  async resumeAll(): Promise<void> {
    await this.processing.resume();
    await this.maintenance.resume();
  }

  /** Closes the connections of the helper. */
  async close(): Promise<void> {
    await this.processing.close();
    await this.maintenance.close();
  }

  /**
   * Removes the jobs left by the suite in `video-processing`, resumes both queues and closes the
   * connections of the helper, even if the cleanup fails.
   */
  async restore(activeWaitMs = DEFAULT_ACTIVE_WAIT_MS): Promise<void> {
    try {
      await this.pauseAll(activeWaitMs);
      await this.cleanProcessing();
    } finally {
      try {
        await this.processing.resume();
        await this.maintenance.resume();
      } finally {
        await this.processing.close();
        await this.maintenance.close();
      }
    }
  }

  private async cleanProcessing(): Promise<void> {
    await this.processing.drain(true);
    for (const type of ['completed', 'failed'] as const) {
      let removed: string[];
      do {
        removed = await this.processing.clean(0, CLEAN_BATCH, type);
      } while (removed.length === CLEAN_BATCH);
    }
  }

  private async waitUntilIdle(queue: Queue, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const active = await queue.getActiveCount();
      if (active === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${queue.name} still has ${active} active job(s) after ${timeoutMs} ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}
