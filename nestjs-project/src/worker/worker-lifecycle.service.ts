import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';

/**
 * Logs the shutdown of the `video-worker` with the signal that reached the Nest process. The
 * signal arrives through the shutdown hooks of `src/worker.ts`; a stop without this log means the
 * process was killed before Nest could close it.
 */
@Injectable()
export class WorkerLifecycleService
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger('Worker');

  beforeApplicationShutdown(signal?: string): void {
    this.logger.log(`video-worker stopping (${signal ?? 'close'})`);
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`video-worker stopped (${signal ?? 'close'})`);
  }
}
