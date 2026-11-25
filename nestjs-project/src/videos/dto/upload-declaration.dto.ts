import {
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** No `/`, `\` or control characters (Unicode category Cc). */
const FILE_NAME_PATTERN = /^[^/\\\p{Cc}]+$/u;

/** `type/subtype` with the restricted-name characters of RFC 6838, without parameters. */
const CONTENT_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/**
 * File declared to start an upload (POST /videos, and the restart of SI-03.18). Only the shape is
 * validated here: the size limit (413) and the accepted types (415) are domain rules of the
 * service, otherwise those codes could never be reached.
 */
export class UploadDeclarationDto {
  /** Name of the file chosen by the user, from 1 to 255 characters. */
  @IsString()
  @Length(1, 255)
  @Matches(FILE_NAME_PATTERN, {
    message: 'fileName must not contain "/", "\\" or control characters',
  })
  fileName: string;

  /** Size of the whole file in bytes: a safe integer of at least 1. */
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes: number;

  /** MIME type of the file in the `type/subtype` format, e.g. `video/mp4`. */
  @IsString()
  @MaxLength(100)
  @Matches(CONTENT_TYPE_PATTERN, {
    message: 'contentType must use the type/subtype format',
  })
  contentType: string;
}
