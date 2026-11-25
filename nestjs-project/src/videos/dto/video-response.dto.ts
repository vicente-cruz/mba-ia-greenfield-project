import { ApiProperty } from '@nestjs/swagger';
import { UploadSessionStatus } from '../entities/upload-session.entity';
import { VideoStatus } from '../entities/video.entity';
import { VIDEO_ERROR_CODES } from '../exceptions/video.exceptions';

/** The current upload session of the video, as the polling needs it. */
export class VideoCurrentUploadSessionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: UploadSessionStatus, enumName: 'UploadSessionStatus' })
  status: UploadSessionStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Absolute expiry of the session',
  })
  expiresAt: Date;
}

/**
 * Body of `GET /videos/:publicId` (200): the state of the video, its metadata and its current
 * session, for the owner's polling (Q-09). Only the fields of "API Contracts" are exposed; the
 * storage keys and the fields of the processing protocol stay internal.
 */
export class VideoResponseDto {
  @ApiProperty({
    example: 'dQw4w9WgXcQ',
    description: '11 base64url characters',
  })
  publicId: string;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty({ example: 'clip.mp4' })
  originalFilename: string;

  @ApiProperty({ example: 'video/mp4' })
  contentType: string;

  @ApiProperty({ type: 'integer', example: 1048576 })
  sizeBytes: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4.04,
    description: 'Duration in seconds, filled by the processing',
  })
  durationSeconds: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1280 })
  width: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 720 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audioCodec: string | null;

  @ApiProperty({ description: 'The processing produced a thumbnail' })
  hasThumbnail: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: Object.values(VIDEO_ERROR_CODES),
    description: 'Filled when the video is in error',
  })
  errorCode: string | null;

  @ApiProperty({ type: String, nullable: true })
  errorMessage: string | null;

  @ApiProperty({
    type: VideoCurrentUploadSessionDto,
    nullable: true,
    description: 'Current upload session of the video',
  })
  uploadSession: VideoCurrentUploadSessionDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
