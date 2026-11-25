import { ApiProperty } from '@nestjs/swagger';
import { FILE_VERIFICATION_MATCH } from '../videos.constants';

/** Body of `POST …/file-verifications` (200): the file selected again is the same. */
export class FileVerificationsResponseDto {
  @ApiProperty({ enum: [FILE_VERIFICATION_MATCH] })
  result: typeof FILE_VERIFICATION_MATCH;

  @ApiProperty({
    example: 2,
    description:
      'Number of parts whose recalculated checksum matched the registered one; 0 when no part was received',
  })
  verifiedParts: number;
}
