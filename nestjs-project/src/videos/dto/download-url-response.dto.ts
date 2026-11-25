import { ApiProperty } from '@nestjs/swagger';

/**
 * Body of `GET /videos/:publicId/download-url` (200): a short-lived presigned GET of the original
 * as an attachment, downloaded straight from the storage (TD-14).
 */
export class DownloadUrlResponseDto {
  @ApiProperty({
    format: 'uri',
    description:
      'Presigned GET of the original on the public storage endpoint, answered with Content-Disposition: attachment and the original file name in filename* (UTF-8, RFC 6266)',
  })
  url: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Expiry of the URL: emission + DOWNLOAD_URL_TTL_SECONDS',
  })
  expiresAt: Date;
}
