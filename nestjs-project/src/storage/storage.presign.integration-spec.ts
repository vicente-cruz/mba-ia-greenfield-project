import { randomBytes } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  cleanupStoragePrefix,
  createStorageTestingModule,
  createStorageTestPrefix,
  requestPresignedUrl,
  sha256Base64,
} from '../test/storage';
import { StorageService } from './storage.service';

const OBJECT_SIZE = 4096;

/** Query parameters and date of a SigV4 presigned URL. */
const signatureOf = (url: string) => {
  const parsed = new URL(url);
  const params = parsed.searchParams;
  const amzDate = params.get('X-Amz-Date') ?? '';
  const signedAt = Date.parse(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );
  return {
    host: parsed.host,
    params,
    signedHeaders: params.get('X-Amz-SignedHeaders'),
    expiresIn: Number(params.get('X-Amz-Expires')),
    signedAt,
    checksumParams: [...params.keys()].filter((name) =>
      name.toLowerCase().includes('checksum'),
    ),
  };
};

describe('StorageService presigned URLs (integration, Compose storage)', () => {
  const prefix = createStorageTestPrefix('storage-presign');
  const key = `${prefix}originals/video-1/session-1`;
  const content = randomBytes(OBJECT_SIZE);
  const config = storageConfig();
  let module: TestingModule;
  let storage: StorageService;

  beforeAll(async () => {
    module = await createStorageTestingModule();
    storage = module.get(StorageService);
    await storage.putObject(key, content, 'video/mp4');
  });

  afterAll(async () => {
    try {
      await cleanupStoragePrefix(prefix);
    } finally {
      await module?.close();
    }
  });

  it('should answer 206 Partial Content with Content-Range to Range: bytes=0-1023 on the browser URL', async () => {
    const signed = await storage.presignGet({
      key,
      audience: 'browser',
      expiresInSeconds: 60,
      responseContentType: 'video/mp4',
    });

    const response = await requestPresignedUrl(signed.url, {
      headers: { range: 'bytes=0-1023' },
    });

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe(
      `bytes 0-1023/${OBJECT_SIZE}`,
    );
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.body.equals(content.subarray(0, 1024))).toBe(true);
  });

  it('should answer 206 on the internal URL used by the worker', async () => {
    const signed = await storage.presignGet({
      key,
      audience: 'internal',
      expiresInSeconds: 60,
    });

    const response = await requestPresignedUrl(signed.url, {
      headers: { range: 'bytes=1024-2047' },
    });

    expect(new URL(signed.url).origin).toBe(new URL(config.endpoint).origin);
    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe(
      `bytes 1024-2047/${OBJECT_SIZE}`,
    );
  });

  it('should return the signed Content-Disposition for downloads', async () => {
    const disposition = `attachment; filename*=UTF-8''v%C3%ADdeo%20final.mp4`;
    const signed = await storage.presignGet({
      key,
      audience: 'browser',
      expiresInSeconds: 60,
      responseContentDisposition: disposition,
    });

    const response = await requestPresignedUrl(signed.url);

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toBe(disposition);
    expect(response.body.equals(content)).toBe(true);
  });

  it('should refuse an anonymous GET without signature with 403', async () => {
    const anonymous = `${config.endpoint}/${config.bucket}/${key}`;

    const plain = await requestPresignedUrl(anonymous);
    const ranged = await requestPresignedUrl(anonymous, {
      headers: { range: 'bytes=0-1023' },
    });

    expect(plain.status).toBe(403);
    expect(ranged.status).toBe(403);
  });

  it('should refuse the URL once expiresAt has passed', async () => {
    const signed = await storage.presignGet({
      key,
      audience: 'browser',
      expiresInSeconds: 1,
    });
    await new Promise((resolve) =>
      setTimeout(resolve, signed.expiresAt.getTime() - Date.now() + 1_500),
    );

    const response = await requestPresignedUrl(signed.url);

    expect(response.status).toBe(403);
  });

  it('should sign GET URLs without checksum parameters and with an exact expiresAt', async () => {
    const signed = await storage.presignGet({
      key,
      audience: 'browser',
      expiresInSeconds: 120,
    });
    const signature = signatureOf(signed.url);

    expect(signature.host).toBe(new URL(config.publicEndpoint).host);
    expect(signature.checksumParams).toEqual([]);
    expect(signature.expiresIn).toBe(120);
    expect(signed.expiresAt.getTime()).toBe(signature.signedAt + 120_000);
  });

  it('should sign UploadPart for the browser with content-length and the checksum as signed headers', async () => {
    const body = randomBytes(1024);
    const checksum = sha256Base64(body);

    const signed = await storage.presignUploadPart({
      key: `${prefix}originals/video-2/session-1`,
      uploadId: 'not-used-for-signing',
      partNumber: 7,
      expectedSize: body.length,
      checksumSha256: checksum,
      expiresInSeconds: 900,
    });
    const signature = signatureOf(signed.url);

    expect(signature.host).toBe(new URL(config.publicEndpoint).host);
    expect(signature.signedHeaders).toBe(
      'content-length;host;x-amz-checksum-sha256',
    );
    expect(signature.checksumParams).toEqual([]);
    expect(signature.params.get('partNumber')).toBe('7');
    expect(signed).toMatchObject({
      method: 'PUT',
      expectedSize: 1024,
      headers: { 'x-amz-checksum-sha256': checksum },
    });
    expect(Object.keys(signed.headers)).toEqual(['x-amz-checksum-sha256']);
    expect(signed.expiresAt.getTime()).toBe(signature.signedAt + 900_000);
  });
});
