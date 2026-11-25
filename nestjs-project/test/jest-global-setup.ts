// First: `queues.ts` reads the configuration when it is imported.
import '../src/config/load-env-file.side-effect';
import { VideoQueuesControl } from './helpers/queues';

/**
 * Before the unit and integration suites (`jest` config of package.json): pauses the real queues
 * of the environment and waits for their active jobs, so the `video-worker` running beside the
 * tests (its sweep, SI-03.24, and the maintenance of the next SIs) does not change the rows that
 * the suites write in the shared database. The schedulers and their jobs are kept;
 * `jest-global-teardown.ts` resumes the queues. The suites use queues of their own keyspace,
 * which this pause does not touch.
 *
 * It lives in `test/`, outside `src/`, so the builds of the API and of the worker do not compile
 * it: importing `test/helpers` from `src/` would move their output root.
 */
export default async function globalSetup(): Promise<void> {
  const queues = new VideoQueuesControl();
  try {
    await queues.pauseAll();
  } finally {
    await queues.close();
  }
}
