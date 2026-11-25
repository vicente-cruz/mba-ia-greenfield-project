// First: the `@Processor` options read the configuration when the processor module is evaluated.
import './config/load-env-file.side-effect';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

/**
 * Entrypoint of the `video-worker` service (TD-10): an application context, without an HTTP
 * server. The shutdown hooks turn SIGTERM and SIGINT into `app.close()`, which runs
 * `onModuleDestroy`/`onApplicationShutdown` of every module: the BullMQ workers registered by
 * `@Processor` are closed there and wait for their active jobs (`worker.close()`), and the
 * connections to the database, the Redis and the storage are closed after them.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log(`video-worker started (pid ${process.pid})`, 'Worker');
}
void bootstrap();
