import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { buildVideo, saveTestChannel } from '../../test/video-entity-fixtures';
import { User } from '../../users/entities/user.entity';
import { UploadPart } from '../entities/upload-part.entity';
import { UploadSession } from '../entities/upload-session.entity';
import {
  Video,
  VideoPendingJobAction,
  VideoStatus,
} from '../entities/video.entity';
import { PROCESS_VIDEO_JOB_NAME, VIDEO_QUEUES } from '../videos.constants';
import { VideoJobDispatcherService } from './video-job-dispatcher.service';
import { parseVideoJobId, type ProcessVideoJobData } from './video-job-id';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

/**
 * Redis prefix of this suite: the queue is the real `video-processing`, in a keyspace of its own,
 * so no worker of the environment consumes these jobs and the suite never touches other jobs.
 */
const QUEUE_PREFIX = `test-dispatcher-${process.pid}`;

describe('VideoJobDispatcherService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue<ProcessVideoJobData>;
  let dispatcher: VideoJobDispatcherService;
  let videoId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        BullModule.forRoot({
          connection: {
            host: queueConfig().redis.host,
            port: queueConfig().redis.port,
          },
          prefix: QUEUE_PREFIX,
        }),
        BullModule.registerQueue({ name: VIDEO_QUEUES.PROCESSING }),
      ],
      providers: [VideoJobDispatcherService],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get(getQueueToken(VIDEO_QUEUES.PROCESSING));
    dispatcher = moduleRef.get(VideoJobDispatcherService);
  });

  afterAll(async () => {
    try {
      await queue.obliterate({ force: true });
    } finally {
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const channel = await saveTestChannel(dataSource);
    const { identifiers } = await videoRepository.insert(
      buildVideo(channel.id, { status: VideoStatus.PROCESSING }),
    );
    videoId = identifiers[0].id as string;
  });

  describe('publish (R2)', () => {
    it('should leave a single job video-{videoId}-{run}-1 after two adds of generation 1', async () => {
      const identity = { videoId, run: 1, dispatch: 1 };

      const first = await dispatcher.publish(identity);
      const second = await dispatcher.publish(identity);

      const jobs = await queue.getJobs();
      expect(jobs.map((job) => job.id)).toEqual([`video-${videoId}-1-1`]);
      expect(first.jobId).toBe(`video-${videoId}-1-1`);
      expect(second.jobId).toBe(first.jobId);
      expect(second.stored?.state).toBe('waiting');
      expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB_NAME);
      expect(jobs[0].data).toEqual({ videoId, run: 1 });
    });

    it('should keep the job after completion and failure: removeOnComplete and removeOnFail off', async () => {
      const { jobId, stored } = await dispatcher.publish({
        videoId,
        run: 1,
        dispatch: 1,
      });

      const job = await queue.getJob(jobId);
      expect(job?.opts.removeOnComplete).toBe(false);
      expect(job?.opts.removeOnFail).toBe(false);
      expect(stored?.opts).toEqual({
        attempts: queueConfig().videoProcessing.attempts,
        backoff: {
          type: 'exponential',
          delay: queueConfig().videoProcessing.backoffMs,
        },
        removeOnComplete: false,
        removeOnFail: false,
      });
    });

    it('should return the stored job, not the options of the ignored add', async () => {
      const jobId = `video-${videoId}-1-1`;
      await queue.add(
        PROCESS_VIDEO_JOB_NAME,
        { videoId, run: 1 },
        { jobId, attempts: 1 },
      );
      // What BullMQ returns for a duplicate add: the options of the call, not the stored ones.
      const ignored = await queue.add(
        PROCESS_VIDEO_JOB_NAME,
        { videoId, run: 1 },
        { jobId, attempts: 9 },
      );
      expect(ignored.opts.attempts).toBe(9);

      const { stored } = await dispatcher.publish({
        videoId,
        run: 1,
        dispatch: 1,
      });

      expect(stored?.opts.attempts).toBe(1);
      expect(stored?.opts.removeOnComplete).toBeUndefined();
      await expect(queue.getJobs()).resolves.toHaveLength(1);
    });

    it('should create a separate job for a new generation', async () => {
      await dispatcher.publish({ videoId, run: 1, dispatch: 1 });
      await dispatcher.publish({ videoId, run: 1, dispatch: 2 });

      const ids = (await queue.getJobs()).map((job) => job.id).sort();
      expect(ids).toEqual([`video-${videoId}-1-1`, `video-${videoId}-1-2`]);
    });

    it('should read the jobId back into the same videoId, run and dispatch', async () => {
      const identity = { videoId, run: 3, dispatch: 2 };
      const { jobId } = await dispatcher.publish(identity);

      const job = await queue.getJob(jobId);
      expect(job?.id).toBeDefined();
      expect(parseVideoJobId(job?.id ?? '')).toEqual(identity);
      expect(job?.data).toEqual({ videoId, run: 3 });
    });
  });

  describe('confirm (R3)', () => {
    const token = randomUUID();

    beforeEach(async () => {
      await videoRepository.update(
        { id: videoId },
        {
          processing_run: 1,
          processing_dispatch: 1,
          pending_job_action: VideoPendingJobAction.PUBLISH,
          pending_job_dispatch: 1,
          pending_job_token: token,
          pending_job_expires_at: new Date(Date.now() + 120_000),
        },
      );
    });

    async function pendingAction(): Promise<Partial<Video>> {
      const video = await videoRepository.findOneByOrFail({ id: videoId });
      return {
        pending_job_action: video.pending_job_action,
        pending_job_dispatch: video.pending_job_dispatch,
        pending_job_token: video.pending_job_token,
      };
    }

    it('should clear the pending action for the right token and generation', async () => {
      await expect(
        dispatcher.confirm({ videoId, token, dispatch: 1 }),
      ).resolves.toBe(true);

      const video = await videoRepository.findOneByOrFail({ id: videoId });
      expect(video).toMatchObject({
        pending_job_action: null,
        pending_job_dispatch: null,
        pending_job_token: null,
        pending_job_expires_at: null,
        processing_dispatch: 1,
      });
    });

    it('should affect zero rows with a wrong token', async () => {
      await expect(
        dispatcher.confirm({ videoId, token: randomUUID(), dispatch: 1 }),
      ).resolves.toBe(false);

      await expect(pendingAction()).resolves.toEqual({
        pending_job_action: VideoPendingJobAction.PUBLISH,
        pending_job_dispatch: 1,
        pending_job_token: token,
      });
    });

    it('should affect zero rows with a wrong generation', async () => {
      await expect(
        dispatcher.confirm({ videoId, token, dispatch: 2 }),
      ).resolves.toBe(false);

      await expect(pendingAction()).resolves.toEqual({
        pending_job_action: VideoPendingJobAction.PUBLISH,
        pending_job_dispatch: 1,
        pending_job_token: token,
      });
    });

    it('should affect zero rows when the action was already confirmed', async () => {
      await dispatcher.confirm({ videoId, token, dispatch: 1 });

      await expect(
        dispatcher.confirm({ videoId, token, dispatch: 1 }),
      ).resolves.toBe(false);
    });
  });
});
