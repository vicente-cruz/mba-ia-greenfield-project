import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { attachmentDisposition } from './content-disposition';
import type { DownloadUrlResponseDto } from './dto/download-url-response.dto';
import type { PlaybackUrlResponseDto } from './dto/playback-url-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { UploadSession } from './entities/upload-session.entity';
import { type Video, VideoStatus } from './entities/video.entity';
import { VideoNotReadyException } from './exceptions/video.exceptions';
import { UploadSessionAccessService } from './upload-session-access.service';

/** Videos as their owner sees them (TD-04, TD-05). */
@Injectable()
export class VideosService {
  constructor(
    private readonly uploadSessionAccess: UploadSessionAccessService,
    @InjectRepository(UploadSession)
    private readonly uploadSessions: Repository<UploadSession>,
    private readonly storage: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /**
   * GET /videos/:publicId: the state, the metadata and the current session of a video of the
   * user's channel. A malformed `publicId`, a missing video and a video of another channel answer
   * VIDEO_NOT_FOUND, without telling them apart (Q-02). Reads without locking.
   */
  async getOwnVideo(
    userId: string,
    publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.uploadSessionAccess.getOwnedVideo(
      userId,
      publicId,
    );
    const session = video.current_upload_session_id
      ? await this.uploadSessions.findOne({
          select: { id: true, status: true, expires_at: true },
          where: { id: video.current_upload_session_id },
        })
      : null;
    return toVideoResponse(video, session);
  }

  /**
   * GET /videos/:publicId/playback-url: a presigned GET of the original on the public endpoint of
   * the storage, valid for PLAYBACK_URL_TTL_SECONDS, with the content type of the video signed as
   * the response type (TD-13, TD-14). The storage serves the bytes and the Range requests; the API
   * only authorizes. Only the owner gets it (VIDEO_NOT_FOUND otherwise, as in `getOwnVideo`), and
   * only for a video in `ready` (VIDEO_NOT_READY otherwise).
   */
  async getPlaybackUrl(
    userId: string,
    publicId: string,
  ): Promise<PlaybackUrlResponseDto> {
    const { video, originalKey } = await this.getOwnedReadyOriginal(
      userId,
      publicId,
    );
    const signed = await this.storage.presignGet({
      key: originalKey,
      audience: 'browser',
      expiresInSeconds: this.config.playbackUrlTtlSeconds,
      responseContentType: video.content_type,
    });
    return {
      url: signed.url,
      contentType: video.content_type,
      expiresAt: signed.expiresAt,
    };
  }

  /**
   * GET /videos/:publicId/download-url: a presigned GET of the original on the public endpoint of
   * the storage, valid for DOWNLOAD_URL_TTL_SECONDS, answered as an attachment named after
   * `original_filename` (`filename*` in UTF-8, RFC 6266). The same rules of owner and state as
   * the playback URL (TD-14).
   */
  async getDownloadUrl(
    userId: string,
    publicId: string,
  ): Promise<DownloadUrlResponseDto> {
    const { video, originalKey } = await this.getOwnedReadyOriginal(
      userId,
      publicId,
    );
    const signed = await this.storage.presignGet({
      key: originalKey,
      audience: 'browser',
      expiresInSeconds: this.config.downloadUrlTtlSeconds,
      responseContentDisposition: attachmentDisposition(
        video.original_filename,
      ),
    });
    return { url: signed.url, expiresAt: signed.expiresAt };
  }

  /**
   * The video `publicId` of the user's channel, in `ready`, with its original: VIDEO_NOT_FOUND
   * for anyone but the owner (as in `getOwnVideo`), VIDEO_NOT_READY for any other state.
   */
  private async getOwnedReadyOriginal(
    userId: string,
    publicId: string,
  ): Promise<{ video: Video; originalKey: string }> {
    const video = await this.uploadSessionAccess.getOwnedVideo(
      userId,
      publicId,
    );
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    if (!video.original_key) {
      // P2 records `original_key` before the processing starts; `ready` without it is corrupt.
      throw new Error(`Video ${video.id} is ready without an original_key`);
    }
    return { video, originalKey: video.original_key };
  }
}

function toVideoResponse(
  video: Video,
  session: Pick<UploadSession, 'id' | 'status' | 'expires_at'> | null,
): VideoResponseDto {
  return {
    publicId: video.public_id,
    status: video.status,
    originalFilename: video.original_filename,
    contentType: video.content_type,
    sizeBytes: video.size_bytes,
    // `numeric` comes from the driver as a string (SI-03.10).
    durationSeconds:
      video.duration_seconds === null ? null : Number(video.duration_seconds),
    width: video.width,
    height: video.height,
    videoCodec: video.video_codec,
    audioCodec: video.audio_codec,
    hasThumbnail: video.thumbnail_key !== null,
    errorCode: video.error_code,
    errorMessage: video.error_message,
    uploadSession: session
      ? {
          id: session.id,
          status: session.status,
          expiresAt: session.expires_at,
        }
      : null,
    createdAt: video.created_at,
    updatedAt: video.updated_at,
  };
}
