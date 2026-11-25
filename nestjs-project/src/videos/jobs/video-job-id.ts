/**
 * Identity of a `process-video` job: one per execution (`run`) and generation (`dispatch`) of a
 * video, `video-{videoId}-{run}-{dispatch}`, without `:` (P3, P5). The processor reads the
 * generation from the jobId; the payload only carries `{ videoId, run }`.
 */
export interface VideoJobIdentity {
  videoId: string;
  run: number;
  dispatch: number;
}

/** Payload of `process-video` ("Events/Messages"). */
export interface ProcessVideoJobData {
  videoId: string;
  run: number;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const POSITIVE_INTEGER = '[1-9][0-9]*';
const JOB_ID_PATTERN = new RegExp(
  `^video-(${UUID})-(${POSITIVE_INTEGER})-(${POSITIVE_INTEGER})$`,
);
const UUID_PATTERN = new RegExp(`^${UUID}$`);

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export function buildVideoJobId({
  videoId,
  run,
  dispatch,
}: VideoJobIdentity): string {
  if (!UUID_PATTERN.test(videoId)) {
    throw new Error(`Invalid videoId for a job id: ${videoId}`);
  }
  if (!isPositiveSafeInteger(run) || !isPositiveSafeInteger(dispatch)) {
    throw new Error(
      `run and dispatch must be positive integers: run=${run}, dispatch=${dispatch}`,
    );
  }
  return `video-${videoId}-${run}-${dispatch}`;
}

/** Inverse of `buildVideoJobId`; `null` for any id that it would not produce. */
export function parseVideoJobId(jobId: string): VideoJobIdentity | null {
  const match = JOB_ID_PATTERN.exec(jobId);
  if (!match) {
    return null;
  }
  const run = Number(match[2]);
  const dispatch = Number(match[3]);
  if (!isPositiveSafeInteger(run) || !isPositiveSafeInteger(dispatch)) {
    return null;
  }
  return { videoId: match[1], run, dispatch };
}
