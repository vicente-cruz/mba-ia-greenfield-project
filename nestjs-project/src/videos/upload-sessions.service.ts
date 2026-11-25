import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { StorageUnavailableException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import type { UploadSessionResponseDto } from './dto/upload-session-response.dto';
import type { VideoUploadSessionResponseDto } from './dto/video-upload-session-response.dto';
import {
  type UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import { VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  UnsupportedVideoTypeException,
  UploadSessionCompletingException,
  UploadSessionExpiredException,
  UploadSessionInitiatingException,
  UploadSessionNotActiveException,
  UploadSessionNotFoundException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import type { ClassifiedPart } from './upload-part-classification';
import { UploadPartsService } from './upload-parts.service';
import { planUpload, type UploadPlan } from './upload-plan';
import { UploadSessionAccessService } from './upload-session-access.service';
import {
  type AbortRefusal,
  type ClaimedPreviousSession,
  type CreationIntent,
  type RestartRefusal,
  UploadSessionsRepository,
} from './upload-sessions.repository';
import {
  ABORT_CONFIRMATION,
  ACCEPTED_VIDEO_CONTENT_TYPES,
  LIST_PARTS_PAGE_SIZE,
  UPLOAD_CHECKSUM_ALGORITHM,
} from './videos.constants';

/** File declared to start an upload, already structurally valid. */
/**
 * Outcome of the abort of one session by the sweep (SI-03.24):
 * - `aborted`: NoSuchUpload confirmed and `aborting → aborted` by the token;
 * - `abort-unconfirmed`: the storage did not confirm (F-09) or could not be reached; the session
 *   stays `aborting` with the claim of the sweep, retried after the claim deadline;
 * - `taken-over`: confirmed, but another process took the session over before the mark;
 * - `nothing-to-do`: read under the lock, the session was not one to abort.
 */
export type SweepAbortOutcome =
  | 'aborted'
  | 'abort-unconfirmed'
  | 'taken-over'
  | 'nothing-to-do';

export interface UploadDeclaration {
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

/**
 * Upload sessions of the videos, by the protocols of the plan's "Coordenação e fencing". Every
 * step alternates a short transaction of the repository and a storage call, never both at once
 * (G-01).
 */
@Injectable()
export class UploadSessionsService {
  private readonly logger = new Logger(UploadSessionsService.name);

  constructor(
    private readonly channelsService: ChannelsService,
    private readonly uploadSessionAccess: UploadSessionAccessService,
    private readonly uploadSessions: UploadSessionsRepository,
    private readonly uploadParts: UploadPartsService,
    private readonly storage: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /**
   * POST /videos (P1 without a previous session): the draft video and its first session. The
   * response is only produced after the activation (T2).
   */
  async createVideoWithSession(
    userId: string,
    declaration: UploadDeclaration,
  ): Promise<VideoUploadSessionResponseDto> {
    const contentType = this.acceptedContentType(declaration);
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }
    const plan = planUpload(
      declaration.sizeBytes,
      this.config.uploadPartSizeBytes,
    );

    // T1: the intent is recorded before any storage call.
    const intent = await this.uploadSessions.recordCreationIntent({
      channelId: channel.id,
      fileName: declaration.fileName,
      sizeBytes: declaration.sizeBytes,
      contentType,
      plan,
      claimTtlSeconds: this.config.uploadSessionClaimTtlSeconds,
    });

    // Storage, outside any transaction.
    const uploadId = await this.createMultipartOrCompensate(
      intent,
      contentType,
    );

    // T2: activation conditioned on the claim token.
    const expiresAt = await this.activateOrAbort(
      intent,
      uploadId,
      () => new StorageUnavailableException('ActivateUploadSession'),
    );

    return startedSessionResponse(intent, plan, expiresAt);
  }

  /**
   * POST /videos/:publicId/upload-sessions: P1 with a previous session (TD-02, TD-04; Q-04). The
   * declaration follows the domain rules of the creation, and the video must be the owner's and in
   * `draft`. T1 claims the current session for abort and records the new one; the storage calls
   * run outside any transaction; T2 activates the new session by its token.
   */
  async restartSession(
    userId: string,
    publicId: string,
    declaration: UploadDeclaration,
  ): Promise<VideoUploadSessionResponseDto> {
    const video = await this.uploadSessionAccess.getOwnedVideo(
      userId,
      publicId,
    );
    const contentType = this.acceptedContentType(declaration);
    const plan = planUpload(
      declaration.sizeBytes,
      this.config.uploadPartSizeBytes,
    );

    // T1: the previous session claimed for abort and the new one recorded, under the lock.
    const restart = await this.uploadSessions.recordRestartIntent({
      videoId: video.id,
      fileName: declaration.fileName,
      sizeBytes: declaration.sizeBytes,
      contentType,
      plan,
      claimTtlSeconds: this.config.uploadSessionClaimTtlSeconds,
    });
    if (restart.outcome === 'refused') {
      throw restartRefusal(restart.reason);
    }
    const { intent, previous } = restart;

    // Storage, outside any transaction: the new multipart and the abort of the previous session.
    let uploadId: string;
    try {
      ({ uploadId } = await this.storage.createMultipartUpload(
        intent.objectKey,
        { contentType },
      ));
    } catch (error) {
      await this.abandonRestart(intent);
      await this.finishPreviousAbort(previous);
      throw error;
    }
    await this.finishPreviousAbort(previous);

    // T2: activation conditioned on the token; a lost claim belongs to another restart.
    const expiresAt = await this.activateOrAbort(
      intent,
      uploadId,
      () => new UploadSessionNotActiveException(),
    );
    return startedSessionResponse(intent, plan, expiresAt);
  }

  /**
   * GET of the session, base of the resumption ("API Contracts"). Only an `active` session lists
   * its parts, one entry per part of the plan classified against the `ListParts`; the other states
   * answer `parts: []`. `expired` reflects `expires_at <= now()` of an `active` session, by the
   * clock of the database, and does not abort it.
   *
   * When the storage no longer knows the upload of an `active` session (F-10), the session is
   * claimed for abort under the lock of the video and marked `aborted`, and the answer is
   * UPLOAD_SESSION_EXPIRED. If a concurrent operation moved the session first, its new state is
   * kept and returned. A transient storage failure answers STORAGE_UNAVAILABLE and changes
   * nothing.
   */
  async getSession(
    userId: string,
    publicId: string,
    sessionId: string,
  ): Promise<UploadSessionResponseDto> {
    const { session, expired } = await this.uploadSessionAccess.getOwnedSession(
      userId,
      publicId,
      sessionId,
    );
    if (session.status !== UploadSessionStatus.ACTIVE) {
      return this.toSessionResponse(session, false, []);
    }
    const classification = await this.uploadParts.classifyParts(session);
    if (classification.status === 'found') {
      return this.toSessionResponse(session, expired, classification.parts);
    }
    return this.abortVanishedUpload(session, classification.uploadId);
  }

  /**
   * DELETE of the session (F-07, F-09): the claim for abort under the lock of the video, then,
   * outside any transaction, `AbortMultipartUpload` repeated until `ListParts` answers
   * NoSuchUpload, and `aborting → aborted` by the token. When the storage does not confirm, the
   * session stays `aborting` with the claim, and the sweep concludes it. The video is not
   * changed: it stays in `draft`, restartable.
   */
  async abortSession(
    userId: string,
    publicId: string,
    sessionId: string,
  ): Promise<void> {
    const { video, session: owned } =
      await this.uploadSessionAccess.getOwnedSession(
        userId,
        publicId,
        sessionId,
      );
    const claim = await this.uploadSessions.claimAbort({
      videoId: video.id,
      sessionId: owned.id,
      claimTtlSeconds: this.config.uploadSessionClaimTtlSeconds,
    });
    if (claim.outcome === 'nothing-to-do') {
      return;
    }
    if (claim.outcome === 'refused') {
      throw abortRefusal(claim.reason);
    }
    const confirmed = await this.abortInStorage(claim.session);
    if (!confirmed) {
      this.logger.warn(
        `Abort of session ${claim.session.id} not confirmed by the storage; it stays aborting for the sweep (F-09)`,
      );
      return;
    }
    const marked = await this.uploadSessions.markAborted(
      claim.session.id,
      claim.claimToken,
    );
    if (!marked) {
      this.logger.warn(
        `Session ${claim.session.id} was taken over before being marked aborted`,
      );
    }
  }

  /**
   * Abort of one session by the sweep (SI-03.24; P1, G-10, F-08, F-09): the claim of the sweep
   * under the lock of the video, then, outside any transaction, the same abort as DELETE
   * (`AbortMultipartUpload` repeated until `ListParts` answers NoSuchUpload) and
   * `aborting → aborted` by the token. The video is not changed.
   */
  async sweepAbort(
    videoId: string,
    sessionId: string,
  ): Promise<SweepAbortOutcome> {
    const claim = await this.uploadSessions.claimForSweep({
      videoId,
      sessionId,
      claimTtlSeconds: this.config.uploadSessionClaimTtlSeconds,
    });
    if (claim.outcome === 'nothing-to-do') {
      return 'nothing-to-do';
    }
    if (!(await this.abortInStorage(claim.session))) {
      return 'abort-unconfirmed';
    }
    const marked = await this.uploadSessions.markAborted(
      claim.session.id,
      claim.claimToken,
    );
    return marked ? 'aborted' : 'taken-over';
  }

  /**
   * Aborts every multipart upload of the session and confirms that each one is gone. The uploads
   * are the `upload_id` of the session or, without it (a session that never left `initiating`),
   * the ones open at its exact key: the storage only lists them bucket-wide (SI-03.9). A transient
   * failure of the storage is not a confirmation either; the claim then stays for the sweep.
   */
  private async abortInStorage(session: UploadSession): Promise<boolean> {
    try {
      const uploadIds = session.upload_id
        ? [session.upload_id]
        : (await this.storage.listMultipartUploads(session.object_key))
            .filter((upload) => upload.key === session.object_key)
            .map((upload) => upload.uploadId);
      for (const uploadId of uploadIds) {
        if (!(await this.abortUntilGone(session.object_key, uploadId))) {
          return false;
        }
      }
      return true;
    } catch (error) {
      if (error instanceof StorageUnavailableException) {
        this.logger.warn(
          `Storage unavailable while aborting session ${session.id}; it stays aborting for the sweep`,
          error.message,
        );
        return false;
      }
      throw error;
    }
  }

  /**
   * `AbortMultipartUpload` and then `ListParts`, up to `ABORT_CONFIRMATION.ATTEMPTS` times: the
   * abort answer alone does not prove that the upload is gone, and a part in transit can keep it
   * listed for a while (F-09).
   */
  private async abortUntilGone(
    key: string,
    uploadId: string,
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      await this.storage.abortMultipartUpload(key, uploadId);
      const listed = await this.storage.listParts(key, uploadId, {
        pageSize: LIST_PARTS_PAGE_SIZE,
      });
      if (listed.status === 'no-such-upload') {
        return true;
      }
      if (attempt >= ABORT_CONFIRMATION.ATTEMPTS) {
        return false;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, ABORT_CONFIRMATION.RETRY_DELAY_MS),
      );
    }
  }

  /**
   * Domain rules applied after the structural validation of the DTO: the size limit (413) and the
   * accepted types (415). MIME types are case-insensitive; the stored value is lowercase.
   */
  private acceptedContentType({
    sizeBytes,
    contentType,
  }: UploadDeclaration): string {
    if (sizeBytes > this.config.maxSizeBytes) {
      throw new VideoTooLargeException(this.config.maxSizeBytes);
    }
    const normalized = contentType.toLowerCase();
    if (!ACCEPTED_VIDEO_CONTENT_TYPES.includes(normalized)) {
      throw new UnsupportedVideoTypeException();
    }
    return normalized;
  }

  /**
   * CreateMultipartUpload with SHA-256 checksums. On any failure, the creation is compensated and
   * the original error is thrown: STORAGE_UNAVAILABLE (503) for a transient failure.
   */
  private async createMultipartOrCompensate(
    intent: CreationIntent,
    contentType: string,
  ): Promise<string> {
    try {
      const { uploadId } = await this.storage.createMultipartUpload(
        intent.objectKey,
        { contentType },
      );
      return uploadId;
    } catch (error) {
      await this.compensateCreation(intent);
      throw error;
    }
  }

  /**
   * Removes the video and its session only while the session is still `initiating` with this
   * token. A failure of the compensation itself is logged and does not replace the storage
   * failure, which the caller throws: the session then expires with its claim, and the sweep
   * takes it over (P1).
   */
  private async compensateCreation(intent: CreationIntent): Promise<void> {
    try {
      const removed = await this.uploadSessions.compensateCreation(intent);
      if (!removed) {
        this.logger.warn(
          `Creation of video ${intent.videoId} not compensated: session ${intent.sessionId} no longer holds its claim`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Compensation of video ${intent.videoId} failed; session ${intent.sessionId} is left to the sweep`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Failure of the CreateMultipartUpload of a restart: the new session goes `initiating →
   * aborted` by its token, and the video stays in `draft`, restartable (P1, Q-04). A failure of
   * this step itself is logged and does not replace the storage failure, which the caller throws;
   * the session then expires with its claim, and the sweep takes it over.
   */
  private async abandonRestart(intent: CreationIntent): Promise<void> {
    try {
      const aborted = await this.uploadSessions.abortInitiatingSession(intent);
      if (!aborted) {
        this.logger.warn(
          `Restarted session ${intent.sessionId} was taken over before being marked aborted`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Abandon of restarted session ${intent.sessionId} failed; it is left to the sweep`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The abort of the previous session claimed in T1, as in SI-03.17: confirmed by `ListParts`
   * and then `aborted` by the token of T1. Without confirmation, or on any failure, the previous
   * session stays `aborting` with its claim for the sweep (F-09); the restart does not depend on
   * it, so the outcome is logged and not thrown.
   */
  private async finishPreviousAbort(
    previous: ClaimedPreviousSession | null,
  ): Promise<void> {
    if (!previous) {
      return;
    }
    try {
      if (!(await this.abortInStorage(previous.session))) {
        this.logger.warn(
          `Abort of previous session ${previous.session.id} not confirmed by the storage; it stays aborting for the sweep (F-09)`,
        );
        return;
      }
      const marked = await this.uploadSessions.markAborted(
        previous.session.id,
        previous.claimToken,
      );
      if (!marked) {
        this.logger.warn(
          `Previous session ${previous.session.id} was taken over before being marked aborted`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Abort of previous session ${previous.session.id} failed; it stays aborting for the sweep`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * T2. With zero rows, another process took the session over after the claim deadline: the own
   * upload is aborted, the draft video is kept without compensation (it is restartable), and the
   * answer comes from `lostClaim` (P1): STORAGE_UNAVAILABLE for POST /videos and
   * UPLOAD_SESSION_NOT_ACTIVE for the restart. If T2 itself fails, the own upload is aborted as
   * well and the error is thrown.
   */
  private async activateOrAbort(
    intent: CreationIntent,
    uploadId: string,
    lostClaim: () => Error,
  ): Promise<Date> {
    let expiresAt: Date | null;
    try {
      expiresAt = await this.uploadSessions.activateSession({
        sessionId: intent.sessionId,
        claimToken: intent.claimToken,
        uploadId,
        sessionTtlSeconds: this.config.uploadSessionTtlSeconds,
      });
    } catch (error) {
      await this.abortOwnUpload(intent, uploadId);
      throw error;
    }
    if (expiresAt === null) {
      this.logger.warn(
        `Session ${intent.sessionId} of video ${intent.videoId} was taken over before its activation`,
      );
      await this.abortOwnUpload(intent, uploadId);
      throw lostClaim();
    }
    return expiresAt;
  }

  /**
   * F-10: claim `active → aborting` under the lock of the video, then `aborting → aborted` by the
   * token. The NoSuchUpload already received for the `upload_id` of the session is final, so it
   * confirms the abort without another storage call. A session moved by a concurrent operation
   * before the claim is returned as it is now.
   */
  private async abortVanishedUpload(
    session: UploadSession,
    uploadId: string,
  ): Promise<UploadSessionResponseDto> {
    const claim = await this.uploadSessions.claimVanishedUpload({
      videoId: session.video_id,
      sessionId: session.id,
      uploadId,
      claimTtlSeconds: this.config.uploadSessionClaimTtlSeconds,
    });
    if (!claim.claimed) {
      if (!claim.session) {
        throw new UploadSessionNotFoundException();
      }
      return this.toSessionResponse(claim.session, false, []);
    }
    this.logger.warn(
      `Upload of session ${session.id} of video ${session.video_id} no longer exists in the storage; session claimed for abort (F-10)`,
    );
    const aborted = await this.uploadSessions.markAborted(
      session.id,
      claim.claimToken,
    );
    if (!aborted) {
      this.logger.warn(
        `Session ${session.id} was taken over before being marked aborted`,
      );
    }
    throw new UploadSessionExpiredException();
  }

  private toSessionResponse(
    session: UploadSession,
    expired: boolean,
    parts: ClassifiedPart[],
  ): UploadSessionResponseDto {
    return {
      id: session.id,
      status: session.status,
      expired,
      fileMismatch: session.file_mismatch_at !== null,
      partSize: session.part_size,
      partCount: session.part_count,
      checksumAlgorithm: UPLOAD_CHECKSUM_ALGORITHM,
      expiresAt: session.expires_at,
      parts,
    };
  }

  /**
   * Best effort, as in P1: if the abort fails, the upload is still found by the sweep, which
   * aborts the uploads of the key of the session, or by the cleanup of P4.
   */
  private async abortOwnUpload(
    intent: CreationIntent,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(intent.objectKey, uploadId);
    } catch (error) {
      this.logger.warn(
        `Abort of the upload of session ${intent.sessionId} failed; the sweep or the cleanup removes it`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function abortRefusal(reason: AbortRefusal): Error {
  switch (reason) {
    case 'video-not-found':
      return new VideoNotFoundException();
    case 'session-not-found':
      return new UploadSessionNotFoundException();
    case 'initiating':
      return new UploadSessionInitiatingException();
    case 'completing':
      return new UploadSessionCompletingException();
    case 'completed':
      return new UploadSessionNotActiveException();
  }
}

function restartRefusal(reason: RestartRefusal): Error {
  switch (reason) {
    case 'video-not-found':
      return new VideoNotFoundException();
    case 'video-not-draft':
    case 'inconsistent':
      return new VideoInvalidStateException();
    case 'completing':
      return new UploadSessionCompletingException();
    case 'initiating':
      return new UploadSessionInitiatingException();
  }
}

/** Body of POST /videos and of the restart: the session just activated by T2 of P1. */
function startedSessionResponse(
  intent: CreationIntent,
  plan: UploadPlan,
  expiresAt: Date,
): VideoUploadSessionResponseDto {
  return {
    publicId: intent.publicId,
    status: VideoStatus.DRAFT,
    uploadSession: {
      id: intent.sessionId,
      status: UploadSessionStatus.ACTIVE,
      partSize: plan.partSize,
      partCount: plan.partCount,
      checksumAlgorithm: UPLOAD_CHECKSUM_ALGORITHM,
      expiresAt,
    },
  };
}
