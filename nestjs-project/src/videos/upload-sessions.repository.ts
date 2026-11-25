import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import {
  UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { withPublicIdRetry } from './public-id';
import { originalObjectKey } from './storage-keys';
import type { UploadPlan } from './upload-plan';
import { VideoLockService } from './video-lock.service';

/** Database time plus a number of seconds; deadlines follow the clock of the database. */
export const NOW_PLUS_SECONDS = (parameter: string) =>
  `now() + make_interval(secs => :${parameter})`;

export interface CreationIntentInput {
  channelId: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  plan: UploadPlan;
  claimTtlSeconds: number;
}

/** What T1 of P1 recorded: the video, its session in `initiating` and the claim token. */
export interface CreationIntent {
  videoId: string;
  publicId: string;
  sessionId: string;
  objectKey: string;
  claimToken: string;
}

export interface SessionActivation {
  sessionId: string;
  claimToken: string;
  uploadId: string;
  sessionTtlSeconds: number;
}

/** A session read for its owner, with the expiry evaluated by the clock of the database. */
export interface OwnedUploadSession {
  video: Video;
  session: UploadSession;
  /** `expires_at <= now()` in the database. */
  expired: boolean;
}

export interface VanishedUploadClaimInput {
  videoId: string;
  sessionId: string;
  /** Upload that the storage answered NoSuchUpload for. */
  uploadId: string;
  claimTtlSeconds: number;
}

/**
 * Outcome of the claim for abort of a session whose upload vanished. When another operation
 * changed the session first, nothing is written and the session is returned as it is now
 * (`null` when the video or the session no longer exists).
 */
export type VanishedUploadClaim =
  | { claimed: true; claimToken: string }
  | { claimed: false; session: UploadSession | null };

export interface AbortClaimInput {
  videoId: string;
  sessionId: string;
  claimTtlSeconds: number;
}

/** Why the claim for abort did not take the session; the service maps it to an answer. */
export type AbortRefusal =
  | 'video-not-found'
  | 'session-not-found'
  | 'initiating'
  | 'completing'
  | 'completed';

export type AbortClaim =
  /** The session is now `aborting` with this token; the storage step belongs to the caller. */
  | { outcome: 'claimed'; claimToken: string; session: UploadSession }
  /** `aborted`, or `aborting` within the claim deadline of another operation. */
  | { outcome: 'nothing-to-do'; session: UploadSession }
  | { outcome: 'refused'; reason: AbortRefusal };

export interface RestartIntentInput {
  videoId: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  plan: UploadPlan;
  claimTtlSeconds: number;
}

/**
 * Claim of the sweep (SI-03.24): `claimed` when the session is now `aborting` with this token;
 * `nothing-to-do` when, read under the lock, it is not (or no longer) a session to abort.
 */
export type SweepClaim =
  | { outcome: 'claimed'; claimToken: string; session: UploadSession }
  | { outcome: 'nothing-to-do'; session: UploadSession | null };

/** A session that the sweep may have to act on, read without lock. */
export interface SweepCandidate {
  sessionId: string;
  videoId: string;
  publicId: string;
  status: UploadSessionStatus;
}

/** Why T1 of the restart recorded nothing; the service maps it to an answer. */
export type RestartRefusal =
  | 'video-not-found'
  | 'video-not-draft'
  | 'completing'
  | 'initiating'
  | 'inconsistent';

/** The previous session claimed for abort in T1, with the token of that claim. */
export interface ClaimedPreviousSession {
  session: UploadSession;
  claimToken: string;
}

export type RestartIntent =
  | {
      outcome: 'recorded';
      intent: CreationIntent;
      /** `null` when the current session was `aborting`, `aborted` or absent: nothing to claim. */
      previous: ClaimedPreviousSession | null;
    }
  | { outcome: 'refused'; reason: RestartRefusal };

/** Result of the ownership lookup: what was found, without deciding the HTTP outcome. */
export type OwnedUploadSessionLookup =
  | { found: 'none' }
  | { found: 'video'; video: Video }
  | ({ found: 'session' } & OwnedUploadSession);

/**
 * Transitions of the upload sessions in the database (plan's "Coordenação e fencing"). Each method
 * is one short transaction or one conditional statement; none calls the storage.
 */
@Injectable()
export class UploadSessionsRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly videoLock: VideoLockService,
  ) {}

  /**
   * T1 of P1 for POST /videos: in one transaction, the video in `draft`, its session in
   * `initiating` with the id and the key generated here, the claim token and its deadline, and the
   * pointer of the video to the session. Nothing is sent to the storage before this commit.
   */
  async recordCreationIntent(
    input: CreationIntentInput,
  ): Promise<CreationIntent> {
    const sessionId = randomUUID();
    const claimToken = randomUUID();

    return this.dataSource.transaction(async (manager) => {
      const { videoId, publicId } = await withPublicIdRetry(
        async (candidate) => {
          const { identifiers } = await manager.insert(Video, {
            public_id: candidate,
            channel_id: input.channelId,
            status: VideoStatus.DRAFT,
            original_filename: input.fileName,
            content_type: input.contentType,
            size_bytes: input.sizeBytes,
          });
          return { videoId: identifiers[0].id as string, publicId: candidate };
        },
        { manager },
      );

      const objectKey = await insertInitiatingSession(manager, {
        sessionId,
        videoId,
        sizeBytes: input.sizeBytes,
        plan: input.plan,
        claimToken,
        claimTtlSeconds: input.claimTtlSeconds,
      });
      await manager.update(
        Video,
        { id: videoId },
        { current_upload_session_id: sessionId },
      );

      return { videoId, publicId, sessionId, objectKey, claimToken };
    });
  }

  /**
   * T1 of P1 for the restart, with the video locked. The video must be in `draft`, and its current
   * session `C` is read again and examined (SI-03.18):
   * - `completing`, whatever its claim deadline → refused (F-07);
   * - `initiating` within its claim deadline → refused;
   * - `initiating` with an expired claim, or `active` → `C` goes to `aborting` with a new token;
   * - `aborting`, `aborted` or no session → nothing to claim.
   * Then, in the same transaction, the new session `S` in `initiating`, with a new id, key and
   * token, and the pointer and the declarations of the video. Nothing is sent to the storage here.
   */
  async recordRestartIntent(input: RestartIntentInput): Promise<RestartIntent> {
    const sessionId = randomUUID();
    const claimToken = randomUUID();
    const previousClaimToken = randomUUID();
    return this.videoLock.withLockedVideo(
      input.videoId,
      async (video, manager): Promise<RestartIntent> => {
        if (!video) {
          return { outcome: 'refused', reason: 'video-not-found' };
        }
        if (video.status !== VideoStatus.DRAFT) {
          return { outcome: 'refused', reason: 'video-not-draft' };
        }
        let previous: ClaimedPreviousSession | null = null;
        if (video.current_upload_session_id) {
          const claim = await this.claimForAbortUnderLock(
            manager,
            {
              videoId: video.id,
              sessionId: video.current_upload_session_id,
              claimTtlSeconds: input.claimTtlSeconds,
            },
            previousClaimToken,
            decideRestart,
          );
          if (claim.kind === 'decided' && claim.decision !== 'proceed') {
            return { outcome: 'refused', reason: claim.decision };
          }
          if (claim.kind === 'claimed') {
            previous = {
              session: claim.session,
              claimToken: previousClaimToken,
            };
          }
        }

        const objectKey = await insertInitiatingSession(manager, {
          sessionId,
          videoId: video.id,
          sizeBytes: input.sizeBytes,
          plan: input.plan,
          claimToken,
          claimTtlSeconds: input.claimTtlSeconds,
        });
        await manager.update(
          Video,
          { id: video.id },
          {
            current_upload_session_id: sessionId,
            original_filename: input.fileName,
            content_type: input.contentType,
            size_bytes: input.sizeBytes,
          },
        );
        return {
          outcome: 'recorded',
          intent: {
            videoId: video.id,
            publicId: video.public_id,
            sessionId,
            objectKey,
            claimToken,
          },
          previous,
        };
      },
    );
  }

  /**
   * Failure of the CreateMultipartUpload of a restart (P1): with the video locked, `S` goes
   * `initiating → aborted` only while it holds this token, so a session already taken over by
   * another operation is never overwritten. The video stays in `draft`, restartable (Q-04).
   */
  async abortInitiatingSession(intent: CreationIntent): Promise<boolean> {
    return this.videoLock.withLockedVideo(
      intent.videoId,
      async (_, manager) => {
        const result = await manager
          .createQueryBuilder()
          .update(UploadSession)
          .set({
            status: UploadSessionStatus.ABORTED,
            claim_token: null,
            claim_expires_at: null,
          })
          .where('id = :sessionId', { sessionId: intent.sessionId })
          .andWhere('status = :fromStatus', {
            fromStatus: UploadSessionStatus.INITIATING,
          })
          .andWhere('claim_token = :claimToken', {
            claimToken: intent.claimToken,
          })
          .execute();
        return result.affected === 1;
      },
    );
  }

  /**
   * T2 of P1: `initiating → active` only while the session still holds this claim token. Returns
   * the new expiry, or `null` when zero rows were affected because the sweep or a restart took the
   * session over after the claim deadline.
   */
  async activateSession(input: SessionActivation): Promise<Date | null> {
    const result = await this.dataSource
      .createQueryBuilder()
      .update(UploadSession)
      .set({
        status: UploadSessionStatus.ACTIVE,
        upload_id: input.uploadId,
        expires_at: () => NOW_PLUS_SECONDS('sessionTtlSeconds'),
        claim_token: null,
        claim_expires_at: null,
      })
      .where('id = :sessionId', { sessionId: input.sessionId })
      .andWhere('status = :fromStatus', {
        fromStatus: UploadSessionStatus.INITIATING,
      })
      .andWhere('claim_token = :claimToken', { claimToken: input.claimToken })
      .setParameter('sessionTtlSeconds', input.sessionTtlSeconds)
      .returning(['expires_at'])
      .execute();

    const rows = result.raw as { expires_at: Date }[];
    return result.affected === 1 && rows.length === 1
      ? rows[0].expires_at
      : null;
  }

  /**
   * Compensation of P1 when the CreateMultipartUpload of POST /videos fails: with the video
   * locked, deletes the session only while it is still `initiating` with this token, and then the
   * draft video. Returns `false`, deleting nothing, when another process already took the
   * session over: the video then stays in `draft`, restartable.
   */
  async compensateCreation(intent: CreationIntent): Promise<boolean> {
    return this.videoLock.withLockedVideo(
      intent.videoId,
      async (video, manager) => {
        if (!video) {
          return false;
        }
        const deleted = await manager.delete(UploadSession, {
          id: intent.sessionId,
          status: UploadSessionStatus.INITIATING,
          claim_token: intent.claimToken,
        });
        if (deleted.affected !== 1) {
          return false;
        }
        await manager.delete(Video, {
          id: intent.videoId,
          status: VideoStatus.DRAFT,
        });
        return true;
      },
    );
  }

  /**
   * Reads, without locking, the video of `publicId` in the channel of `userId`. A video of another
   * channel is reported as not found (`null`).
   */
  async findOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video | null> {
    return this.dataSource
      .getRepository(Video)
      .createQueryBuilder('video')
      .innerJoin('video.channel', 'channel')
      .where('video.public_id = :publicId', { publicId })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();
  }

  /**
   * Reads, without locking, the video of `publicId` in the channel of `userId` and its session
   * `sessionId`. A video of another channel is reported as not found.
   */
  async findOwnedSession(
    userId: string,
    publicId: string,
    sessionId: string,
  ): Promise<OwnedUploadSessionLookup> {
    const video = await this.findOwnedVideo(userId, publicId);
    if (!video) {
      return { found: 'none' };
    }
    const { entities, raw } = await this.dataSource
      .getRepository(UploadSession)
      .createQueryBuilder('session')
      .addSelect('session.expires_at <= now()', 'session_expired')
      .where('session.id = :sessionId', { sessionId })
      .andWhere('session.video_id = :videoId', { videoId: video.id })
      .getRawAndEntities<{ session_expired: boolean }>();
    if (entities.length === 0) {
      return { found: 'video', video };
    }
    return {
      found: 'session',
      video,
      session: entities[0],
      expired: raw[0].session_expired,
    };
  }

  /**
   * Claim for abort of an `active` session whose upload the storage no longer knows (F-10): with
   * the video locked, the session is read again and, only if it is still `active` with that
   * upload, it goes `active → aborting` with a new token and claim deadline. A session that a
   * concurrent operation already moved (completion, restart, abort) is left as it is.
   */
  async claimVanishedUpload(
    input: VanishedUploadClaimInput,
  ): Promise<VanishedUploadClaim> {
    const claimToken = randomUUID();
    return this.videoLock.withLockedVideo(
      input.videoId,
      async (video, manager): Promise<VanishedUploadClaim> => {
        if (!video) {
          return { claimed: false, session: null };
        }
        const session = await manager.getRepository(UploadSession).findOneBy({
          id: input.sessionId,
          video_id: input.videoId,
        });
        if (!session || session.status !== UploadSessionStatus.ACTIVE) {
          return { claimed: false, session };
        }
        const result = await manager
          .createQueryBuilder()
          .update(UploadSession)
          .set({
            status: UploadSessionStatus.ABORTING,
            claim_token: claimToken,
            claim_expires_at: () => NOW_PLUS_SECONDS('claimTtlSeconds'),
          })
          .where('id = :sessionId', { sessionId: input.sessionId })
          .andWhere('status = :fromStatus', {
            fromStatus: UploadSessionStatus.ACTIVE,
          })
          .andWhere('upload_id = :uploadId', { uploadId: input.uploadId })
          .setParameter('claimTtlSeconds', input.claimTtlSeconds)
          .execute();
        if (result.affected !== 1) {
          // Under the lock, an `active` session only keeps the upload of its activation.
          throw new Error(
            `Active session ${input.sessionId} does not hold the upload ${input.uploadId}`,
          );
        }
        return { claimed: true, claimToken };
      },
    );
  }

  /**
   * Claim for abort of DELETE (F-07), with the video locked and the session read again, with its
   * claim deadline evaluated by the clock of the database:
   * - `active`, or `initiating`/`aborting` with an expired claim → `aborting` with a new token;
   * - `aborted`, or `aborting` within the claim deadline → nothing to do;
   * - `initiating` within the claim deadline, `completing` (whatever its deadline) and `completed`
   *   → refused.
   * The UPDATE repeats the origin and, for a takeover, the previous token and its expired
   * deadline. Zero rows under the lock come from the lockless transitions that end a claim (the
   * activation of P1 and `markAborted`), so the session is read once more and evaluated again.
   */
  async claimAbort(input: AbortClaimInput): Promise<AbortClaim> {
    const claimToken = randomUUID();
    return this.videoLock.withLockedVideo(
      input.videoId,
      async (video, manager): Promise<AbortClaim> => {
        if (!video) {
          return { outcome: 'refused', reason: 'video-not-found' };
        }
        const claim = await this.claimForAbortUnderLock(
          manager,
          input,
          claimToken,
          (session, claimExpired) => {
            const decision = decideAbort(session, claimExpired);
            return decision.outcome === 'take' ? 'take' : decision;
          },
        );
        if (claim.kind === 'missing') {
          return { outcome: 'refused', reason: 'session-not-found' };
        }
        return claim.kind === 'claimed'
          ? { outcome: 'claimed', claimToken, session: claim.session }
          : claim.decision;
      },
    );
  }

  /**
   * Claim of the sweep (P1, P2; G-10, F-08), with the video locked and the session read again,
   * with its deadlines evaluated by the clock of the database:
   * - `active` with `expires_at <= now()` → `aborting` with a new token. The UPDATE repeats the
   *   predicate, complementary to the `expires_at > now()` of the completion (F-08);
   * - `initiating` or `aborting` with an expired claim → taken over with a new token;
   * - anything else → nothing to do. A `completing` session is never claimed for abort, whatever
   *   its deadlines: the sweep resumes its completion instead (P2).
   */
  async claimForSweep(input: AbortClaimInput): Promise<SweepClaim> {
    const claimToken = randomUUID();
    return this.videoLock.withLockedVideo(
      input.videoId,
      async (video, manager): Promise<SweepClaim> => {
        if (!video) {
          return { outcome: 'nothing-to-do', session: null };
        }
        const claim = await this.claimForAbortUnderLock(
          manager,
          input,
          claimToken,
          (session, claimExpired, expired) =>
            decideSweep(session, claimExpired, expired) ? 'take' : session,
          { activeOnlyWhenExpired: true },
        );
        if (claim.kind === 'missing') {
          return { outcome: 'nothing-to-do', session: null };
        }
        return claim.kind === 'claimed'
          ? { outcome: 'claimed', claimToken, session: claim.session }
          : { outcome: 'nothing-to-do', session: claim.decision };
      },
    );
  }

  /**
   * The sessions that the sweep may have to act on, oldest deadline first, read without lock:
   * `active` past `expires_at`, and `initiating`, `aborting` or `completing` past their claim
   * deadline. Each one is decided again under the lock of its video.
   */
  async findSweepCandidates(batchSize: number): Promise<SweepCandidate[]> {
    const rows = await this.dataSource
      .getRepository(UploadSession)
      .createQueryBuilder('session')
      .innerJoin('session.video', 'video')
      .select('session.id', 'sessionId')
      .addSelect('session.video_id', 'videoId')
      .addSelect('video.public_id', 'publicId')
      .addSelect('session.status', 'status')
      .where(
        '(session.status = :active AND session.expires_at <= now())' +
          ' OR (session.status IN (:...claimed) AND session.claim_expires_at <= now())',
        {
          active: UploadSessionStatus.ACTIVE,
          claimed: [
            UploadSessionStatus.INITIATING,
            UploadSessionStatus.ABORTING,
            UploadSessionStatus.COMPLETING,
          ],
        },
      )
      .orderBy(
        'CASE WHEN session.status = :active THEN session.expires_at ELSE session.claim_expires_at END',
        'ASC',
      )
      .addOrderBy('session.id', 'ASC')
      .limit(batchSize)
      .getRawMany<SweepCandidate>();
    return rows;
  }

  /**
   * `aborting → aborted` once the storage answered NoSuchUpload for the upload of the session,
   * only while the session still holds this claim token. Returns `false` when zero rows were
   * affected because another process took the session over after the claim deadline.
   */
  async markAborted(sessionId: string, claimToken: string): Promise<boolean> {
    const result = await this.dataSource
      .createQueryBuilder()
      .update(UploadSession)
      .set({
        status: UploadSessionStatus.ABORTED,
        claim_token: null,
        claim_expires_at: null,
      })
      .where('id = :sessionId', { sessionId })
      .andWhere('status = :fromStatus', {
        fromStatus: UploadSessionStatus.ABORTING,
      })
      .andWhere('claim_token = :claimToken', { claimToken })
      .execute();
    return result.affected === 1;
  }

  /**
   * With the video already locked by the caller, reads the session and, when `decide` says
   * `take`, claims it for abort: `aborting` with `claimToken` and a new deadline. The UPDATE
   * repeats the origin and, for a takeover of a claim (`initiating`, `aborting`), the previous
   * token and its expired deadline. Zero rows under the lock come from the lockless transitions
   * that end a claim (the activation of P1 and `markAborted`), so the session is read and decided
   * once more; zero rows twice is an internal error.
   */
  private async claimForAbortUnderLock<D>(
    manager: EntityManager,
    input: AbortClaimInput,
    claimToken: string,
    decide: (
      session: UploadSession,
      claimExpired: boolean,
      expired: boolean,
    ) => D | 'take',
    options: { activeOnlyWhenExpired?: boolean } = {},
  ): Promise<
    | { kind: 'claimed'; session: UploadSession }
    | { kind: 'decided'; decision: D }
    | { kind: 'missing' }
  > {
    for (let evaluation = 1; ; evaluation++) {
      const locked = await this.readSessionClaim(manager, input);
      if (!locked) {
        return { kind: 'missing' };
      }
      const decision = decide(
        locked.session,
        locked.claimExpired,
        locked.expired,
      );
      if (decision !== 'take') {
        return { kind: 'decided', decision };
      }
      const update = manager
        .createQueryBuilder()
        .update(UploadSession)
        .set({
          status: UploadSessionStatus.ABORTING,
          claim_token: claimToken,
          claim_expires_at: () => NOW_PLUS_SECONDS('claimTtlSeconds'),
        })
        .where('id = :sessionId', { sessionId: locked.session.id })
        .andWhere('status = :fromStatus', {
          fromStatus: locked.session.status,
        })
        .setParameter('claimTtlSeconds', input.claimTtlSeconds);
      if (locked.session.status !== UploadSessionStatus.ACTIVE) {
        update
          .andWhere('claim_token = :previousToken', {
            previousToken: locked.session.claim_token,
          })
          .andWhere('claim_expires_at <= now()');
      } else if (options.activeOnlyWhenExpired) {
        update.andWhere('expires_at <= now()');
      }
      const result = await update.execute();
      if (result.affected === 1) {
        const session = await manager
          .getRepository(UploadSession)
          .findOneByOrFail({ id: locked.session.id });
        return { kind: 'claimed', session };
      }
      if (evaluation === 2) {
        throw new Error(
          `Claim for abort of session ${input.sessionId} affected no row twice under the lock`,
        );
      }
    }
  }

  private async readSessionClaim(
    manager: EntityManager,
    input: AbortClaimInput,
  ): Promise<{
    session: UploadSession;
    claimExpired: boolean;
    expired: boolean;
  } | null> {
    const { entities, raw } = await manager
      .getRepository(UploadSession)
      .createQueryBuilder('session')
      .addSelect(
        'session.claim_expires_at IS NOT NULL AND session.claim_expires_at <= now()',
        'claim_expired',
      )
      .addSelect('session.expires_at <= now()', 'session_expired')
      .where('session.id = :sessionId', { sessionId: input.sessionId })
      .andWhere('session.video_id = :videoId', { videoId: input.videoId })
      .getRawAndEntities<{
        claim_expired: boolean;
        session_expired: boolean;
      }>();
    if (entities.length === 0) {
      return null;
    }
    return {
      session: entities[0],
      claimExpired: raw[0].claim_expired,
      expired: raw[0].session_expired,
    };
  }

  /**
   * Blocks the session for a file mismatch (F-11). It is a single autocommit statement, so the
   * mark stays recorded even though the request that found the mismatch answers with an error.
   */
  async markFileMismatch(sessionId: string): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(UploadSession)
      .set({ file_mismatch_at: () => 'now()' })
      .where('id = :sessionId', { sessionId })
      .andWhere('file_mismatch_at IS NULL')
      .execute();
  }
}

