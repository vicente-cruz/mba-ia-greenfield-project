import type { StoragePart } from '../storage/storage.types';
import type { UploadPart } from './entities/upload-part.entity';

/** Class of a part of the plan, from the registry and the `ListParts` (TD-02; G-04). */
export enum UploadPartState {
  /** Present, with the registered ETag and the registered checksum and size. */
  CONFIRMED = 'confirmed',
  /** Absent from the storage, signed or not. */
  MISSING = 'missing',
  /** Present, but its ETag, checksum or size differs from the registry. */
  DIVERGENT = 'divergent',
  /** Present, without a registered ETag. */
  UNREGISTERED = 'unregistered',
}

/** What the registry keeps of a part and the classification compares. */
export type RegisteredPart = Pick<
  UploadPart,
  'part_number' | 'expected_size' | 'checksum_sha256' | 'etag'
>;

export interface ClassifiedPart {
  partNumber: number;
  state: UploadPartState;
  /** Registered checksum; `null` when the part was never signed. */
  checksumSha256: string | null;
  /** Registered ETag. */
  etag: string | null;
}

/**
 * One entry per part of the plan, from 1 to `partCount`, in order. Parts the storage lists outside
 * the plan get no entry. The ETags are compared exactly as the client reported them and as the
 * storage lists them, quotes included.
 */
export function classifyPlanParts(
  partCount: number,
  registered: RegisteredPart[],
  listed: StoragePart[],
): ClassifiedPart[] {
  const registry = new Map(registered.map((part) => [part.part_number, part]));
  const storage = new Map(listed.map((part) => [part.partNumber, part]));
  return Array.from({ length: partCount }, (_, index) => {
    const partNumber = index + 1;
    const record = registry.get(partNumber);
    return {
      partNumber,
      state: classifyPart(record, storage.get(partNumber)),
      checksumSha256: record?.checksum_sha256 ?? null,
      etag: record?.etag ?? null,
    };
  });
}

/**
 * Part numbers the storage lists beyond the plan, in ascending order. They are present without a
 * registry, so the completion refuses them (G-04); the GET of the session does not report them.
 */
export function listedOutsidePlan(
  partCount: number,
  listed: StoragePart[],
): number[] {
  return listed
    .map((part) => part.partNumber)
    .filter((partNumber) => partNumber > partCount)
    .sort((a, b) => a - b);
}

function classifyPart(
  record: RegisteredPart | undefined,
  stored: StoragePart | undefined,
): UploadPartState {
  if (!stored) {
    return UploadPartState.MISSING;
  }
  if (!record || record.etag === null) {
    return UploadPartState.UNREGISTERED;
  }
  const matches =
    stored.etag === record.etag &&
    stored.checksumSha256 === record.checksum_sha256 &&
    stored.size === record.expected_size;
  return matches ? UploadPartState.CONFIRMED : UploadPartState.DIVERGENT;
}
