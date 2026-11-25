import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../config/video.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type { CompletedPartInput } from '../storage/storage.types';
import type { UploadCompletionResponseDto } from './dto/upload-completion-response.dto';
import {
  type UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import { VideoStatus } from './entities/video.entity';
import {
  UploadCompletionInterruptedException,
  UploadFileMismatchException,
  UploadIncompleteException,
  UploadPartMismatchException,
  UploadSessionCompletingException,
  UploadSessionExpiredException,
  UploadSessionNotActiveException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { VideoJobDispatcherService } from './jobs/video-job-dispatcher.service';
import { withTimeout } from './jobs/with-timeout';
import {
  type CompletionRefusal,
  isCompletionOf,
  UploadCompletionRepository,
} from './upload-completion.repository';
import {
  type ClassifiedPart,
  UploadPartState,
} from './upload-part-classification';
import {
  type PartClassification,
  UploadPartsService,
} from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import {
  FIRST_JOB_DISPATCH,
  VIDEO_JOB_PUBLISH_TIMEOUT_MS,
} from './videos.constants';

/** Answer of the completion: `transitioned` is 202 (this call moved the video), otherwise 200. */
export interface UploadCompletionResult {
  transitioned: boolean;
  body: UploadCompletionResponseDto;
}

/**
 * Outcome of the resumption of an expired completion by the sweep (SI-03.24):
 * - `finalized`: this resumption moved the session to `completed` and the video to `processing`;
 * - `completed-elsewhere`: after losing the token, the re-read found the completion recorded;
 * - `not-resumed`: read under the lock, there was no expired `completing` claim to take over;
 * - `decided`: the protocol ended the attempt (reverted to `active`, `aborted` without an object,
 *   or re-read after losing the token), with the domain code that the route would answer.
 */
export type CompletionResumeOutcome =
  | { outcome: 'finalized' }
  | { outcome: 'completed-elsewhere' }
  | { outcome: 'not-resumed'; reason: CompletionRefusal | 'completed' }
  | { outcome: 'decided'; errorCode: string };

/** Outcome of step 2: the object is confirmed at the key of the session, or the call is decided. */
type StorageStepOutcome =
  | { kind: 'object-confirmed' }
  | { kind: 'decided'; result: UploadCompletionResult };

/** Why the conference of step 2 failed (G-04). */
type ConferenceFailure = 'incomplete' | 'part-mismatch';

/**
 * Completion of the upload by protocol P2 (TD-02, TD-12; G-01 to G-04): claim under the lock of
 * the video, conference and Complete in the storage outside any transaction, finalization of the
 * session and the video in one transaction, and the publication of generation 1 after the commit.
 * Losing the claim token never produces a success by itself: a 200 is only given after the
 * database shows that the completion of this session happened.
 */
@Injectable()
export class UploadCompletionService {
  private readonly logger = new Logger(UploadCompletionService.name);

  constructor(
    private readonly uploadSessionAccess: UploadSessionAccessService,
    private readonly completions: UploadCompletionRepository,
    private readonly uploadParts: UploadPartsService,
    private readonly storage: StorageService,
    private readonly dispatcher: VideoJobDispatcherService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /** POST completion ("API Contracts"). */
  async completeUpload(
    userId: string,
    publicId: string,
    sessionId: string,
  ): Promise<UploadCompletionResult> {
    const { video, session: owned } =
      await this.uploadSessionAccess.getOwnedSession(
        userId,
        publicId,
        sessionId,
      );
    const answer = (status: VideoStatus, transitioned: boolean) => ({
      transitioned,
      body: { publicId: video.public_id, status },
    });

    // Step 1 (T1): claim under the lock of the video.
    const claim = await this.completions.claimCompletion({
      videoId: video.id,
      sessionId: owned.id,
      claimTtlSeconds: this.config.uploadSessionClaimTtlSeconds,
    });
    if (claim.outcome === 'completed') {
      return answer(claim.video.status, false);
    }
    if (claim.outcome === 'refused') {
      throw this.refusal(claim.reason, owned);
    }
    if (claim.resumed) {
      this.logger.warn(
        `Expired completion claim of session ${claim.session.id} taken over (G-02)`,
      );
    }
    return this.completeClaimed(
      claim.session,
      claim.claimToken,
      video.public_id,
    );
  }

  /**
   * The sweep resumes an expired completion from step 2 of P2 (SI-03.24; G-02, F-01): the claim
   * only takes over a `completing` session whose claim expired, and the steps are the same as the
   * route's, including the re-read of step 5. The deadline of the session itself is not checked:
   * a `completing` session is resumed, never aborted for having expired.
   */
  async resumeExpiredCompletion(
    videoId: string,
    publicId: string,
    sessionId: string,
  ): Promise<CompletionResumeOutcome> {
    const claim = await this.completions.claimCompletion({
      videoId,
      sessionId,
      claimTtlSeconds: this.config.uploadSessionClaimTtlSeconds,
      resumeOnly: true,
    });
    if (claim.outcome === 'completed') {
      return { outcome: 'not-resumed', reason: 'completed' };
    }
    if (claim.outcome === 'refused') {
      return { outcome: 'not-resumed', reason: claim.reason };
    }
    this.logger.warn(
      `Expired completion claim of session ${claim.session.id} taken over by the sweep (G-02)`,
    );
    try {
      const result = await this.completeClaimed(
        claim.session,
        claim.claimToken,
        publicId,
      );
      return result.transitioned
        ? { outcome: 'finalized' }
        : { outcome: 'completed-elsewhere' };
    } catch (error) {
      if (error instanceof DomainException) {
        return { outcome: 'decided', errorCode: error.errorCode };
      }
      throw error;
    }
  }

  /** Steps 2 to 5 of P2 for a session claimed in step 1 with `claimToken`. */
  private async completeClaimed(
    session: UploadSession,
    claimToken: string,
    publicId: string,
  ): Promise<UploadCompletionResult> {
    // Step 2: conference and Complete, outside any transaction.
    const storageStep = await this.completeInStorage(
      session,
      claimToken,
      publicId,
    );
    if (storageStep.kind === 'decided') {
      return storageStep.result;
    }

    // Step 3 (T2): session and video in one transaction.
    const finalization = await this.completions.finalizeCompletion({
      videoId: session.video_id,
      sessionId: session.id,
      claimToken,
      objectKey: session.object_key,
      actionTtlSeconds: this.config.processingJobActionTtlSeconds,
    });
    if (!finalization.finalized) {
      return this.reread(session.id, publicId);
    }

    // Step 4: R2 and R3 after the commit; a failure keeps the 202 (F-02).
    await this.publishFirstGeneration(
      session.video_id,
      finalization.run,
      finalization.pendingJobToken,
    );
    return {
      transitioned: true,
      body: { publicId, status: VideoStatus.PROCESSING },
    };
  }

  /**
   * Step 2 of P2. The paginated `ListParts` is compared with the registry: every part of the plan
   * must be `confirmed` and no part may be listed beyond the plan (G-04); otherwise the claim is
   * reverted. The Complete is built from the registry. A NoSuchUpload, from the listing or from
   * the Complete, is resolved by `HeadObject` at the key of the session (AMB-4).
   */
  private async completeInStorage(
    session: UploadSession,
    claimToken: string,
    publicId: string,
  ): Promise<StorageStepOutcome> {
    const uploadId = session.upload_id;
    if (!uploadId) {
      throw new Error(`Completing session ${session.id} has no upload_id`);
    }
    const classification = await this.uploadParts.classifyParts(session);
    if (classification.status === 'found') {
      const failure = conferenceFailure(classification);
      if (failure) {
        return this.revert(session, claimToken, failure, publicId);
      }
      const completed = await this.storage.completeMultipartUpload(
        session.object_key,
        uploadId,
        completedParts(classification.parts),
      );
      if (completed.status === 'completed') {
        return { kind: 'object-confirmed' };
      }
    }
    return this.confirmCompletedObject(session, claimToken, publicId);
  }

  /**
   * NoSuchUpload: the Complete already happened (an earlier completer, T-01) or the upload is
   * gone. Only an object of the declared size at the key of this session confirms it; otherwise
   * the session goes `completing → aborted` by the token and the answer is 410.
   */
  private async confirmCompletedObject(
    session: UploadSession,
    claimToken: string,
    publicId: string,
  ): Promise<StorageStepOutcome> {
    const head = await this.storage.headObject(session.object_key);
    if (head.status === 'found' && head.size === session.size_bytes) {
      return { kind: 'object-confirmed' };
    }
    const aborted = await this.completions.abortCompletion(
      session.video_id,
      session.id,
      claimToken,
    );
    if (!aborted) {
      return {
        kind: 'decided',
        result: await this.reread(session.id, publicId),
      };
    }
    throw new UploadSessionExpiredException();
  }

  private async revert(
    session: UploadSession,
    claimToken: string,
    failure: ConferenceFailure,
    publicId: string,
  ): Promise<StorageStepOutcome> {
    const reverted = await this.completions.revertCompletion(
      session.video_id,
      session.id,
      claimToken,
    );
    if (!reverted) {
      return {
        kind: 'decided',
        result: await this.reread(session.id, publicId),
      };
    }
    throw failure === 'incomplete'
      ? new UploadIncompleteException()
      : new UploadPartMismatchException();
  }

  /**
   * Step 4 of P2: R2 (`add` of `video-{videoId}-{run}-1`) and then R3 by the token. Any failure
   * of the publication leaves the `publish` action recorded and keeps the 202: the reconciliation
   * takes it over when its deadline passes, reusing generation 1 (F-02). Converting the failure
   * into that outcome is the protocol, so the errors are logged and not thrown.
   */
  private async publishFirstGeneration(
    videoId: string,
    run: number,
    pendingJobToken: string,
  ): Promise<void> {
    let published: Awaited<ReturnType<VideoJobDispatcherService['publish']>>;
    try {
      published = await withTimeout(
        this.dispatcher.publish({ videoId, run, dispatch: FIRST_JOB_DISPATCH }),
        VIDEO_JOB_PUBLISH_TIMEOUT_MS,
        'add of the first generation',
      );
    } catch (error) {
      this.logger.warn(
        `Publication of the job of video ${videoId} (run ${run}) failed; the publish action stays pending for the reconciliation (F-02)`,
        errorMessage(error),
      );
      return;
    }
    if (!published.stored) {
      this.logger.warn(
        `Job ${published.jobId} was not found after its add; the publish action stays pending`,
      );
      return;
    }
    try {
      const confirmed = await this.dispatcher.confirm({
        videoId,
        dispatch: FIRST_JOB_DISPATCH,
        token: pendingJobToken,
      });
      if (!confirmed) {
        this.logger.warn(
          `Publish action of video ${videoId} was taken over before its confirmation`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Confirmation of job ${published.jobId} failed; the reconciliation confirms it (P5)`,
        errorMessage(error),
      );
    }
  }

  /**
   * Step 5 of P2: after zero rows in T2, in the revert or in the abort, the answer comes from the
   * session and the video as they are now. A 200 requires the completion of this session to be
   * recorded; losing the token alone is never a success.
   */
  private async reread(
    sessionId: string,
    publicId: string,
  ): Promise<UploadCompletionResult> {
    const state = await this.completions.readCompletionState(sessionId);
    if (!state) {
      throw new UploadSessionNotFoundException();
    }
    const { session, video, expired } = state;
    if (session.status === UploadSessionStatus.COMPLETED) {
      if (isCompletionOf(video, session)) {
        return {
          transitioned: false,
          body: { publicId, status: video.status },
        };
      }
      this.logInconsistency(session);
      throw new UploadSessionNotActiveException();
    }
    if (video.current_upload_session_id !== session.id) {
      throw new UploadSessionNotActiveException();
    }
    switch (session.status) {
      case UploadSessionStatus.COMPLETING:
        throw new UploadSessionCompletingException();
      case UploadSessionStatus.ACTIVE:
        throw new UploadCompletionInterruptedException();
      case UploadSessionStatus.ABORTING:
      case UploadSessionStatus.ABORTED:
        throw expired
          ? new UploadSessionExpiredException()
          : new UploadSessionNotActiveException();
      default:
        throw new UploadSessionNotActiveException();
    }
  }

  private refusal(reason: CompletionRefusal, session: UploadSession): Error {
    switch (reason) {
      case 'video-not-found':
        return new VideoNotFoundException();
      case 'session-not-found':
        return new UploadSessionNotFoundException();
      case 'completing':
        return new UploadSessionCompletingException();
      case 'expired':
        return new UploadSessionExpiredException();
      case 'file-mismatch':
        return new UploadFileMismatchException();
      case 'inconsistent':
        this.logInconsistency(session);
        return new UploadSessionNotActiveException();
      case 'not-current':
      case 'not-active':
      case 'not-completing':
        return new UploadSessionNotActiveException();
    }
  }

  /** Does not happen by the protocol, because T2 is atomic (P2, step 5). */
  private logInconsistency(session: UploadSession): void {
    this.logger.error(
      `Session ${session.id} is completed but video ${session.video_id} does not record it as its original`,
    );
  }
}

/**
 * G-04 on the classification of the parts. A part divergent from the registry, present without
 * any registry, or listed beyond the plan is a mismatch; a part missing from the storage or
 * without a registered ETag leaves the upload incomplete. A mismatch is reported first, because
 * it is the stronger statement about the storage.
 */
function conferenceFailure(
  classification: Extract<PartClassification, { status: 'found' }>,
): ConferenceFailure | null {
  const mismatch =
    classification.extraPartNumbers.length > 0 ||
    classification.parts.some(
      (part) =>
        part.state === UploadPartState.DIVERGENT ||
        (part.state === UploadPartState.UNREGISTERED &&
          part.checksumSha256 === null),
    );
  if (mismatch) {
    return 'part-mismatch';
  }
  const incomplete = classification.parts.some(
    (part) => part.state !== UploadPartState.CONFIRMED,
  );
  return incomplete ? 'incomplete' : null;
}

/** The Complete list from the registry (PartNumber, ETag and ChecksumSHA256), never from the listing. */
function completedParts(parts: ClassifiedPart[]): CompletedPartInput[] {
  return parts.map((part) => {
    if (part.etag === null || part.checksumSha256 === null) {
      throw new Error(
        `Part ${part.partNumber} is confirmed without a registry`,
      );
    }
    return {
      partNumber: part.partNumber,
      etag: part.etag,
      checksumSha256: part.checksumSha256,
    };
  });
}

/** Rejects when `promise` takes longer than `timeoutMs`; the promise itself is not cancelled. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
