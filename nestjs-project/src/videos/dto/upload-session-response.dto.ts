import { ApiProperty } from '@nestjs/swagger';
import { UploadSessionStatus } from '../entities/upload-session.entity';
import { UploadPartState } from '../upload-part-classification';
import { UPLOAD_CHECKSUM_ALGORITHM } from '../videos.constants';

/** A part of the plan, classified against the `ListParts` of the storage (TD-02; G-04). */
export class UploadSessionPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    enum: UploadPartState,
    enumName: 'UploadPartState',
    description:
      'confirmed: present with the registered ETag, checksum and size; missing: absent from the storage; divergent: present but different from the registry; unregistered: present without a registered ETag',
  })
  state: UploadPartState;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Registered SHA-256 of the part, base64 with padding; null when the part was never signed',
  })
  checksumSha256: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Registered ETag of the part',
  })
  etag: string | null;
}

/** Body of `GET /videos/:publicId/upload-sessions/:sessionId` (200), base of the resumption. */
export class UploadSessionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: UploadSessionStatus, enumName: 'UploadSessionStatus' })
  status: UploadSessionStatus;

  @ApiProperty({
    description: 'true when the session is active and its expiresAt has passed',
  })
  expired: boolean;

  @ApiProperty({
    description:
      'The file check failed, or a part was signed again with another checksum; the session no longer signs parts',
  })
  fileMismatch: boolean;

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

  @ApiProperty({
    type: [UploadSessionPartDto],
    description:
      'One entry per part of the plan, from 1 to partCount, only for an active session; empty in the other states',
  })
  parts: UploadSessionPartDto[];
}