/** The conduct of DELETE for the state read under the lock (SI-03.17, F-07). */
export function decideAbort(
  session: UploadSession,
  claimExpired: boolean,
): Exclude<AbortClaim, { outcome: 'claimed' }> | { outcome: 'take' } {
  switch (session.status) {
    case UploadSessionStatus.ACTIVE:
      return { outcome: 'take' };
    case UploadSessionStatus.INITIATING:
      return claimExpired
        ? { outcome: 'take' }
        : { outcome: 'refused', reason: 'initiating' };
    case UploadSessionStatus.ABORTING:
      return claimExpired
        ? { outcome: 'take' }
        : { outcome: 'nothing-to-do', session };
    case UploadSessionStatus.ABORTED:
      return { outcome: 'nothing-to-do', session };
    case UploadSessionStatus.COMPLETING:
      return { outcome: 'refused', reason: 'completing' };
    case UploadSessionStatus.COMPLETED:
      return { outcome: 'refused', reason: 'completed' };
  }
}

/**
 * Whether the sweep claims the session for abort (SI-03.24), for the state read under the lock:
 * `active` past `expires_at`, or `initiating`/`aborting` past the claim deadline. `completing` is
 * never aborted by the sweep, whatever its deadlines; its completion is resumed instead (P2).
 */
