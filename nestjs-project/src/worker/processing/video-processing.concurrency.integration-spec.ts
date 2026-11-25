import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
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
  deliveryOf,
  type DeliveryOptions,
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
import { MediaRejectedError } from '../media/media.errors';
import type { MediaMetadata } from '../media/media-probe.rules';
import { MediaProbeService } from '../media/media-probe.service';
import { MediaProcessRunner } from '../media/media-process.runner';
import { ProcessingStateService } from './processing-state.service';
import {
  type ProcessVideoResult,
  VideoProcessingProcessor,
} from './video-processing.processor';

jest.setTimeout(30_000);

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
 * T-11: deliveries of the same execution running at the same time, controlled by calling the
 * processor directly with the order token of each delivery and holding the probe of one of them.
 * The concurrency of BullMQ itself (redelivery after a stall, a job of an old generation) produces
 * exactly these deliveries; the processor only sees their tokens.
 */
describe('VideoProcessingProcessor concurrency (integration, T-11)', () => {
  const config = storageConfig();
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessingProcessor;
  let media: MediaProbeService;
  let storage: StorageService;
  let channel: Channel;
  let video: Video;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [
        MediaProcessRunner,
        MediaProbeService,
        ProcessingStateService,
        VideoProcessingProcessor,
      ],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    processor = moduleRef.get(VideoProcessingProcessor);
    media = moduleRef.get(MediaProbeService);
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    try {
      await removeStorageOfVideos(dataSource, s3, config.bucket);
      await cleanAllTables(dataSource);
    } finally {
      s3.destroy();
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await removeStorageOfVideos(dataSource, s3, config.bucket);
    await cleanAllTables(dataSource);
    channel = await saveTestChannel(dataSource);
    const saved = await saveProcessingVideo(dataSource, channel.id);
    const originalKey = await uploadOriginal(
      s3,
      config.bucket,
      saved.id,
      'h264-aac-moov-end.mp4',
    );
    await dataSource
      .getRepository(Video)
      .update(saved.id, { original_key: originalKey });
    video = await reloadVideo(dataSource, saved.id);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function deliver(options: DeliveryOptions): Promise<ProcessVideoResult> {
    return processor.process(deliveryOf(video.id, options));
  }

  /**
   * Holds the probe of the first delivery that reaches it, after it assumed the attempt; the
   * others probe at once. `then` decides what the held probe does when released.
   */
  function holdFirstProbe(then: 'probe' | MediaRejectedError = 'probe'): {
    reached: Promise<void>;
    release: () => void;
    calls: () => number;
  } {
    const reached = gate();
    const released = gate();
    const realProbe = media.probe.bind(media) as MediaProbeService['probe'];
    let calls = 0;
    jest
      .spyOn(media, 'probe')
      .mockImplementation(
        async (key: string, contentType: string): Promise<MediaMetadata> => {
          calls += 1;
          if (calls === 1) {
            reached.open();
            await released.opened;
            if (then instanceof MediaRejectedError) {
              throw then;
            }
          }
          return realProbe(key, contentType);
        },
      );
    return {
      reached: reached.opened,
      release: released.open,
      calls: () => calls,
    };
  }

  /**
   * Holds the first write to the storage (the newer delivery, which already assumed) until
   * released; any later write (the older delivery) runs `laterWrite`.
   */
  function holdFirstWrite(laterWrite: 'write' | Error = 'write'): {
    reached: Promise<void>;
    release: () => void;
  } {
    const reached = gate();
    const released = gate();
    const realPut = storage.putObject.bind(
      storage,
    ) as StorageService['putObject'];
    let puts = 0;
    jest
      .spyOn(storage, 'putObject')
      .mockImplementation(async (key, body, contentType) => {
        puts += 1;
        if (puts === 1) {
          reached.open();
          await released.opened;
        } else if (laterWrite instanceof Error) {
          throw laterWrite;
        }
        return realPut(key, body, contentType);
      });
    return { reached: reached.opened, release: released.open };
  }

  /** The published thumbnail is the object of the attempt that published, and decodes. */
  async function expectPublishedBy(attemptId: string): Promise<void> {
    const key = `thumbnails/${video.id}/${attemptId}.jpg`;
    expect(await reloadVideo(dataSource, video.id)).toMatchObject({
      status: VideoStatus.READY,
      current_attempt_id: attemptId,
      thumbnail_key: key,
      duration_seconds: '2.000',
      width: 320,
      height: 240,
    });
    const thumbnail = await readObject(s3, config.bucket, key);
    expect(thumbnail.contentType).toBe('image/jpeg');
    expect(decodeImage(thumbnail.body)).toEqual({
      codec: 'mjpeg',
      width: 320,
      height: 240,
    });
  }

  describe('two deliveries of the same execution', () => {
    it('should let only the newer delivery publish when the older one finishes later (redelivery after a stall)', async () => {
      const held = holdFirstProbe();
      const older = deliver({ seq: 1 });
      await held.reached;

      const newer = await deliver({ seq: 2 });
      expect(newer.outcome).toBe('ready');
      held.release();
      const olderResult = await older;

      expect(olderResult.outcome).toBe('superseded');
      await expectPublishedBy(newer.attemptId);
      expect(await reloadVideo(dataSource, video.id)).toMatchObject({
        attempt_fence_dispatch: 1,
        attempt_fence_seq: 2,
      });
      // The older attempt wrote only its own key, never the published one (P4 collects it).
      expect(
        (await thumbnailKeysOf(s3, config.bucket, video.id)).sort(),
      ).toEqual(
        [
          `thumbnails/${video.id}/${olderResult.attemptId}.jpg`,
          `thumbnails/${video.id}/${newer.attemptId}.jpg`,
        ].sort(),
      );
    });

    it('should not publish an older delivery that finishes first, after a newer one assumed', async () => {
      const heldOlder = holdFirstProbe();
      const older = deliver({ seq: 1 });
      await heldOlder.reached;
      const heldNewer = holdFirstWrite();
      const newer = deliver({ seq: 2 });
      await heldNewer.reached;

      heldOlder.release();
      const olderResult = await older;

      expect(olderResult.outcome).toBe('superseded');
      expect(await reloadVideo(dataSource, video.id)).toMatchObject({
        status: VideoStatus.PROCESSING,
        thumbnail_key: null,
        attempt_fence_seq: 2,
      });
      heldNewer.release();
      const newerResult = await newer;
      expect(newerResult.outcome).toBe('ready');
      await expectPublishedBy(newerResult.attemptId);
    });

    it('should let only one of two deliveries with the same token run FFmpeg and write', async () => {
      const probe = jest.spyOn(media, 'probe');
      const put = jest.spyOn(storage, 'putObject');

      const results = await Promise.all([
        deliver({ seq: 1 }),
        deliver({ seq: 1 }),
      ]);

      expect(results.map((result) => result.outcome).sort()).toEqual([
        'ready',
        'skipped',
      ]);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledTimes(1);
      const winner = results.find((result) => result.outcome === 'ready')!;
      await expectPublishedBy(winner.attemptId);
      expect(await thumbnailKeysOf(s3, config.bucket, video.id)).toEqual([
        `thumbnails/${video.id}/${winner.attemptId}.jpg`,
      ]);
    });

    it('should not let an older delivery that ends in a permanent error overwrite the ready of the newer one', async () => {
      const held = holdFirstProbe(
        new MediaRejectedError('MEDIA_INVALID', 'no video stream'),
      );
      const older = deliver({ seq: 1 });
      await held.reached;
      const newer = await deliver({ seq: 2 });
      const before = await reloadVideo(dataSource, video.id);

      held.release();

      await expect(older).rejects.toBeInstanceOf(UnrecoverableError);
      expect(await reloadVideo(dataSource, video.id)).toEqual(before);
      await expectPublishedBy(newer.attemptId);
    });

    it('should not let an older delivery in its last attempt record PROCESSING_FAILED over the newer one', async () => {
      const recordError = jest.spyOn(
        moduleRef.get(ProcessingStateService),
        'recordError',
      );
      const heldOlder = holdFirstProbe();
      const older = deliver({ seq: 1, attemptsMade: 2, attempts: 3 });
      await heldOlder.reached;
      const heldNewer = holdFirstWrite(new Error('storage reset'));
      const newer = deliver({ seq: 2 });
      await heldNewer.reached;

      heldOlder.release();

      await expect(older).rejects.toThrow('storage reset');
      expect(recordError).toHaveBeenCalledTimes(1);
      expect(recordError.mock.calls[0][1]).toBe('PROCESSING_FAILED');
      await expect(recordError.mock.results[0].value).resolves.toBe(false);
      expect(await reloadVideo(dataSource, video.id)).toMatchObject({
        status: VideoStatus.PROCESSING,
        error_code: null,
      });
      heldNewer.release();
      const newerResult = await newer;
      expect(newerResult.outcome).toBe('ready');
      await expectPublishedBy(newerResult.attemptId);
    });
  });

  describe('deliveries of an old generation', () => {
    it('should not assume, run FFmpeg or write for a delivery of a superseded generation', async () => {
      await dataSource
        .getRepository(Video)
        .update(video.id, { processing_dispatch: 2 });
      const before = await reloadVideo(dataSource, video.id);
      const probe = jest.spyOn(media, 'probe');
      const put = jest.spyOn(storage, 'putObject');

      const result = await deliver({ dispatch: 1, seq: 5 });

      expect(result.outcome).toBe('skipped');
      expect(probe).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(await reloadVideo(dataSource, video.id)).toEqual(before);
      expect(await thumbnailKeysOf(s3, config.bucket, video.id)).toEqual([]);
    });

    it('should not publish an attempt whose generation P5 superseded while it ran, and let the new generation publish', async () => {
      const held = holdFirstProbe();
      const oldGeneration = deliver({ dispatch: 1, seq: 1 });
      await held.reached;
      // R1 of P5: a new generation is reserved and the current attempt is revoked.
      await dataSource.getRepository(Video).update(video.id, {
        processing_dispatch: 2,
        current_attempt_id: null,
      });
      const afterRecovery = await reloadVideo(dataSource, video.id);

      held.release();
      const oldResult = await oldGeneration;

      expect(oldResult.outcome).toBe('superseded');
      expect(await reloadVideo(dataSource, video.id)).toEqual(afterRecovery);

      const newGeneration = await deliver({ dispatch: 2, seq: 1 });

      expect(newGeneration.outcome).toBe('ready');
      await expectPublishedBy(newGeneration.attemptId);
      expect(await reloadVideo(dataSource, video.id)).toMatchObject({
        processing_dispatch: 2,
        attempt_fence_dispatch: 2,
        attempt_fence_seq: 1,
      });
    });
  });
});
