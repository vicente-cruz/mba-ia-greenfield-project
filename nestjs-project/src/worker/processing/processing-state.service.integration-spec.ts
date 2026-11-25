import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  reloadVideo,
  saveProcessingVideo,
} from '../../test/processing-fixtures';
import { saveTestChannel } from '../../test/video-entity-fixtures';
import { User } from '../../users/entities/user.entity';
import { UploadPart } from '../../videos/entities/upload-part.entity';
import { UploadSession } from '../../videos/entities/upload-session.entity';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import type { MediaMetadata } from '../media/media-probe.rules';
import type { ProcessingAttempt } from './processing-attempt';
import { ProcessingStateService } from './processing-state.service';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

const METADATA: MediaMetadata = {
  durationSeconds: 2,
  width: 320,
  height: 240,
  mediaFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  audioCodec: 'aac',
};

describe('ProcessingStateService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: ProcessingStateService;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [ProcessingStateService],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(ProcessingStateService);
  });

  afterAll(async () => {
    try {
      await cleanAllTables(dataSource);
    } finally {
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    channel = await saveTestChannel(dataSource);
  });

  function attemptOf(
    video: Video,
    token: { run?: number; dispatch: number; seq: number },
  ): ProcessingAttempt {
    return {
      videoId: video.id,
      run: token.run ?? video.processing_run,
      dispatch: token.dispatch,
      seq: token.seq,
      attemptId: randomUUID(),
    };
  }

  describe('assume (fence of P3)', () => {
    it.each<
      [
        string,
        Partial<Video>,
        { run?: number; dispatch: number; seq: number },
        boolean,
      ]
    >([
      ['first delivery, empty fence', {}, { dispatch: 1, seq: 1 }, true],
      [
        'retry or redelivery with a greater seq',
        { attempt_fence_dispatch: 1, attempt_fence_seq: 1 },
        { dispatch: 1, seq: 2 },
        true,
      ],
      [
        'the same token again (duplicate delivery)',
        { attempt_fence_dispatch: 1, attempt_fence_seq: 2 },
        { dispatch: 1, seq: 2 },
        false,
      ],
      [
        'an older seq of the same generation',
        { attempt_fence_dispatch: 1, attempt_fence_seq: 2 },
        { dispatch: 1, seq: 1 },
        false,
      ],
      [
        'a new generation, whose seq starts again',
        {
          processing_dispatch: 2,
          attempt_fence_dispatch: 1,
          attempt_fence_seq: 3,
        },
        { dispatch: 2, seq: 1 },
        true,
      ],
      [
        'a delivery of a superseded generation',
        {
          processing_dispatch: 2,
          attempt_fence_dispatch: 1,
          attempt_fence_seq: 1,
        },
        { dispatch: 1, seq: 5 },
        false,
      ],
      [
        'the token of an attempt revoked by P5 (equal to the fence)',
        {
          processing_dispatch: 2,
          attempt_fence_dispatch: 2,
          attempt_fence_seq: 1,
          current_attempt_id: null,
        },
        { dispatch: 2, seq: 1 },
        false,
      ],
      [
        'a delivery of a previous execution',
        { processing_run: 2 },
        { run: 1, dispatch: 1, seq: 1 },
        false,
      ],
      [
        'a video already ready',
        { status: VideoStatus.READY },
        { dispatch: 1, seq: 1 },
        false,
      ],
      [
        'a video already in error',
        { status: VideoStatus.ERROR },
        { dispatch: 1, seq: 1 },
        false,
      ],
      [
        'a draft',
        { status: VideoStatus.DRAFT },
        { dispatch: 1, seq: 1 },
        false,
      ],
    ])('%s → assumes: %s', async (_, state, token, assumes) => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        original_key: `originals/${randomUUID()}/s`,
        ...state,
      });
      const attempt = attemptOf(video, token);

      const assumed = await service.assume(attempt);

      const after = await reloadVideo(dataSource, video.id);
      if (assumes) {
        expect(assumed).toEqual({
          originalKey: video.original_key,
          contentType: 'video/mp4',
        });
        expect(after).toMatchObject({
          current_attempt_id: attempt.attemptId,
          attempt_fence_dispatch: token.dispatch,
          attempt_fence_seq: token.seq,
        });
      } else {
        expect(assumed).toBeNull();
        expect(after).toMatchObject({
          current_attempt_id: video.current_attempt_id,
          attempt_fence_dispatch: video.attempt_fence_dispatch,
          attempt_fence_seq: video.attempt_fence_seq,
        });
      }
    });

    it('should let only one of two deliveries with the same token assume, even at the same time', async () => {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        original_key: 'originals/x/s',
      });
      const first = attemptOf(video, { dispatch: 1, seq: 1 });
      const second = attemptOf(video, { dispatch: 1, seq: 1 });

      const results = await Promise.all([
        service.assume(first),
        service.assume(second),
      ]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      const winner = results[0] ? first : second;
      expect(await reloadVideo(dataSource, video.id)).toMatchObject({
        current_attempt_id: winner.attemptId,
        attempt_fence_seq: 1,
      });
    });
  });

  describe('publication guard', () => {
    async function videoWithCurrentAttempt() {
      const video = await saveProcessingVideo(dataSource, channel.id, {
        original_key: 'originals/x/s',
      });
      const current = attemptOf(video, { dispatch: 1, seq: 1 });
      await service.assume(current);
      return { video, current };
    }

    it('should publish ready with the metadata and the thumbnail of the current attempt', async () => {
      const { video, current } = await videoWithCurrentAttempt();

      await expect(
        service.publishReady(current, METADATA, 'thumbnails/x/a.jpg'),
      ).resolves.toBe(true);

      expect(await reloadVideo(dataSource, video.id)).toMatchObject({
        status: VideoStatus.READY,
        duration_seconds: '2.000',
        width: 320,
        height: 240,
        media_format: METADATA.mediaFormat,
        video_codec: 'h264',
        audio_codec: 'aac',
        thumbnail_key: 'thumbnails/x/a.jpg',
        error_code: null,
        error_message: null,
        current_attempt_id: current.attemptId,
      });
    });

    it('should record error with the code and the message of the current attempt', async () => {
      const { video, current } = await videoWithCurrentAttempt();

      await expect(
        service.recordError(current, 'MEDIA_INVALID', 'no video stream'),
      ).resolves.toBe(true);

      expect(await reloadVideo(dataSource, video.id)).toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'MEDIA_INVALID',
        error_message: 'no video stream',
        thumbnail_key: null,
      });
    });

    it.each<[string, (video: Video) => Partial<Video>]>([
      [
        'a greater token assumed',
        () => ({ current_attempt_id: randomUUID(), attempt_fence_seq: 2 }),
      ],
      ['P5 revoked the attempt', () => ({ current_attempt_id: null })],
      [
        'P5 reserved a new generation',
        () => ({ processing_dispatch: 2, current_attempt_id: null }),
      ],
      ['a new execution started', () => ({ processing_run: 2 })],
      ['the video is already ready', () => ({ status: VideoStatus.READY })],
      ['the video is already in error', () => ({ status: VideoStatus.ERROR })],
    ])('should write neither ready nor error after %s', async (_, change) => {
      const { video, current } = await videoWithCurrentAttempt();
      await dataSource.getRepository(Video).update(video.id, change(video));
      const before = await reloadVideo(dataSource, video.id);

      const ready = await service.publishReady(
        current,
        METADATA,
        'thumbnails/x/lost.jpg',
      );
      const error = await service.recordError(
        current,
        'PROCESSING_FAILED',
        'lost',
      );

      expect([ready, error]).toEqual([false, false]);
      expect(await reloadVideo(dataSource, video.id)).toEqual(before);
    });
  });
});
