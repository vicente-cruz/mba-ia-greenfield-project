import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { type Job, type JobState, Queue, Worker } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import videoConfig from '../config/video.config';
import { User } from '../users/entities/user.entity';
import { UploadPart } from '../videos/entities/upload-part.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoJobDispatcherService } from '../videos/jobs/video-job-dispatcher.service';
import type { ProcessVideoJobData } from '../videos/jobs/video-job-id';
import { VIDEO_QUEUES } from '../videos/videos.constants';
import { ProcessingReconciliationRepository } from '../worker/maintenance/processing-reconciliation.repository';
import { ProcessingReconcilerService } from '../worker/maintenance/processing-reconciler.service';
import { createTestDataSource } from './create-test-data-source';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

export const REDIS_CONNECTION = {
  host: queueConfig().redis.host,
  port: queueConfig().redis.port,
};

/** Settings of the reconciliation in the tests: no grace, so every `processing` video counts. */
export const RECONCILIATION_TEST_SETTINGS = {
  processingReconcileGraceMs: 0,
  processingJobActionTtlSeconds: 120,
  processingMaxRecoveries: 2,
  processingStuckAlertMs: 600_000,
};

/**
 * The reconciliation with its `video-processing` queue in the keyspace `prefix`: no worker of the
 * environment consumes it, and the jobs reach their states only through the workers of the test.
 */
export function createReconciliationModule(
  prefix: string,
  settings: Partial<typeof RECONCILIATION_TEST_SETTINGS> = {},
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [videoConfig, queueConfig],
      }),
      TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
      TypeOrmModule.forFeature([Video]),
      BullModule.forRoot({ connection: REDIS_CONNECTION, prefix }),
      BullModule.registerQueue({ name: VIDEO_QUEUES.PROCESSING }),
    ],
    providers: [
      VideoJobDispatcherService,
      ProcessingReconciliationRepository,
      ProcessingReconcilerService,
    ],
  })
    .overrideProvider(videoConfig.KEY)
    .useValue({
      ...videoConfig(),
      ...RECONCILIATION_TEST_SETTINGS,
      ...settings,
    })
    .compile();
}

/** The state of a job, read before anything else of it (SI-03.22). */
export async function waitForJobState(
  queue: Queue,
  jobId: string,
  states: (JobState | 'unknown')[],
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await queue.getJobState(jobId);
    if (states.includes(state)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} is ${state}, not ${states.join('/')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Runs a worker of the test on the keyspace `prefix` until the job reaches one of `states`, then
 * closes it. `processor` decides what the delivery does (complete, fail, hang).
 */
export async function driveJob(
  queue: Queue,
  prefix: string,
  jobId: string,
  processor: (job: Job<ProcessVideoJobData>) => Promise<unknown>,
  states: JobState[],
): Promise<void> {
  const worker = new Worker<ProcessVideoJobData>(
    VIDEO_QUEUES.PROCESSING,
    processor,
    { connection: REDIS_CONNECTION, prefix },
  );
  try {
    await waitForJobState(queue, jobId, states);
  } finally {
    await worker.close(true);
  }
}
