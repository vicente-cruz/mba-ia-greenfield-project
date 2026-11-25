/** Queues of the phase (TD-09). `video-maintenance` is consumed and scheduled by the worker. */
export const VIDEO_QUEUES = {
  PROCESSING: 'video-processing',
  MAINTENANCE: 'video-maintenance',
} as const;

/** Name of the job of `video-processing` ("Events/Messages → process-video"). */
export const PROCESS_VIDEO_JOB_NAME = 'process-video';

/** Types accepted for the original (Q-03); any other is refused with 415. MOV is out of the phase. */
export const ACCEPTED_VIDEO_CONTENT_TYPES: readonly string[] = [
  'video/mp4',
  'video/webm',
];

/** Only checksum algorithm of the phase (V-09). */
export const UPLOAD_CHECKSUM_ALGORITHM = 'SHA256';

/**
 * Format of `checksumSha256` in the request bodies ("Validation Rules"): the SHA-256 digest of 32
 * bytes in standard base64 with padding (RFC 4648), as in V-09.
 */
export const CHECKSUM_SHA256_FORMAT = {
  PATTERN: /^[A-Za-z0-9+/]{43}=$/,
  MESSAGE: 'checksumSha256 must be a SHA-256 digest in base64 with padding',
} as const;

/** The only result of a file verification that passes (SI-03.15). */
export const FILE_VERIFICATION_MATCH = 'match';

/** Page of the `ListParts` that the classification walks: the maximum of the S3, 1,000 parts. */
export const LIST_PARTS_PAGE_SIZE = 1_000;

/**
 * Bound of the R2 `add` after the T2 of P2 (SI-03.16). With the Redis down, the `add` of BullMQ
 * waits for the connection instead of failing, so without a bound the completion would not answer
 * 202. A late `add` is harmless: the action stays pending and the reconciliation confirms it (P5).
 */
export const VIDEO_JOB_PUBLISH_TIMEOUT_MS = 5_000;

/** Generation of the first job of an execution, reserved by the T2 of P2 (P5). */
export const FIRST_JOB_DISPATCH = 1;

/**
 * Abort of a session in the request (SI-03.17): `AbortMultipartUpload` followed by `ListParts`,
 * repeated until the listing answers NoSuchUpload. The pinned storage answers the abort with 204
 * even for an upload that no longer exists, so only the listing confirms it (SI-03.9). A part in
 * transit can keep the upload listed (F-09): after the last attempt, the session stays `aborting`
 * and the sweep concludes it, so the request never waits indefinitely.
 */
export const ABORT_CONFIRMATION = {
  ATTEMPTS: 3,
  RETRY_DELAY_MS: 250,
} as const;
