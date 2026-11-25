import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { S3Client } from '@aws-sdk/client-s3';
import { type Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { createStorageClient } from '../../storage/storage.clients';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { gate } from '../../test/locks';
import {
  decodeImage,
  readObject,
  reloadVideo,
  removeStorageOfVideos,
  saveProcessingVideo,
  thumbnailKeysOf,
  uploadOriginal,
} from '../../test/processing-fixtures';
import { saveTestChannel } from '../../test/video-entity-fixtures';
import { User } from '../../users/entities/user.entity';
import { UploadPart } from '../../videos/entities/upload-part.entity';
import { UploadSession } from '../../videos/entities/upload-session.entity';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import {
  buildVideoJobId,
  type ProcessVideoJobData,
} from '../../videos/jobs/video-job-id';
import {
  PROCESS_VIDEO_JOB_NAME,
  VIDEO_QUEUES,
} from '../../videos/videos.constants';
import { MediaTransientError } from '../media/media.errors';
import { MediaProbeService } from '../media/media-probe.service';
import { MediaProcessRunner } from '../media/media-process.runner';
import { ProcessingStateService } from './processing-state.service';
import {
  type ProcessVideoResult,
  VideoProcessingProcessor,
} from './video-processing.processor';

jest.setTimeout(60_000);

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
 * The real `video-processing` queue in a keyspace of its own, consumed only by the worker of this
 * suite: the `video-worker` of the environment consumes the default keyspace.
 */
const QUEUE_PREFIX = `test-video-processing-${process.pid}`;
/** Short retries of the suite; the options of the API are covered by SI-03.16. */
const RETRY_BACKOFF_MS = 100;

/** The worker side of the processing, with its queue in the keyspace `prefix`. */
function createProcessingModule(prefix: string): Promise<TestingModule> {
  const { host, port } = queueConfig().redis;
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, queueConfig],
      }),
      TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
      TypeOrmModule.forFeature([Video]),
      StorageModule,
      BullModule.forRoot({ connection: { host, port }, prefix }),
      BullModule.registerQueue({ name: VIDEO_QUEUES.PROCESSING }),
    ],
    providers: [
      MediaProcessRunner,
      MediaProbeService,
      ProcessingStateService,
      VideoProcessingProcessor,
    ],
  }).compile();
}

