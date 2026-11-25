import { ApiProperty } from '@nestjs/swagger';

/**
 * Body of `GET /videos/:publicId/playback-url` (200): a short-lived presigned GET of the original,
 * played by progressive download with partial requests (TD-13, TD-14). `contentType` is part of
 * the contract so the delivery format can evolve without breaking the client.
 */
export class PlaybackUrlResponseDto {
  @ApiProperty({
    format: 'uri',
    description:
      'Presigned GET of the original on the public storage endpoint; it answers 206 Partial Content with Content-Range to Range requests',
  })
  url: string;

  @ApiProperty({
    example: 'video/mp4',
    description: 'Content type of the video, signed as the response type',
  })
  contentType: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Expiry of the URL: emission + PLAYBACK_URL_TTL_SECONDS',
  })
  expiresAt: Date;
}