export function decideSweep(
  session: UploadSession,
  claimExpired: boolean,
  expired: boolean,
): boolean {
  switch (session.status) {
    case UploadSessionStatus.ACTIVE:
      return expired;
    case UploadSessionStatus.INITIATING:
    case UploadSessionStatus.ABORTING:
      return claimExpired;
    case UploadSessionStatus.COMPLETING:
    case UploadSessionStatus.COMPLETED:
    case UploadSessionStatus.ABORTED:
      return false;
  }
}

/**
 * The conduct of the restart for the current session read under the lock (P1, SI-03.18):
 * `take` claims it for abort, `proceed` records the new session without touching it, and the
 * other values refuse the restart.
 */
export function decideRestart(
  current: UploadSession,
  claimExpired: boolean,
):
  | 'take'
  | 'proceed'
  | Exclude<RestartRefusal, 'video-not-found' | 'video-not-draft'> {
  switch (current.status) {
    case UploadSessionStatus.ACTIVE:
      return 'take';
    case UploadSessionStatus.INITIATING:
      return claimExpired ? 'take' : 'initiating';
    case UploadSessionStatus.COMPLETING:
      return 'completing';
    case UploadSessionStatus.ABORTING:
    case UploadSessionStatus.ABORTED:
      return 'proceed';
    case UploadSessionStatus.COMPLETED:
      // A completed current session leaves the video in `processing` (T2 of P2 is atomic).
      return 'inconsistent';
  }
}

/**
 * Inserts a session in `initiating` (T1 of P1), with the id and the key generated by the server,
 * the claim token and its deadline; in `initiating`, the session expires with its claim. Returns
 * the key of the original of the session.
 */
async function insertInitiatingSession(
  manager: EntityManager,
  input: {
    sessionId: string;
    videoId: string;
    sizeBytes: number;
    plan: UploadPlan;
    claimToken: string;
    claimTtlSeconds: number;
  },
): Promise<string> {
  const objectKey = originalObjectKey(input.videoId, input.sessionId);
  await manager
    .createQueryBuilder()
    .insert()
    .into(UploadSession)
    .values({
      id: input.sessionId,
      video_id: input.videoId,
      object_key: objectKey,
      upload_id: null,
      status: UploadSessionStatus.INITIATING,
      size_bytes: input.sizeBytes,
      part_size: input.plan.partSize,
      part_count: input.plan.partCount,
      claim_token: input.claimToken,
      claim_expires_at: () => NOW_PLUS_SECONDS('claimTtlSeconds'),
      expires_at: () => NOW_PLUS_SECONDS('claimTtlSeconds'),
    })
    .setParameter('claimTtlSeconds', input.claimTtlSeconds)
    .execute();
  return objectKey;
}
