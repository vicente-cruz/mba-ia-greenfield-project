import type { CHECKSUM_SHA256_HEADER } from './storage.constants';

/** Part as listed by the storage. The ETag is kept exactly as the storage returns it. */
export interface StoragePart {
  partNumber: number;
  etag: string;
  size: number;
  checksumSha256?: string;
  lastModified?: Date;
}

export type ListPartsResult =
  | { status: 'found'; parts: StoragePart[] }
  | { status: 'no-such-upload' };

export interface CompletedPartInput {
  partNumber: number;
  etag: string;
  checksumSha256: string;
}

export type CompleteMultipartUploadResult =
  | { status: 'completed'; etag: string }
  | { status: 'no-such-upload' };

/**
 * `aborted` means the storage accepted the abort. The pinned storage (Silo) answers HTTP 204 even
 * for an upload that was already completed, aborted or never existed, so `aborted` does not prove
 * that the upload was open; confirm the absence with `listParts` (`no-such-upload`). S3 answers
 * 404 NoSuchUpload in those cases, mapped to `no-such-upload`.
 */
export type AbortMultipartUploadResult =
  | { status: 'aborted' }
  | { status: 'no-such-upload' };

export interface MultipartUploadSummary {
  key: string;
  uploadId: string;
  initiated?: Date;
}

export type HeadObjectResult =
  | {
      status: 'found';
      size: number;
      etag: string;
      contentType?: string;
      lastModified?: Date;
    }
  | { status: 'not-found' };

export interface StorageObjectSummary {
  key: string;
  size: number;
  etag: string;
  lastModified?: Date;
}

export interface ListObjectsPage {
  objects: StorageObjectSummary[];
  nextContinuationToken?: string;
}

export interface PresignUploadPartInput {
  key: string;
  uploadId: string;
  partNumber: number;
  /** Exact body size, signed as `content-length` (TD-03, V-02). */
  expectedSize: number;
  /** SHA-256 of the part in base64, signed as a header (TD-02, V-09). */
  checksumSha256: string;
  expiresInSeconds: number;
}

export interface PresignedUploadPart {
  url: string;
  method: 'PUT';
  expectedSize: number;
  /** The only headers the browser sets; `content-length` comes from the body size (V-08). */
  headers: Record<typeof CHECKSUM_SHA256_HEADER, string>;
  expiresAt: Date;
}

/** `browser` signs on the public endpoint; `internal` on the Compose endpoint (worker, FFmpeg). */
export type PresignAudience = 'browser' | 'internal';

export interface PresignGetInput {
  key: string;
  audience: PresignAudience;
  expiresInSeconds: number;
  responseContentType?: string;
  responseContentDisposition?: string;
}

export interface PresignedGet {
  url: string;
  expiresAt: Date;
}
