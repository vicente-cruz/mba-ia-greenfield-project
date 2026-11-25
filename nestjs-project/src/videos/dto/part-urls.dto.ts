import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { CHECKSUM_SHA256_FORMAT } from '../videos.constants';

export const PART_URLS_LIMITS = {
  /** Three requests sign the 150 parts of 10,000,000,000 bytes. */
  MAX_PARTS: 50,
  /** One request can register every ETag of the largest upload. */
  MAX_COMPLETED_PARTS: 150,
} as const;

export class PartToSignDto {
  /** Number of the part, from 1. The upper bound `partCount` is checked by the service (400 INVALID_PART_NUMBER). */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** SHA-256 of the exact bytes of the part, in base64 with padding (44 characters). */
  @IsString()
  @Matches(CHECKSUM_SHA256_FORMAT.PATTERN, {
    message: CHECKSUM_SHA256_FORMAT.MESSAGE,
  })
  checksumSha256: string;
}

export class CompletedPartDto {
  /** Number of a part whose checksum is already registered. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag read from the response of the PUT of the part. */
  @IsString()
  @Length(1, 255)
  etag: string;
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

@ValidatorConstraint({ name: 'partsOrCompletedParts' })
class PartsOrCompletedPartsConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const request = args.object as PartUrlsRequestDto;
    return hasItems(request.parts) || hasItems(request.completedParts);
  }

  defaultMessage(): string {
    return 'parts or completedParts must have at least one item';
  }
}

/**
 * Signs parts and registers the ETags of parts already sent, in one request. At least one of the
 * two arrays must have items, and every item must be an object: `ValidateNested` alone accepts a
 * nested array (`[[]]`, `[[{…}]]`) as an item. Repeated part numbers and numbers above
 * `partCount` are domain errors of the service (400 INVALID_PART_NUMBER).
 */
export class PartUrlsRequestDto {
  /** Parts to sign, up to 50. */
  // Also validated when absent, unless completedParts has items, to require one non-empty array.
  @ValidateIf(
    (request: PartUrlsRequestDto) =>
      request.parts !== undefined || !hasItems(request.completedParts),
  )
  @IsArray()
  @ArrayMaxSize(PART_URLS_LIMITS.MAX_PARTS)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => PartToSignDto)
  @Validate(PartsOrCompletedPartsConstraint)
  parts?: PartToSignDto[];

  /** Parts already sent, with the ETag of their PUT, up to 150. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PART_URLS_LIMITS.MAX_COMPLETED_PARTS)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  completedParts?: CompletedPartDto[];
}
