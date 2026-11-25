import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { CHECKSUM_SHA256_FORMAT } from '../videos.constants';

export const FILE_VERIFICATIONS_LIMITS = {
  /** Every part of the largest upload: 150 parts of 10,000,000,000 bytes. */
  MAX_PARTS: 150,
} as const;

export class RecalculatedPartChecksumDto {
  /** Number of the part, from 1. The plan (`partCount`) and the registered checksum are checked by the service (400 INVALID_PART_NUMBER). */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** SHA-256 recalculated from the exact bytes of the part of the file selected again, in base64 with padding (44 characters). */
  @IsString()
  @Matches(CHECKSUM_SHA256_FORMAT.PATTERN, {
    message: CHECKSUM_SHA256_FORMAT.MESSAGE,
  })
  checksumSha256: string;
}

/**
 * Checksums recalculated on the resumption, after the file is selected again (Q-10). Every item
 * must be an object: `ValidateNested` alone accepts a nested array (`[[]]`, `[[{…}]]`) as an item
 * (SI-03.13). A repeated part number is a validation error; the coverage rules, which depend on
 * the session, are applied by the service.
 */
export class FileVerificationsRequestDto {
  /** Parts already received by the storage, up to 150, each once. An empty list is valid when no part was received. */
  @IsArray()
  @ArrayMaxSize(FILE_VERIFICATIONS_LIMITS.MAX_PARTS)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => RecalculatedPartChecksumDto)
  @ArrayUnique((part: RecalculatedPartChecksumDto) => part.partNumber, {
    message: 'parts must not repeat a partNumber',
  })
  parts: RecalculatedPartChecksumDto[];
}