describe('VideoProcessingProcessor (integration)', () => {
  const config = storageConfig();
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let queue: Queue<ProcessVideoJobData>;
  let processor: VideoProcessingProcessor;
  let media: MediaProbeService;
  let storage: StorageService;
  let state: ProcessingStateService;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await createProcessingModule(QUEUE_PREFIX);
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get(getQueueToken(VIDEO_QUEUES.PROCESSING));
    processor = moduleRef.get(VideoProcessingProcessor);
    media = moduleRef.get(MediaProbeService);
    storage = moduleRef.get(StorageService);
    state = moduleRef.get(ProcessingStateService);
    // Starts the BullMQ worker of the processor (registration on `onModuleInit`).
    await moduleRef.init();
  });

  afterAll(async () => {
    try {
      await removeStorageOfVideos(dataSource, s3, config.bucket);
      await cleanAllTables(dataSource);
      await queue.obliterate({ force: true });
    } finally {
      s3.destroy();
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await removeStorageOfVideos(dataSource, s3, config.bucket);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    channel = await saveTestChannel(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A video in `processing` whose original is the fixture, as P2 leaves it. */
  async function processingVideo(
    fixture: string,
    contentType: string,
  ): Promise<Video> {
    const video = await saveProcessingVideo(dataSource, channel.id, {
      content_type: contentType,
    });
    const originalKey = await uploadOriginal(
      s3,
      config.bucket,
      video.id,
      fixture,
    );
    await dataSource
      .getRepository(Video)
      .update(video.id, { original_key: originalKey });
    return reloadVideo(dataSource, video.id);
  }

  /** The job of the current generation, as R2 of P5 adds it, with short retries. */
  async function enqueue(
    video: Video,
    options: {
      attempts?: number;
      run?: number;
      target?: Queue<ProcessVideoJobData>;
    } = {},
  ): Promise<string> {
    const jobId = buildVideoJobId({
      videoId: video.id,
      run: video.processing_run,
      dispatch: video.processing_dispatch,
    });
    await (options.target ?? queue).add(
      PROCESS_VIDEO_JOB_NAME,
      { videoId: video.id, run: options.run ?? video.processing_run },
      {
        jobId,
        attempts: options.attempts ?? 3,
        backoff: { type: 'fixed', delay: RETRY_BACKOFF_MS },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    return jobId;
  }

  /**
   * The job once finished. The state is read before the job: reading the job first could return
   * its hash from before the finishing script, with stale counters.
   */
  async function waitUntilFinished(
    jobId: string,
  ): Promise<Job<ProcessVideoJobData, ProcessVideoResult>> {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const jobState = await queue.getJobState(jobId);
      if (jobState === 'completed' || jobState === 'failed') {
        return (await queue.getJob(jobId)) as Job<
          ProcessVideoJobData,
          ProcessVideoResult
        >;
      }
      if (Date.now() > deadline) {
        throw new Error(`job ${jobId} is still ${jobState}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  function captureWarnings(): () => string {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    return () =>
      warn.mock.calls.map(([message]) => JSON.stringify(message)).join('\n');
  }

  describe('worker', () => {
    it('should run with the concurrency, lock and stall of the configuration, listening to stalled and failed', () => {
      const { videoProcessing, worker } = queueConfig();

      expect(processor.worker.opts).toMatchObject({
        concurrency: videoProcessing.concurrency,
        lockDuration: worker.lockDurationMs,
        stalledInterval: worker.stalledIntervalMs,
        maxStalledCount: worker.maxStalledCount,
        prefix: QUEUE_PREFIX,
      });
      expect(processor.worker.listenerCount('stalled')).toBeGreaterThan(0);
      expect(processor.worker.listenerCount('failed')).toBeGreaterThan(0);
    });
  });

  describe('job of the current generation (T-10)', () => {
    it.each([
      ['h264-aac-moov-end.mp4', 'video/mp4', '2.000', 'h264', 'aac'],
      ['vp9-opus.webm', 'video/webm', '2.008', 'vp9', 'opus'],
    ])(
      'should take %s to ready, with its metadata and the thumbnail of the attempt',
      async (fixture, contentType, duration, videoCodec, audioCodec) => {
        const video = await processingVideo(fixture, contentType);

        const job = await waitUntilFinished(await enqueue(video));

        expect(await job.getState()).toBe('completed');
        const { attemptId } = job.returnvalue;
        expect(job.returnvalue).toEqual({ outcome: 'ready', attemptId });
        const thumbnailKey = `thumbnails/${video.id}/${attemptId}.jpg`;
        expect(await reloadVideo(dataSource, video.id)).toMatchObject({
          status: VideoStatus.READY,
          duration_seconds: duration,
          width: 320,
          height: 240,
          video_codec: videoCodec,
          audio_codec: audioCodec,
          thumbnail_key: thumbnailKey,
          current_attempt_id: attemptId,
          attempt_fence_dispatch: 1,
          attempt_fence_seq: 1,
          error_code: null,
          error_message: null,
        });
        expect(await thumbnailKeysOf(s3, config.bucket, video.id)).toEqual([
          thumbnailKey,
        ]);
        const thumbnail = await readObject(s3, config.bucket, thumbnailKey);
        expect(thumbnail.contentType).toBe('image/jpeg');
        expect(decodeImage(thumbnail.body)).toEqual({
          codec: 'mjpeg',
          width: 320,
          height: 240,
        });
      },
    );

    it.each<[string, Partial<Video>]>([
      [
        'ready',
        {
          status: VideoStatus.READY,
          thumbnail_key: 'thumbnails/previous/attempt.jpg',
        },
      ],
      [
        'error',
        {
          status: VideoStatus.ERROR,
          error_code: 'MEDIA_INVALID',
          error_message: 'no video stream',
        },
      ],
    ])(
      'should end a job of a video already %s without FFmpeg, without writing to the storage and without changing the row',
      async (_, terminal) => {
        const video = await processingVideo(
          'h264-aac-faststart.mp4',
          'video/mp4',
        );
        await dataSource.getRepository(Video).update(video.id, terminal);
        const before = await reloadVideo(dataSource, video.id);
        const probe = jest.spyOn(media, 'probe');
        const frame = jest.spyOn(media, 'extractFrame');
        const put = jest.spyOn(storage, 'putObject');

        const job = await waitUntilFinished(await enqueue(video));

        expect(await job.getState()).toBe('completed');
        expect(job.returnvalue.outcome).toBe('skipped');
        expect(probe).not.toHaveBeenCalled();
        expect(frame).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
        expect(await reloadVideo(dataSource, video.id)).toEqual(before);
        expect(await thumbnailKeysOf(s3, config.bucket, video.id)).toEqual([]);
      },
    );

    it('should fail a job whose jobId does not match its payload, without retries and without effects', async () => {
      const video = await processingVideo(
        'h264-aac-faststart.mp4',
        'video/mp4',
      );
      const before = await reloadVideo(dataSource, video.id);
      const probe = jest.spyOn(media, 'probe');

      const job = await waitUntilFinished(await enqueue(video, { run: 2 }));

      expect(await job.getState()).toBe('failed');
      expect(job.attemptsMade).toBe(1);
      expect(job.failedReason).toMatch(/does not match its payload/);
      expect(probe).not.toHaveBeenCalled();
      expect(await reloadVideo(dataSource, video.id)).toEqual(before);
    });
  });

  describe('errors (T-14)', () => {
    it.each([
      ['invalid.mp4', 'video/mp4', 'MEDIA_INVALID'],
      ['truncated.mp4', 'video/mp4', 'MEDIA_INVALID'],
      ['qt-brand.mov', 'video/mp4', 'MEDIA_CONTAINER_MISMATCH'],
    ])(
      'should end %s in error %s without retries and without a thumbnail',
      async (fixture, contentType, code) => {
        const video = await processingVideo(fixture, contentType);
        const probe = jest.spyOn(media, 'probe');

        const job = await waitUntilFinished(await enqueue(video));

        expect(await job.getState()).toBe('failed');
        expect(job.attemptsStarted).toBe(1);
        expect(job.attemptsMade).toBe(1);
        expect(job.failedReason).toContain(code);
        expect(probe).toHaveBeenCalledTimes(1);
        const after = await reloadVideo(dataSource, video.id);
        expect(after).toMatchObject({
          status: VideoStatus.ERROR,
          error_code: code,
          thumbnail_key: null,
        });
        expect(after.error_message).toBeTruthy();
        expect(after.error_message).not.toMatch(/X-Amz-|\?/);
        expect(await thumbnailKeysOf(s3, config.bucket, video.id)).toEqual([]);
      },
    );

    it('should retry a transient error and publish ready in the second attempt', async () => {
      const video = await processingVideo(
        'h264-aac-faststart.mp4',
        'video/mp4',
      );
      jest
        .spyOn(media, 'probe')
        .mockRejectedValueOnce(
          new MediaTransientError(
            'ffprobe could not read the media: Connection reset by peer',
          ),
        );
      const recordError = jest.spyOn(state, 'recordError');

      const job = await waitUntilFinished(await enqueue(video));

      expect(await job.getState()).toBe('completed');
      expect(job.attemptsStarted).toBe(2);
      const { attemptId } = job.returnvalue;
      expect(job.returnvalue.outcome).toBe('ready');
      expect(recordError).not.toHaveBeenCalled();
      expect(await reloadVideo(dataSource, video.id)).toMatchObject({
        status: VideoStatus.READY,
        current_attempt_id: attemptId,
        attempt_fence_dispatch: 1,
        attempt_fence_seq: 2,
        thumbnail_key: `thumbnails/${video.id}/${attemptId}.jpg`,
      });
      expect(await thumbnailKeysOf(s3, config.bucket, video.id)).toEqual([
        `thumbnails/${video.id}/${attemptId}.jpg`,
      ]);
    });

    it('should record PROCESSING_FAILED only in the last attempt of a transient error, without signed URLs', async () => {
      const video = await processingVideo(
        'h264-aac-faststart.mp4',
        'video/mp4',
      );
      const statusAtEachAttempt: string[] = [];
      jest.spyOn(storage, 'putObject').mockImplementation(async () => {
        statusAtEachAttempt.push(
          (await reloadVideo(dataSource, video.id)).status,
        );
        throw new Error(
          'PutObject to http://storage:9000/streamtube/thumbnails/x.jpg?X-Amz-Signature=secret failed',
        );
      });
      const recordError = jest.spyOn(state, 'recordError');
      const warnings = captureWarnings();

      const job = await waitUntilFinished(
        await enqueue(video, { attempts: 2 }),
      );

      expect(await job.getState()).toBe('failed');
      expect(job.attemptsMade).toBe(2);
      expect(statusAtEachAttempt).toEqual([
        VideoStatus.PROCESSING,
        VideoStatus.PROCESSING,
      ]);
      expect(recordError).toHaveBeenCalledTimes(1);
      expect(recordError.mock.calls[0][1]).toBe('PROCESSING_FAILED');
      const after = await reloadVideo(dataSource, video.id);
      expect(after).toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'PROCESSING_FAILED',
        error_message:
          'PutObject to http://storage:9000/streamtube/thumbnails/x.jpg failed',
      });
      expect(warnings()).toContain('video-processing.failed');
      expect(warnings()).not.toMatch(/X-Amz-|secret/);
    });
  });

  describe('shutdown (TD-10)', () => {
    /** A keyspace of its own: the worker of the suite must not take this job. */
    const SHUTDOWN_PREFIX = `${QUEUE_PREFIX}-shutdown`;

    it('should drain the active job before the storage clients and the database are released', async () => {
      const video = await processingVideo(
        'h264-aac-faststart.mp4',
        'video/mp4',
      );
      const closing = await createProcessingModule(SHUTDOWN_PREFIX);
      const { host, port } = queueConfig().redis;
      const shutdownQueue = new Queue<ProcessVideoJobData>(
        VIDEO_QUEUES.PROCESSING,
        { connection: { host, port }, prefix: SHUTDOWN_PREFIX },
      );
      try {
        await closing.init();
        // Call-through spies: the real clients and data source are released.
        const storageDestroyed = jest.spyOn(S3Client.prototype, 'destroy');
        const databaseDestroyed = jest.spyOn(DataSource.prototype, 'destroy');
        const releasedAtPublication: number[] = [];
        const closingState = closing.get(ProcessingStateService);
        const realPublish = closingState.publishReady.bind(
          closingState,
        ) as ProcessingStateService['publishReady'];
        jest
          .spyOn(closingState, 'publishReady')
          .mockImplementation(async (attempt, metadata, thumbnailKey) => {
            const published = await realPublish(
              attempt,
              metadata,
              thumbnailKey,
            );
            releasedAtPublication.push(
              storageDestroyed.mock.calls.length +
                databaseDestroyed.mock.calls.length,
            );
            return published;
          });
        const reached = gate();
        const released = gate();
        const closingMedia = closing.get(MediaProbeService);
        const realProbe = closingMedia.probe.bind(
          closingMedia,
        ) as MediaProbeService['probe'];
        jest
          .spyOn(closingMedia, 'probe')
          .mockImplementation(async (key, contentType) => {
            reached.open();
            await released.opened;
            return realProbe(key, contentType);
          });
        const jobId = await enqueue(video, { target: shutdownQueue });
        await reached.opened;

        const closed = closing.close();
        try {
          // The shutdown waits for the active job: nothing is released while it runs.
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(storageDestroyed).not.toHaveBeenCalled();
          expect(databaseDestroyed).not.toHaveBeenCalled();
        } finally {
          // Even when an expectation fails, the job ends and the module closes.
          released.open();
          await closed;
        }

        // Published with every resource still open; released only afterwards.
        expect(releasedAtPublication).toEqual([0]);
        expect(storageDestroyed).toHaveBeenCalled();
        expect(databaseDestroyed).toHaveBeenCalled();
        expect(await shutdownQueue.getJobState(jobId)).toBe('completed');
        const after = await reloadVideo(dataSource, video.id);
        expect(after.status).toBe(VideoStatus.READY);
        expect(await thumbnailKeysOf(s3, config.bucket, video.id)).toEqual([
          after.thumbnail_key,
        ]);
      } finally {
        jest.restoreAllMocks();
        await shutdownQueue.obliterate({ force: true });
        await shutdownQueue.close();
      }
    });
  });
});
