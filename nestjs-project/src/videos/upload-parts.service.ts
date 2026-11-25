import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type { FileVerificationsResponseDto } from './dto/file-verifications-response.dto';
import type {
  PartUrlsResponseDto,
  SignedPartDto,
} from './dto/part-urls-response.dto';
import {
  type UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import {
  InvalidPartNumberException,
  UploadFileMismatchException,
  UploadPartNotSignedException,
  UploadSessionExpiredException,
  UploadSessionNotActiveException,
  UploadVerificationIncompleteException,
} from './exceptions/video.exceptions';
import {
  type ClassifiedPart,
  classifyPlanParts,
  listedOutsidePlan,
  UploadPartState,
} from './upload-part-classification';
import { expectedPartSize } from './upload-plan';
import {
  type PartEtag,
  UploadPartsRepository,
} from './upload-parts.repository';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import {
  FILE_VERIFICATION_MATCH,
  LIST_PARTS_PAGE_SIZE,
} from './videos.constants';

export interface PartToSign {
  partNumber: number;
  checksumSha256: string;
}

export interface PartUrlsRequest {
  parts?: PartToSign[];
  completedParts?: PartEtag[];
}

/** Checksum of a part recalculated from the file selected again on the resumption. */
export interface RecalculatedPartChecksum {
  partNumber: number;
  checksumSha256: string;
}

/** Parts the storage already holds: the file verification must cover all of them (Q-10). */
const VERIFICATION_REQUIRED_STATES: ReadonlySet<UploadPartState> = new Set([
  UploadPartState.CONFIRMED,
  UploadPartState.UNREGISTERED,
]);

/**
 * Classification of the parts of the plan, with the part numbers listed beyond the plan, or the
 * storage no longer knows the upload of the session (F-10), with the `uploadId` that was listed.
 */
export type PartClassification =
  | { status: 'found'; parts: ClassifiedPart[]; extraPartNumbers: number[] }
  | { status: 'no-such-upload'; uploadId: string };

/**
 * Signing of the parts and registry of their ETags (TD-02, TD-03; V-09). The API never carries
 * bytes: it records the declared checksum of each part, signs the PUT with the exact size and the
 * checksum, and records the ETag that the client reports after the PUT.
 */
@Injectable()
export class UploadPartsService {
  constructor(
    private readonly uploadSessionAccess: UploadSessionAccessService,
    private readonly uploadSessions: UploadSessionsRepository,
    private readonly uploadParts: UploadPartsRepository,
    private readonly storage: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /**
   * POST part-urls: registers the ETags of `completedParts` and signs `parts`, for the owner of a
   * current, active, unexpired and unblocked session. The session and every part number of both
   * arrays are checked before anything is written; the ETags, which refer to parts signed by
   * earlier requests, are recorded before the new parts are signed.
   */
  async requestPartUrls(
    userId: string,
    publicId: string,
    sessionId: string,
    request: PartUrlsRequest,
  ): Promise<PartUrlsResponseDto> {
    const { video, session, expired } =
      await this.uploadSessionAccess.getOwnedSession(
        userId,
        publicId,
        sessionId,
      );
    this.assertSignable(
      session,
      video.current_upload_session_id === session.id,
      expired,
    );
    const parts = request.parts ?? [];
    const completedParts = request.completedParts ?? [];
    this.assertPartNumbers(session, parts);
    this.assertPartNumbers(session, completedParts);

    const registeredParts = await this.registerEtags(session, completedParts);
    const signedParts = await this.signParts(session, parts);
    return { parts: signedParts, registeredParts };
  }

  /**
   * POST file-verifications: on the resumption, checks that the file selected again is the same,
   * by the checksums recalculated for the parts the storage already holds (TD-02; Q-10; F-11;
   * G-11). The session must be current, active, unexpired and not blocked, as for the signing; a
   * blocked session stays blocked, whatever the request carries. The parts are classified against
   * the `ListParts` (SI-03.14) and the request is checked before anything is written:
   * - every part must be in the plan and have a registered checksum, else INVALID_PART_NUMBER;
   * - every `confirmed` and `unregistered` part must be in the request, else
   *   UPLOAD_VERIFICATION_INCOMPLETE. Other parts with a registered checksum (`missing`,
   *   `divergent`) may be included and are checked too.
   * A recalculated checksum different from the registered one blocks the session
   * (`file_mismatch_at`, F-11) before the UPLOAD_FILE_MISMATCH answer. The registered checksums are
   * kept, and only an explicit restart continues the upload.
   */
  async verifyFile(
    userId: string,
    publicId: string,
    sessionId: string,
    parts: RecalculatedPartChecksum[],
  ): Promise<FileVerificationsResponseDto> {
    const { video, session, expired } =
      await this.uploadSessionAccess.getOwnedSession(
        userId,
        publicId,
        sessionId,
      );
    this.assertSignable(
      session,
      video.current_upload_session_id === session.id,
      expired,
    );
    this.assertPartNumbers(session, parts);

    const classification = await this.classifyParts(session);
    if (classification.status === 'no-such-upload') {
      // F-10. The session is not changed here: the GET of the session claims it for abort (SI-03.14),
      // and the restart replaces it (SI-03.18).
      throw new UploadSessionExpiredException();
    }
    const registered = new Map(
      classification.parts.map((part) => [
        part.partNumber,
        part.checksumSha256,
      ]),
    );
    if (
      parts.some((part) => (registered.get(part.partNumber) ?? null) === null)
    ) {
      throw new InvalidPartNumberException();
    }
    const declared = new Set(parts.map((part) => part.partNumber));
    const incomplete = classification.parts.some(
      (part) =>
        VERIFICATION_REQUIRED_STATES.has(part.state) &&
        !declared.has(part.partNumber),
    );
    if (incomplete) {
      throw new UploadVerificationIncompleteException();
    }
    const mismatch = parts.some(
      (part) => registered.get(part.partNumber) !== part.checksumSha256,
    );
    if (mismatch) {
      // Recorded before the error answer, in its own statement, so the block persists.
      await this.uploadSessions.markFileMismatch(session.id);
      throw new UploadFileMismatchException();
    }
    return { result: FILE_VERIFICATION_MATCH, verifiedParts: parts.length };
  }

  /**
   * Records each declared checksum once and signs the PUT of each part. A part signed again with
   * the same checksum gets a new URL; with another checksum, the original is kept, the session is
   * blocked (`file_mismatch_at`, F-11) and the answer is UPLOAD_FILE_MISMATCH.
   */
  async signParts(
    session: UploadSession,
    parts: PartToSign[],
  ): Promise<SignedPartDto[]> {
    if (parts.length === 0) {
      return [];
    }
    const declared = parts.map((part) => ({
      partNumber: part.partNumber,
      checksumSha256: part.checksumSha256,
      expectedSize: expectedPartSize(
        session.size_bytes,
        session.part_size,
        part.partNumber,
      ),
    }));
    const stored = await this.uploadParts.registerChecksums(
      session.id,
      declared,
    );
    const mismatch = declared.some(
      (part) => stored.get(part.partNumber) !== part.checksumSha256,
    );
    if (mismatch) {
      // Recorded before the error answer, in its own statement, so the block persists.
      await this.uploadSessions.markFileMismatch(session.id);
      throw new UploadFileMismatchException();
    }

    const uploadId = session.upload_id;
    if (!uploadId) {
      throw new Error(`Active session ${session.id} has no upload_id`);
    }
    const signed: SignedPartDto[] = [];
    for (const part of declared) {
      const url = await this.storage.presignUploadPart({
        key: session.object_key,
        uploadId,
        partNumber: part.partNumber,
        expectedSize: part.expectedSize,
        checksumSha256: part.checksumSha256,
        expiresInSeconds: this.config.uploadPartUrlTtlSeconds,
      });
      signed.push({ partNumber: part.partNumber, ...url });
    }
    return signed;
  }

  /**
   * Classifies each part of the plan by comparing the paginated `ListParts` with the registry
   * (TD-02; G-04): `confirmed`, `missing`, `divergent` or `unregistered`. The storage is listed
   * first, so a vanished upload is reported without reading the registry. A transient storage
   * failure is thrown as STORAGE_UNAVAILABLE and is never taken for a vanished upload.
   */
  async classifyParts(
    session: UploadSession,
    options: { pageSize?: number } = {},
  ): Promise<PartClassification> {
    const uploadId = session.upload_id;
    if (!uploadId) {
      throw new Error(`Session ${session.id} has no upload_id to list`);
    }
    const listed = await this.storage.listParts(session.object_key, uploadId, {
      pageSize: options.pageSize ?? LIST_PARTS_PAGE_SIZE,
    });
    if (listed.status === 'no-such-upload') {
      return { status: 'no-such-upload', uploadId };
    }
    const registered = await this.uploadParts.findBySession(session.id);
    return {
      status: 'found',
      parts: classifyPlanParts(session.part_count, registered, listed.parts),
      extraPartNumbers: listedOutsidePlan(session.part_count, listed.parts),
    };
  }

  /**
   * Records the ETags reported after the PUTs (G-04), only for parts with a registered checksum:
   * otherwise UPLOAD_PART_NOT_SIGNED, and nothing of the batch is recorded.
   */
  async registerEtags(
    session: UploadSession,
    completedParts: PartEtag[],
  ): Promise<number[]> {
    if (completedParts.length === 0) {
      return [];
    }
    const registered = await this.uploadParts.registerEtags(
      session.id,
      completedParts,
    );
    if (!registered) {
      throw new UploadPartNotSignedException();
    }
    return completedParts.map((part) => part.partNumber).sort((a, b) => a - b);
  }

  /** Current session of the video, `active`, unexpired and not blocked by a file mismatch. */
  private assertSignable(
    session: UploadSession,
    isCurrent: boolean,
    expired: boolean,
  ): void {
    if (!isCurrent || session.status !== UploadSessionStatus.ACTIVE) {
      throw new UploadSessionNotActiveException();
    }
    if (expired) {
      throw new UploadSessionExpiredException();
    }
    if (session.file_mismatch_at !== null) {
      throw new UploadFileMismatchException();
    }
  }

  /** Every part number within `1..partCount` and not repeated in its array. */
  private assertPartNumbers(
    session: UploadSession,
    parts: { partNumber: number }[],
  ): void {
    const seen = new Set<number>();
    for (const { partNumber } of parts) {
      if (partNumber > session.part_count || seen.has(partNumber)) {
        throw new InvalidPartNumberException();
      }
      seen.add(partNumber);
    }
  }
}
