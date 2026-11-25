import { ApiProperty } from '@nestjs/swagger';
import { UploadSessionStatus } from '../entities/upload-session.entity';
import { VideoStatus } from '../entities/video.entity';
import { UPLOAD_CHECKSUM_ALGORITHM } from '../videos.constants';

/** Session just activated by P1 (T2), ready to sign parts. */
export class StartedUploadSessionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: [UploadSessionStatus.ACTIVE] })
  status: UploadSessionStatus.ACTIVE;

  @ApiProperty({
    example: 67108864,
    description: 'Size in bytes of every part except the last',
  })
  partSize: number;

  @ApiProperty({ example: 150 })
  partCount: number;

  @ApiProperty({ enum: [UPLOAD_CHECKSUM_ALGORITHM] })
  checksumAlgorithm: typeof UPLOAD_CHECKSUM_ALGORITHM;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Absolute expiry of the session',
  })
  expiresAt: Date;
}

/**
 * Body of `POST /videos` (201), also returned by the restart of SI-03.18. The video is addressed
 * only by `publicId`; its internal UUID is never exposed.
 */
export class VideoUploadSessionResponseDto {
  @ApiProperty({
    example: 'dQw4w9WgXcQ',
    description: '11 base64url characters',
  })
  publicId: string;

  @ApiProperty({ enum: [VideoStatus.DRAFT] })
  status: VideoStatus.DRAFT;

  @ApiProperty({ type: StartedUploadSessionDto })
  uploadSession: StartedUploadSessionDto;
}
