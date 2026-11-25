import { UnrecoverableError } from 'bullmq';
import {
  isLastAttempt,
  processingAttemptOf,
  thumbnailFrameSeconds,
} from './processing-attempt';

const VIDEO_ID = '0b5c3f0e-4a59-4c5b-9a43-6b2f6f1d8e21';
const OTHER_VIDEO_ID = '7d1e2f3a-1b2c-4d5e-8f90-a1b2c3d4e5f6';

describe('processing attempt', () => {
  describe('processingAttemptOf', () => {
    it('should read the generation from the jobId and the seq from attemptsStarted, with a new attempt id', () => {
      const job = {
        id: `video-${VIDEO_ID}-4-3`,
        data: { videoId: VIDEO_ID, run: 4 },
        attemptsStarted: 2,
      };

      const first = processingAttemptOf(job);
      const second = processingAttemptOf(job);

      expect(first).toMatchObject({
        videoId: VIDEO_ID,
        run: 4,
        dispatch: 3,
        seq: 2,
      });
      expect(first.attemptId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(second.attemptId).not.toBe(first.attemptId);
    });

    it.each([
      [
        'a jobId outside the format',
        { id: 'process-video-1', data: { videoId: VIDEO_ID, run: 1 } },
      ],
      ['no jobId', { id: undefined, data: { videoId: VIDEO_ID, run: 1 } }],
      [
        'a payload of another video',
        {
          id: `video-${VIDEO_ID}-1-1`,
          data: { videoId: OTHER_VIDEO_ID, run: 1 },
        },
      ],
      [
        'a payload of another execution',
        { id: `video-${VIDEO_ID}-2-1`, data: { videoId: VIDEO_ID, run: 1 } },
      ],
      ['no payload', { id: `video-${VIDEO_ID}-1-1`, data: undefined }],
    ])('should fail without retries for %s', (_, job) => {
      expect(() =>
        processingAttemptOf({ ...job, attemptsStarted: 1 } as never),
      ).toThrow(UnrecoverableError);
    });

    it.each([0, Number.NaN])(
      'should fail without retries when attemptsStarted is %s',
      (attemptsStarted) => {
        expect(() =>
          processingAttemptOf({
            id: `video-${VIDEO_ID}-1-1`,
            data: { videoId: VIDEO_ID, run: 1 },
            attemptsStarted,
          }),
        ).toThrow(UnrecoverableError);
      },
    );
  });

  describe('isLastAttempt', () => {
    it.each([
      [0, 3, false],
      [1, 3, false],
      [2, 3, true],
      [0, 1, true],
      [0, undefined, true],
    ])(
      'should treat %s attempts made of %s as last: %s',
      (attemptsMade, attempts, last) => {
        expect(isLastAttempt({ attemptsMade, opts: { attempts } })).toBe(last);
      },
    );
  });

  describe('thumbnailFrameSeconds', () => {
    it.each([
      [2, 1],
      [120, 1],
      [1, 0.5],
      [0.4, 0.2],
      [0, 0],
      [null, 0],
    ])('should take the frame of a %s s video at %s s', (duration, at) => {
      expect(thumbnailFrameSeconds(duration)).toBe(at);
    });
  });
});
