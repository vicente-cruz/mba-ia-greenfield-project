/** S3 client for storage operations, on S3_ENDPOINT (Compose network). */
export const STORAGE_INTERNAL_CLIENT = Symbol('STORAGE_INTERNAL_CLIENT');

/** S3 client used only to sign URLs handed to the browser, on S3_PUBLIC_ENDPOINT (TD-07). */
export const STORAGE_PUBLIC_CLIENT = Symbol('STORAGE_PUBLIC_CLIENT');

/** Signed as a header, never hoisted to the query, so the storage checks it (V-09). */
export const CHECKSUM_SHA256_HEADER = 'x-amz-checksum-sha256';

/**
 * HTTP timeouts of the S3 clients. The connection timeout bounds an unreachable storage; the idle
 * socket timeout bounds a storage that accepts the connection and stops answering, without
 * limiting a long CompleteMultipartUpload that keeps the connection active.
 */
export const STORAGE_HTTP_TIMEOUTS = {
  CONNECTION_MS: 5_000,
  SOCKET_IDLE_MS: 60_000,
} as const;
