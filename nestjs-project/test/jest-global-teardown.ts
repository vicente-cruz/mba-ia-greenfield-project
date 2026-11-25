import '../src/config/load-env-file.side-effect';
import { VideoQueuesControl } from './helpers/queues';

/** After the unit and integration suites: resumes the real queues paused by the setup. */
export default async function globalTeardown(): Promise<void> {
  const queues = new VideoQueuesControl();
  try {
    await queues.resumeAll();
  } finally {
    await queues.close();
  }
}
