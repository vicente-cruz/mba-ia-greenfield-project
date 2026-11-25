import { Injectable } from '@nestjs/common';
import type { Video } from './entities/video.entity';
import {
  UploadSessionNotFoundException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { PUBLIC_ID } from './public-id';
import {
  type OwnedUploadSession,
  UploadSessionsRepository,
} from './upload-sessions.repository';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Owner access to the upload sessions, shared by the routes of the sessions (SI-03.13 to
 * SI-03.18). It is its own provider so the services of the sessions and of the parts can both
 * depend on it without depending on each other.
 */
@Injectable()
export class UploadSessionAccessService {
  constructor(private readonly uploadSessions: UploadSessionsRepository) {}

  /**
   * The video `publicId`, for its owner only (Authorization Matrix), for the routes addressed by
   * the video, such as the restart (SI-03.18). A malformed `publicId`, a missing video or a video
   * of another channel answer VIDEO_NOT_FOUND, without telling them apart. Reads without locking.
   */
  async getOwnedVideo(userId: string, publicId: string): Promise<Video> {
    if (!PUBLIC_ID.PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.uploadSessions.findOwnedVideo(userId, publicId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /**
   * The session `sessionId` of the video `publicId`, for its owner only (Authorization Matrix).
   * A malformed `publicId`, a missing video or a video of another channel answer VIDEO_NOT_FOUND,
   * without telling them apart; a malformed, missing or foreign `sessionId` answers
   * UPLOAD_SESSION_NOT_FOUND ("Validation Rules"). Reads without locking.
   */
  async getOwnedSession(
    userId: string,
    publicId: string,
    sessionId: string,
  ): Promise<OwnedUploadSession> {
    if (!PUBLIC_ID.PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    if (!UUID_PATTERN.test(sessionId)) {
      throw new UploadSessionNotFoundException();
    }
    const lookup = await this.uploadSessions.findOwnedSession(
      userId,
      publicId,
      sessionId.toLowerCase(),
    );
    if (lookup.found === 'none') {
      throw new VideoNotFoundException();
    }
    if (lookup.found === 'video') {
      throw new UploadSessionNotFoundException();
    }
    return {
      video: lookup.video,
      session: lookup.session,
      expired: lookup.expired,
    };
  }
}
