import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import {
  UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import {
  Video,
  VideoPendingJobAction,
  VideoStatus,
} from './entities/video.entity';
import { NOW_PLUS_SECONDS } from './upload-sessions.repository';
import { VideoLockService } from './video-lock.service';
import { FIRST_JOB_DISPATCH } from './videos.constants';

/** Why the claim of step 1 of P2 did not take the session; the service maps it to an answer. */
export type CompletionRefusal =
  | 'video-not-found'
  | 'session-not-found'
  | 'not-current'
  | 'not-active'
  | 'completing'
  | 'expired'
  | 'file-mismatch'
  | 'inconsistent'
  /** `resumeOnly`: the session is not `completing`, so there is no completion to resume. */
  | 'not-completing';

export type CompletionClaim =
  /** The session is now `completing` with this token; `resumed` for an expired claim taken over. */
  | {
      outcome: 'claimed';
      claimToken: string;
      session: UploadSession;
      resumed: boolean;
    }
  /** The session is already `completed` as the current one of the video (G-03). */
  | { outcome: 'completed'; video: Video }
  | { outcome: 'refused'; reason: CompletionRefusal };

export interface CompletionClaimInput {
  videoId: string;
  sessionId: string;
  claimTtlSeconds: number;
  /**
   * Only takes over an expired `completing` claim, never claims an `active` session: the
   * resumption of the sweep (SI-03.24), which completes nothing the user did not ask for.
   */
  resumeOnly?: boolean;
}

export interface CompletionFinalizationInput {
  videoId: string;
  sessionId: string;
  claimToken: string;
  objectKey: string;
  actionTtlSeconds: number;
}

export type CompletionFinalization =
  | { finalized: true; run: number; pendingJobToken: string }
  | { finalized: false };

/** Session and video read in one statement, for the re-read of step 5 of P2. */
export interface CompletionState {
  session: UploadSession;
  video: Video;
  /** `expires_at <= now()` in the database. */
  expired: boolean;
}

/** A session read under the lock, with its deadlines evaluated by the clock of the database. */
interface LockedSession {
  session: UploadSession;
  expired: boolean;
  claimExpired: boolean;
}

/** One of the two conditional transitions of T2 affected zero rows: the transaction rolls back. */
class FinalizationNotApplied extends Error {}

/**
 * `completed` session that the video records as its finished upload: the current session, with
 * `original_key` equal to the key of the session. Only then a 200 confirms the completion (P2).
 */
export function isCompletionOf(video: Video, session: UploadSession): boolean {
  return (
    session.status === UploadSessionStatus.COMPLETED &&
    video.current_upload_session_id === session.id &&
    video.original_key === session.object_key
  );
}

/**
 * Transitions of P2 in the database (plan's "Coordenação e fencing"). Each method is one short
 * transaction under the lock of the video or one statement, and none calls the storage (G-01).
 */
@Injectable()
export class UploadCompletionRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly videoLock: VideoLockService,
  ) {}

  /**
   * Step 1 of P2 (T1), with the video locked. The session must be the current one of the video:
   * - `active` within its deadline and without `file_mismatch_at` → `completing` with a new token;
   * - `completing` with an expired claim → taken over with a new token (G-02);
   * - `completing` within the claim deadline → refused (F-06);
   * - `completed` and recorded by the video → `completed` (G-03).
   * The conditions are also in the UPDATE, because a file mismatch can be recorded without the
   * lock (SI-03.13, SI-03.15).
   */
  async claimCompletion(input: CompletionClaimInput): Promise<CompletionClaim> {
    const claimToken = randomUUID();
    return this.videoLock.withLockedVideo(
      input.videoId,
      async (video, manager): Promise<CompletionClaim> => {
        if (!video) {
          return refused('video-not-found');
        }
        const locked = await this.readLockedSession(manager, input);
        if (!locked) {
          return refused('session-not-found');
        }
        const { session, expired, claimExpired } = locked;
        if (session.status === UploadSessionStatus.COMPLETED) {
          return isCompletionOf(video, session)
            ? { outcome: 'completed', video }
            : refused('inconsistent');
        }
        if (video.current_upload_session_id !== session.id) {
          return refused('not-current');
        }
        if (session.status === UploadSessionStatus.COMPLETING) {
          if (!claimExpired) {
            return refused('completing');
          }
          return this.takeClaim(manager, input, claimToken, session, true);
        }
        if (input.resumeOnly) {
          return refused('not-completing');
        }
        if (session.status !== UploadSessionStatus.ACTIVE) {
          return refused('not-active');
        }
        if (expired) {
          return refused('expired');
        }
        if (session.file_mismatch_at !== null) {
          return refused('file-mismatch');
        }
        return this.takeClaim(manager, input, claimToken, session, false);
      },
    );
  }

  /**
   * Step 2 of P2, failed conference: `completing → active` only while the session holds this
   * token, releasing the claim. `false` when another process took the session over.
   */
  async revertCompletion(
    videoId: string,
    sessionId: string,
    claimToken: string,
  ): Promise<boolean> {
    return this.videoLock.withLockedVideo(videoId, async (_, manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(UploadSession)
        .set({
          status: UploadSessionStatus.ACTIVE,
          claim_token: null,
          claim_expires_at: null,
        })
        .where('id = :sessionId', { sessionId })
        .andWhere('status = :fromStatus', {
          fromStatus: UploadSessionStatus.COMPLETING,
        })
        .andWhere('claim_token = :claimToken', { claimToken })
        .execute();
      return result.affected === 1;
    });
  }

  /**
   * Step 2 of P2, NoSuchUpload without the object of the declared size at the key of the session:
   * `completing → aborted` only while the session holds this token.
   */
  async abortCompletion(
    videoId: string,
    sessionId: string,
    claimToken: string,
  ): Promise<boolean> {
    return this.videoLock.withLockedVideo(videoId, async (_, manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(UploadSession)
        .set({
          status: UploadSessionStatus.ABORTED,
          claim_token: null,
          claim_expires_at: null,
        })
        .where('id = :sessionId', { sessionId })
        .andWhere('status = :fromStatus', {
          fromStatus: UploadSessionStatus.COMPLETING,
        })
        .andWhere('claim_token = :claimToken', { claimToken })
        .execute();
      return result.affected === 1;
    });
  }

  /**
   * Step 3 of P2 (T2), with the video locked: in one transaction, the session goes `completing →
   * completed` by the token and the video `draft → processing` while the session is its current
   * one, recording the original, the execution, generation 1 and the pending `publish` action
   * (TD-12). If either transition affects zero rows, the transaction rolls back and
   * `finalized: false` is returned.
   */
  async finalizeCompletion(
    input: CompletionFinalizationInput,
  ): Promise<CompletionFinalization> {
    const pendingJobToken = randomUUID();
    try {
      return await this.videoLock.withLockedVideo(
        input.videoId,
        async (_, manager): Promise<CompletionFinalization> => {
          const session = await manager
            .createQueryBuilder()
            .update(UploadSession)
            .set({
              status: UploadSessionStatus.COMPLETED,
              claim_token: null,
              claim_expires_at: null,
            })
            .where('id = :sessionId', { sessionId: input.sessionId })
            .andWhere('status = :fromStatus', {
              fromStatus: UploadSessionStatus.COMPLETING,
            })
            .andWhere('claim_token = :claimToken', {
              claimToken: input.claimToken,
            })
            .execute();
          if (session.affected !== 1) {
            throw new FinalizationNotApplied();
          }
          const video = await manager
            .createQueryBuilder()
            .update(Video)
            .set({
              status: VideoStatus.PROCESSING,
              original_key: input.objectKey,
              processing_run: () => 'processing_run + 1',
              processing_started_at: () => 'now()',
              processing_dispatch: FIRST_JOB_DISPATCH,
              current_attempt_id: null,
              attempt_fence_dispatch: null,
              attempt_fence_seq: null,
              processing_recoveries: 0,
              pending_job_action: VideoPendingJobAction.PUBLISH,
              pending_job_dispatch: FIRST_JOB_DISPATCH,
              pending_job_token: pendingJobToken,
              pending_job_expires_at: () =>
                NOW_PLUS_SECONDS('actionTtlSeconds'),
            })
            .where('id = :videoId', { videoId: input.videoId })
            .andWhere('status = :fromStatus', { fromStatus: VideoStatus.DRAFT })
            .andWhere('current_upload_session_id = :sessionId', {
              sessionId: input.sessionId,
            })
            .setParameter('actionTtlSeconds', input.actionTtlSeconds)
            .returning(['processing_run'])
            .execute();
          const rows = video.raw as { processing_run: number }[];
          if (video.affected !== 1 || rows.length !== 1) {
            throw new FinalizationNotApplied();
          }
          return {
            finalized: true,
            run: rows[0].processing_run,
            pendingJobToken,
          };
        },
      );
    } catch (error) {
      if (error instanceof FinalizationNotApplied) {
        return { finalized: false };
      }
      throw error;
    }
  }

  /**
   * Step 5 of P2: the session and its video as they are now, in one statement, so both come from
   * the same snapshot. `null` when the session no longer exists.
   */
  async readCompletionState(
    sessionId: string,
  ): Promise<CompletionState | null> {
    const { entities, raw } = await this.dataSource
      .getRepository(UploadSession)
      .createQueryBuilder('session')
      .innerJoinAndSelect('session.video', 'video')
      .addSelect('session.expires_at <= now()', 'session_expired')
      .where('session.id = :sessionId', { sessionId })
      .getRawAndEntities<{ session_expired: boolean }>();
    if (entities.length === 0) {
      return null;
    }
    return {
      session: entities[0],
      video: entities[0].video,
      expired: raw[0].session_expired,
    };
  }

  private async readLockedSession(
    manager: EntityManager,
    input: CompletionClaimInput,
  ): Promise<LockedSession | null> {
    const { entities, raw } = await manager
      .getRepository(UploadSession)
      .createQueryBuilder('session')
      .addSelect('session.expires_at <= now()', 'session_expired')
      .addSelect(
        'session.claim_expires_at IS NOT NULL AND session.claim_expires_at <= now()',
        'claim_expired',
      )
      .where('session.id = :sessionId', { sessionId: input.sessionId })
      .andWhere('session.video_id = :videoId', { videoId: input.videoId })
      .getRawAndEntities<{
        session_expired: boolean;
        claim_expired: boolean;
      }>();
    if (entities.length === 0) {
      return null;
    }
    return {
      session: entities[0],
      expired: raw[0].session_expired,
      claimExpired: raw[0].claim_expired,
    };
  }

  /**
   * The conditional claim. From `active`, the UPDATE repeats the deadline and the file mismatch;
   * from `completing`, the previous token and its expired deadline. Zero rows under the lock can
   * only come from a file mismatch recorded meanwhile or from the deadline passing, which are
   * read again and refused.
   */
  private async takeClaim(
    manager: EntityManager,
    input: CompletionClaimInput,
    claimToken: string,
    session: UploadSession,
    resumed: boolean,
  ): Promise<CompletionClaim> {
    const update = manager
      .createQueryBuilder()
      .update(UploadSession)
      .set({
        status: UploadSessionStatus.COMPLETING,
        claim_token: claimToken,
        claim_expires_at: () => NOW_PLUS_SECONDS('claimTtlSeconds'),
      })
      .where('id = :sessionId', { sessionId: session.id })
      .andWhere('status = :fromStatus', { fromStatus: session.status })
      .setParameter('claimTtlSeconds', input.claimTtlSeconds);
    if (resumed) {
      update
        .andWhere('claim_token = :previousToken', {
          previousToken: session.claim_token,
        })
        .andWhere('claim_expires_at <= now()');
    } else {
      update
        .andWhere('expires_at > now()')
        .andWhere('file_mismatch_at IS NULL');
    }
    const result = await update.execute();
    if (result.affected !== 1) {
      const fresh = await this.readLockedSession(manager, input);
      if (fresh?.session.file_mismatch_at) {
        return refused('file-mismatch');
      }
      if (fresh?.expired) {
        return refused('expired');
      }
      throw new Error(
        `Claim of session ${session.id} affected no row under the lock of its video`,
      );
    }
    const claimed = await manager
      .getRepository(UploadSession)
      .findOneByOrFail({ id: session.id });
    return { outcome: 'claimed', claimToken, session: claimed, resumed };
  }
}

function refused(reason: CompletionRefusal): CompletionClaim {
  return { outcome: 'refused', reason };
}
