import { buildVideoJobId, parseVideoJobId } from './video-job-id';

const VIDEO_ID = '3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f';

describe('buildVideoJobId', () => {
  it('should build video-{videoId}-{run}-{dispatch} without ":"', () => {
    const jobId = buildVideoJobId({ videoId: VIDEO_ID, run: 2, dispatch: 3 });

    expect(jobId).toBe(`video-${VIDEO_ID}-2-3`);
    expect(jobId).not.toContain(':');
  });

  it.each([
    [{ videoId: 'not-a-uuid', run: 1, dispatch: 1 }],
    [{ videoId: VIDEO_ID.toUpperCase(), run: 1, dispatch: 1 }],
    [{ videoId: VIDEO_ID, run: 0, dispatch: 1 }],
    [{ videoId: VIDEO_ID, run: 1, dispatch: 0 }],
    [{ videoId: VIDEO_ID, run: 1.5, dispatch: 1 }],
    [{ videoId: VIDEO_ID, run: 1, dispatch: Number.MAX_SAFE_INTEGER + 1 }],
  ])('should refuse %o', (identity) => {
    expect(() => buildVideoJobId(identity)).toThrow();
  });
});

describe('parseVideoJobId', () => {
  it('should read back the identity used to build the id', () => {
    const identity = { videoId: VIDEO_ID, run: 7, dispatch: 12 };

    expect(parseVideoJobId(buildVideoJobId(identity))).toEqual(identity);
  });

  it.each([
    `video-${VIDEO_ID}-1`,
    `video-${VIDEO_ID}-0-1`,
    `video-${VIDEO_ID}-1-01`,
    `video-${VIDEO_ID}-1-1-1`,
    `video:${VIDEO_ID}:1:1`,
    'repeat:upload-session-sweep:1795057096040',
    `video-${VIDEO_ID}-1-99999999999999999999`,
  ])('should return null for %s', (jobId) => {
    expect(parseVideoJobId(jobId)).toBeNull();
  });
});
