import { ApiProperty } from '@nestjs/swagger';
import { CHECKSUM_SHA256_HEADER } from '../../storage/storage.constants';

/**
 * The only header the JavaScript sets on the PUT. `Content-Length` is not here: it is a header
 * forbidden to scripts, set by the browser from the body, and it stays signed in the URL (V-02,
 * V-08).
 */
export class PartUploadHeadersDto {
  @ApiProperty({
    name: CHECKSUM_SHA256_HEADER,
    description: 'Declared SHA-256 of the part, base64 with padding',
  })
  [CHECKSUM_SHA256_HEADER]: string;
}

export class SignedPartDto {
  @ApiProperty({ example: 150 })
  partNumber: number;

  @ApiProperty({
    description: 'Presigned UploadPart URL on the public storage endpoint',
  })
  url: string;

  @ApiProperty({ enum: ['PUT'] })
  method: 'PUT';

  @ApiProperty({
    example: 779264,
    description:
      'Exact number of bytes of the body, sent as a Blob or an ArrayBuffer; any other size is refused by the storage',
  })
  expectedSize: number;

  @ApiProperty({ type: PartUploadHeadersDto })
  headers: PartUploadHeadersDto;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Signing time plus UPLOAD_PART_URL_TTL_SECONDS',
  })
  expiresAt: Date;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [SignedPartDto] })
  parts: SignedPartDto[];

  @ApiProperty({
    type: [Number],
    example: [1, 2],
    description: 'Parts whose ETag was registered by this request',
  })
  registeredParts: number[];
}
