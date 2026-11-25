import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

/**
 * Body of `POST …/completion`: 202 when this call moved the video to `processing`, 200 with the
 * current state of the video when the session was already completed.
 */
export class UploadCompletionResponseDto {
  @ApiProperty({
    example: 'dQw4w9WgXcQ',
    description: '11 base64url characters',
  })
  publicId: string;

  @ApiProperty({
    enum: [VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.ERROR],
    description:
      'Current state of the video; always processing in the 202 answer',
  })
  status: VideoStatus;
}
