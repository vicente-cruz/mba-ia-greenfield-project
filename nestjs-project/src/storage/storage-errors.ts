// Classification of S3 SDK errors. The transient rules mirror isTransientError and
// isThrottlingError of @smithy/core 3.x (retry/service-error-classification), resolved by
// @aws-sdk/client-s3 3.1170; that package is only a transitive dependency, so the lists are
// copied here. Every 5xx counts as unavailable, as the SI-03.9 acceptance criteria require.

const TRANSIENT_ERROR_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
]);

const THROTTLING_ERROR_NAMES = new Set([
  'BandwidthLimitExceeded',
  'PriorRequestNotComplete',
  'RequestLimitExceeded',
  'RequestThrottled',
  'RequestThrottledException',
  'SlowDown',
  'ThrottledException',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
]);

const NODE_TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const MAX_CAUSE_DEPTH = 10;

/**
 * The SDK retry middleware (asSdkError in @smithy/core) replaces a thrown value that is not an
 * `Error` of its own realm, such as a Node network error seen from a Jest sandbox, with
 * `new Error('AWS SDK error wrapper for ' + value)`. The `code` survives only in that message.
 */
const SDK_ERROR_WRAPPER_PREFIX = 'AWS SDK error wrapper for ';

const wrappedNodeErrorCode = (message: unknown): string | undefined => {
  if (
    typeof message !== 'string' ||
    !message.startsWith(SDK_ERROR_WRAPPER_PREFIX)
  ) {
    return undefined;
  }
  return message
    .slice(SDK_ERROR_WRAPPER_PREFIX.length)
    .split(/[^A-Z_]+/)
    .find((token) => NODE_TRANSIENT_ERROR_CODES.has(token));
};

interface SdkErrorShape {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  $metadata?: { httpStatusCode?: unknown };
  $response?: { headers?: Record<string, string | undefined> };
}

const shapeOf = (error: unknown): SdkErrorShape =>
  typeof error === 'object' && error !== null ? (error as SdkErrorShape) : {};

export function httpStatusOf(error: unknown): number | undefined {
  const status = shapeOf(error).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

export function isTransientStorageError(error: unknown, depth = 0): boolean {
  const { name, code, message, cause } = shapeOf(error);
  if (name === 'AbortError') {
    return false;
  }
  if (wrappedNodeErrorCode(message) !== undefined) {
    return true;
  }
  const status = httpStatusOf(error);
  if (status !== undefined && (status >= 500 || status === 429)) {
    return true;
  }
  if (
    typeof name === 'string' &&
    (TRANSIENT_ERROR_NAMES.has(name) || THROTTLING_ERROR_NAMES.has(name))
  ) {
    return true;
  }
  if (typeof code === 'string' && NODE_TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }
  return (
    cause !== undefined &&
    depth < MAX_CAUSE_DEPTH &&
    isTransientStorageError(cause, depth + 1)
  );
}

/** Upload already completed or aborted: only an HTTP 404 NoSuchUpload (V-10). */
export function isNoSuchUpload(error: unknown): boolean {
  return httpStatusOf(error) === 404 && shapeOf(error).name === 'NoSuchUpload';
}

/**
 * Missing object: an HTTP 404 NoSuchKey, or the NotFound of a HEAD (no body) whose
 * `x-minio-error-code`, when present, is NoSuchKey. A 404 for a missing bucket is not a missing
 * object (V-10).
 */
export function isNoSuchKey(error: unknown): boolean {
  const { name, $response } = shapeOf(error);
  const storageCode = $response?.headers?.['x-minio-error-code'];
  return (
    httpStatusOf(error) === 404 &&
    (name === 'NoSuchKey' || name === 'NotFound') &&
    (storageCode === undefined || storageCode === 'NoSuchKey')
  );
}

/** Short description for logs, without messages that could carry URLs. */
export function describeStorageError(error: unknown): string {
  const { name, code, message } = shapeOf(error);
  const status = httpStatusOf(error);
  return [
    typeof name === 'string' ? name : 'UnknownError',
    status !== undefined ? `HTTP ${status}` : undefined,
    typeof code === 'string' ? code : wrappedNodeErrorCode(message),
  ]
    .filter((part) => part !== undefined)
    .join(' ');
}
