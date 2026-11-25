import {
  isNoSuchKey,
  isNoSuchUpload,
  isTransientStorageError,
} from './storage-errors';

const serviceError = (
  name: string,
  httpStatusCode: number,
  headers: Record<string, string> = {},
) => ({
  name,
  $metadata: { httpStatusCode },
  $response: { headers },
});

const networkError = (code: string) =>
  Object.assign(new Error(`connect ${code}`), { code });

describe('isTransientStorageError', () => {
  it.each([500, 502, 503, 504, 501])(
    'should treat HTTP %i as transient',
    (status) => {
      expect(isTransientStorageError(serviceError('ServerError', status))).toBe(
        true,
      );
    },
  );

  it.each(['SlowDown', 'TimeoutError', 'RequestTimeout'])(
    'should treat %s as transient',
    (name) => {
      expect(isTransientStorageError({ name })).toBe(true);
    },
  );

  it('should treat HTTP 429 as transient', () => {
    expect(isTransientStorageError(serviceError('TooMany', 429))).toBe(true);
  });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ])('should treat the network error %s as transient', (code) => {
    expect(isTransientStorageError(networkError(code))).toBe(true);
  });

  it('should recognize a network error wrapped by the SDK, which loses the code property', () => {
    const wrapped = new Error(
      'AWS SDK error wrapper for Error: connect ECONNREFUSED 172.20.0.5:1',
    );

    expect(isTransientStorageError(wrapped)).toBe(true);
  });

  it('should not treat an SDK wrapper without a network code as transient', () => {
    const wrapped = new Error('AWS SDK error wrapper for [object Foo]');

    expect(isTransientStorageError(wrapped)).toBe(false);
  });

  it('should follow the cause chain', () => {
    const wrapped = new Error('wrapped', { cause: networkError('ECONNRESET') });

    expect(isTransientStorageError(wrapped)).toBe(true);
  });

  it.each([
    ['NoSuchKey', 404],
    ['NoSuchUpload', 404],
    ['AccessDenied', 403],
    ['SignatureDoesNotMatch', 403],
    ['InvalidPart', 400],
  ])('should not treat %s (HTTP %i) as transient', (name, status) => {
    expect(isTransientStorageError(serviceError(name, status))).toBe(false);
  });

  it('should not treat an abort or a programming error as transient', () => {
    expect(
      isTransientStorageError({ name: 'AbortError', code: 'ECONNRESET' }),
    ).toBe(false);
    expect(isTransientStorageError(new TypeError('x is undefined'))).toBe(
      false,
    );
  });
});

describe('isNoSuchUpload', () => {
  it('should accept only an HTTP 404 NoSuchUpload', () => {
    expect(isNoSuchUpload(serviceError('NoSuchUpload', 404))).toBe(true);
    expect(isNoSuchUpload(serviceError('NoSuchKey', 404))).toBe(false);
    expect(isNoSuchUpload(serviceError('NoSuchUpload', 500))).toBe(false);
  });
});

describe('isNoSuchKey', () => {
  it('should accept a 404 NoSuchKey and a HEAD NotFound without a storage code', () => {
    expect(isNoSuchKey(serviceError('NoSuchKey', 404))).toBe(true);
    expect(isNoSuchKey(serviceError('NotFound', 404))).toBe(true);
  });

  it('should accept a HEAD NotFound whose x-minio-error-code is NoSuchKey', () => {
    expect(
      isNoSuchKey(
        serviceError('NotFound', 404, { 'x-minio-error-code': 'NoSuchKey' }),
      ),
    ).toBe(true);
  });

  it('should reject a 404 for a missing bucket and errors with other statuses', () => {
    expect(
      isNoSuchKey(
        serviceError('NotFound', 404, { 'x-minio-error-code': 'NoSuchBucket' }),
      ),
    ).toBe(false);
    expect(isNoSuchKey(serviceError('NoSuchBucket', 404))).toBe(false);
    expect(isNoSuchKey(serviceError('AccessDenied', 403))).toBe(false);
  });
});
