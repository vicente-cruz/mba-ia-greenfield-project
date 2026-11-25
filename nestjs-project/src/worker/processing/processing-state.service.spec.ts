import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import type { MediaMetadata } from '../media/media-probe.rules';
import type { ProcessingAttempt } from './processing-attempt';
import { ProcessingStateService } from './processing-state.service';

const ATTEMPT: ProcessingAttempt = {
  videoId: '0b5c3f0e-4a59-4c5b-9a43-6b2f6f1d8e21',
  run: 2,
  dispatch: 3,
  seq: 4,
  attemptId: 'a6f1b2c3-d4e5-4f60-8a7b-9c0d1e2f3a4b',
};

const METADATA: MediaMetadata = {
  durationSeconds: 2.008,
  width: 320,
  height: 240,
  mediaFormat: 'matroska,webm',
  videoCodec: 'vp9',
  audioCodec: 'opus',
};

type Condition = [string, Record<string, unknown> | undefined];

/** The chain of the TypeORM UpdateQueryBuilder that the service calls. */
interface RecordingBuilder {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  returning: jest.Mock;
  execute: jest.Mock;
}

/** Records the UPDATE built by the service: its SET, its conditions and its RETURNING. */
function recordingUpdate(result: { affected?: number; raw: unknown }) {
  const recorded: {
    set?: Record<string, unknown>;
    conditions: Condition[];
    returning?: string[];
  } = { conditions: [] };
  const condition = (sql: string, params?: Record<string, unknown>) => {
    recorded.conditions.push([sql, params]);
    return builder;
  };
  const builder: RecordingBuilder = {
    update: jest.fn((): RecordingBuilder => builder),
    set: jest.fn((values: Record<string, unknown>): RecordingBuilder => {
      recorded.set = values;
      return builder;
    }),
    where: jest.fn(condition),
    andWhere: jest.fn(condition),
    returning: jest.fn((columns: string[]): RecordingBuilder => {
      recorded.returning = columns;
      return builder;
    }),
    execute: jest.fn(() => Promise.resolve(result)),
  };
  return { builder, recorded };
}

/** Each condition with its bound parameters inlined, to read the predicate as a whole. */
function predicate(conditions: Condition[]): string[] {
  return conditions.map(([sql, params]) =>
    sql.replace(/:(\w+)/g, (_, name: string) =>
      JSON.stringify(params?.[name] ?? `<unbound ${name}>`),
    ),
  );
}

describe('ProcessingStateService', () => {
  let service: ProcessingStateService;
  let createQueryBuilder: jest.Mock;

  beforeEach(async () => {
    createQueryBuilder = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProcessingStateService,
        {
          provide: getRepositoryToken(Video),
          useValue: { createQueryBuilder },
        },
      ],
    }).compile();
    service = moduleRef.get(ProcessingStateService);
  });

  function nextUpdate(result: { affected?: number; raw: unknown }) {
    const update = recordingUpdate(result);
    createQueryBuilder.mockReturnValueOnce(update.builder);
    return update.recorded;
  }

  describe('assume', () => {
    it('should advance the fence to the token of the attempt only with the predicate of P3', async () => {
      const recorded = nextUpdate({
        affected: 1,
        raw: [{ original_key: 'originals/v/s', content_type: 'video/webm' }],
      });

      await service.assume(ATTEMPT);

      expect(recorded.set).toEqual({
        current_attempt_id: ATTEMPT.attemptId,
        attempt_fence_dispatch: 3,
        attempt_fence_seq: 4,
      });
      expect(predicate(recorded.conditions)).toEqual([
        `id = "${ATTEMPT.videoId}"`,
        'status = "processing"',
        'processing_run = 2',
        'processing_dispatch = 3',
        '(attempt_fence_dispatch IS NULL OR attempt_fence_dispatch < 3 OR (attempt_fence_dispatch = 3 AND attempt_fence_seq < 4))',
      ]);
      expect(recorded.returning).toEqual(['original_key', 'content_type']);
    });

    it('should return the original of the video when the attempt is assumed', async () => {
      nextUpdate({
        affected: 1,
        raw: [{ original_key: 'originals/v/s', content_type: 'video/webm' }],
      });

      await expect(service.assume(ATTEMPT)).resolves.toEqual({
        originalKey: 'originals/v/s',
        contentType: 'video/webm',
      });
    });

    it('should return null when no row is affected: obsolete delivery, terminal video or another execution', async () => {
      nextUpdate({ affected: 0, raw: [] });

      await expect(service.assume(ATTEMPT)).resolves.toBeNull();
    });

    it('should refuse a video in processing without original_key, which P2 never leaves', async () => {
      nextUpdate({
        affected: 1,
        raw: [{ original_key: null, content_type: 'video/mp4' }],
      });

      await expect(service.assume(ATTEMPT)).rejects.toThrow(
        /without original_key/,
      );
    });
  });

  describe('publication guard', () => {
    const GUARD = [
      `id = "${ATTEMPT.videoId}"`,
      'status = "processing"',
      'processing_run = 2',
      'processing_dispatch = 3',
      `current_attempt_id = "${ATTEMPT.attemptId}"`,
    ];

    it('should publish ready, the metadata and the thumbnail in one UPDATE, only for the current attempt', async () => {
      const recorded = nextUpdate({ affected: 1, raw: [] });

      await expect(
        service.publishReady(ATTEMPT, METADATA, 'thumbnails/v/a.jpg'),
      ).resolves.toBe(true);

      expect(recorded.set).toEqual({
        status: VideoStatus.READY,
        duration_seconds: '2.008',
        width: 320,
        height: 240,
        media_format: 'matroska,webm',
        video_codec: 'vp9',
        audio_codec: 'opus',
        thumbnail_key: 'thumbnails/v/a.jpg',
        error_code: null,
        error_message: null,
      });
      expect(predicate(recorded.conditions)).toEqual(GUARD);
    });

    it('should keep a null duration and a null audio codec', async () => {
      const recorded = nextUpdate({ affected: 1, raw: [] });

      await service.publishReady(
        ATTEMPT,
        { ...METADATA, durationSeconds: null, audioCodec: null },
        'thumbnails/v/a.jpg',
      );

      expect(recorded.set).toMatchObject({
        duration_seconds: null,
        audio_codec: null,
      });
    });

    it('should record error with the code and the message under the same guard', async () => {
      const recorded = nextUpdate({ affected: 1, raw: [] });

      await expect(
        service.recordError(ATTEMPT, 'MEDIA_INVALID', 'no video stream'),
      ).resolves.toBe(true);

      expect(recorded.set).toEqual({
        status: VideoStatus.ERROR,
        error_code: 'MEDIA_INVALID',
        error_message: 'no video stream',
      });
      expect(predicate(recorded.conditions)).toEqual(GUARD);
    });

    it.each(['publishReady', 'recordError'] as const)(
      '%s should report a lost attempt when no row is affected',
      async (method) => {
        nextUpdate({ affected: 0, raw: [] });

        const written =
          method === 'publishReady'
            ? await service.publishReady(ATTEMPT, METADATA, 'k')
            : await service.recordError(ATTEMPT, 'PROCESSING_FAILED', 'm');

        expect(written).toBe(false);
      },
    );
  });
});
