import { UploadSessionStatus } from '../../videos/entities/upload-session.entity';
import { VideoStatus } from '../../videos/entities/video.entity';

/** The facts of the database about a key of `originals/`, read for one decision of P4. */
export interface OriginalKeyFacts {
  /** The session whose `object_key` is the key, or `null` when no row has it. */
  session: {
    sessionId: string;
    videoId: string;
    status: UploadSessionStatus;
    /** `claim_expires_at <= now()` in the database. */
    claimExpired: boolean;
  } | null;
  /** Some video has the key as its `original_key`. */
  referenced: boolean;
}

/**
 * The conduct of P4 for a key of `originals/`, object or multipart:
 * - `remove`: a stable fact proves that no future transition can reference it;
 * - `claim-and-abort`: a session `initiating` or `aborting` with an expired claim, whose uploads
 *   are aborted only after the cleanup takes its ownership by token;
 * - `keep`: referenced, or a session that may still use it.
 */
export type OriginalKeyConduct = 'remove' | 'claim-and-abort' | 'keep';

/**
 * Originals and multiparts of P4:
 * - referenced by an `original_key` → never;
 * - no session row → removed: rows always precede objects, so only the compensation remains, after
 *   its creator gave up;
 * - session `aborted` → removed: the completion requires `completing`, and no transition leaves
 *   `aborted`;
 * - session `initiating` or `aborting` with an expired claim → ownership first, then the abort;
 * - `active`, `completing`, `completed`, or a claim within its deadline → never.
 */
export function decideOriginalKey(facts: OriginalKeyFacts): OriginalKeyConduct {
  if (facts.referenced) {
    return 'keep';
  }
  if (!facts.session) {
    return 'remove';
  }
  switch (facts.session.status) {
    case UploadSessionStatus.ABORTED:
      return 'remove';
    case UploadSessionStatus.INITIATING:
    case UploadSessionStatus.ABORTING:
      return facts.session.claimExpired ? 'claim-and-abort' : 'keep';
    case UploadSessionStatus.ACTIVE:
    case UploadSessionStatus.COMPLETING:
    case UploadSessionStatus.COMPLETED:
      return 'keep';
  }
}

/** The facts of the database about the video of a thumbnail. */
export interface ThumbnailVideoFacts {
  status: VideoStatus;
  thumbnailKey: string | null;
  currentAttemptId: string | null;
}

/**
 * Derivatives of P4 in `thumbnails/{videoId}/`:
 * - `ready` → every key but `thumbnail_key`; no transition leaves `ready` in this phase;
 * - `error` → every key; the residual `current_attempt_id` protects nothing;
 * - `processing` with a current attempt → the keys of other attempts; the fence of P3 only
 *   advances, so an attempt that lost the vigency never publishes again;
 * - `processing` without a current attempt → none, until the next cycle;
 * - no video row, or `draft` → none: nothing in this phase proves them abandoned.
 */
export function decideThumbnail(
  key: string,
  attemptId: string,
  video: ThumbnailVideoFacts | null,
): 'remove' | 'keep' {
  if (!video) {
    return 'keep';
  }
  switch (video.status) {
    case VideoStatus.READY:
      return key === video.thumbnailKey ? 'keep' : 'remove';
    case VideoStatus.ERROR:
      return 'remove';
    case VideoStatus.PROCESSING:
      return video.currentAttemptId !== null &&
        attemptId !== video.currentAttemptId
        ? 'remove'
        : 'keep';
    case VideoStatus.DRAFT:
      return 'keep';
  }
}

/**
 * The grace of the cleanup (`STORAGE_CLEANUP_GRACE_MS`), an additional margin over the stable
 * eligibility: a late write of an obsolete attempt is not garbage yet. Without a date, the object
 * is kept.
 */
export function pastGrace(
  at: Date | undefined,
  now: number,
  graceMs: number,
): boolean {
  return at !== undefined && now - at.getTime() >= graceMs;
}
