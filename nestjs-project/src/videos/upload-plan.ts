/**
 * Upload plan of a session (TD-03; plan's "Validation Rules → Tamanho da parte"): `part_count =
 * ceil(size_bytes / part_size)`, always at least 1. A size that is an exact multiple of
 * `part_size` ends in a full part, never in an empty one.
 */
export interface UploadPlan {
  partSize: number;
  partCount: number;
}

export function planUpload(sizeBytes: number, partSize: number): UploadPlan {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new RangeError(`sizeBytes must be a positive integer: ${sizeBytes}`);
  }
  if (!Number.isSafeInteger(partSize) || partSize < 1) {
    throw new RangeError(`partSize must be a positive integer: ${partSize}`);
  }
  return { partSize, partCount: Math.ceil(sizeBytes / partSize) };
}

/**
 * `min(part_size, size_bytes - (part_number - 1) * part_size)`. Every part of the plan has at
 * least 1 byte, so a part number outside `1..partCount` is refused.
 */
export function expectedPartSize(
  sizeBytes: number,
  partSize: number,
  partNumber: number,
): number {
  const { partCount } = planUpload(sizeBytes, partSize);
  if (
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > partCount
  ) {
    throw new RangeError(
      `partNumber ${partNumber} is outside the plan of ${partCount} part(s)`,
    );
  }
  return Math.min(partSize, sizeBytes - (partNumber - 1) * partSize);
}
