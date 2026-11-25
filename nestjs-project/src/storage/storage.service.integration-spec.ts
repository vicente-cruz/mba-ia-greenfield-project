import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { ListPartsCommand, type S3Client } from '@aws-sdk/client-s3';
import type { TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  cleanupStoragePrefix,
  createStorageTestingModule,
  createStorageTestPrefix,
  requestPresignedUrl,
  sha256Base64,
} from '../test/storage';
import { createStorageClient } from './storage.clients';
import { STORAGE_INTERNAL_CLIENT } from './storage.constants';
import { StorageUnavailableException } from './storage.exceptions';
import { StorageService } from './storage.service';

// Small bodies only: a single-part upload may be smaller than the 5 MiB minimum of non-final parts.
const PART_SIZE = 64 * 1024;
const URL_TTL_SECONDS = 300;

describe('StorageService (integration, Compose storage)', () => {
  const prefix = createStorageTestPrefix('storage-service');
  let module: TestingModule;
  let storage: StorageService;
  let sequence = 0;

  const newKey = (area = 'originals'): string =>
    `${prefix}${area}/video-${++sequence}/session-1`;

  const putPart = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
    sentBody: Buffer = body,
  ) => {
    const signed = await storage.presignUploadPart({
      key,
      uploadId,
      partNumber,
      expectedSize: body.length,
      checksumSha256: sha256Base64(body),
      expiresInSeconds: URL_TTL_SECONDS,
    });
    const response = await requestPresignedUrl(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: sentBody,
    });
    return { signed, response };
  };

  beforeAll(async () => {
    module = await createStorageTestingModule();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    try {
      await cleanupStoragePrefix(prefix);
    } finally {
      await module?.close();
    }
  });

  describe('multipart upload', () => {
    it('should accept a PUT of exactly expectedSize bytes on the presigned URL and list the declared checksum', async () => {
      const key = newKey();
      const { uploadId } = await storage.createMultipartUpload(key, {
        contentType: 'video/mp4',
      });
      const body = randomBytes(PART_SIZE);

      const { response } = await putPart(key, uploadId, 1, body);
      const listed = await storage.listParts(key, uploadId);

      expect(response.status).toBe(200);
      expect(listed).toEqual({
        status: 'found',
        parts: [
          expect.objectContaining({
            partNumber: 1,
            size: PART_SIZE,
            etag: response.headers.etag,
            checksumSha256: sha256Base64(body),
          }),
        ],
      });
    });

    it('should refuse a body of another size on the same URL, before and after the part is stored', async () => {
      const key = newKey();
      const { uploadId } = await storage.createMultipartUpload(key);
      const body = randomBytes(PART_SIZE);
      const signed = await storage.presignUploadPart({
        key,
        uploadId,
        partNumber: 1,
        expectedSize: body.length,
        checksumSha256: sha256Base64(body),
        expiresInSeconds: URL_TTL_SECONDS,
      });
      const send = (sent: Buffer) =>
        requestPresignedUrl(signed.url, {
          method: 'PUT',
          headers: signed.headers,
          body: sent,
        });

      const bigger = await send(Buffer.concat([body, Buffer.from([0])]));
      const smaller = await send(body.subarray(1));
      const afterRefusals = await storage.listParts(key, uploadId);
      const exact = await send(body);
      const biggerAgain = await send(Buffer.concat([body, Buffer.from([0])]));
      const afterStored = await storage.listParts(key, uploadId);

      expect([bigger.status, smaller.status]).toEqual([403, 403]);
      expect(afterRefusals).toEqual({ status: 'found', parts: [] });
      expect(exact.status).toBe(200);
      expect(biggerAgain.status).toBe(403);
      expect(afterStored).toEqual({
        status: 'found',
        parts: [
          expect.objectContaining({
            partNumber: 1,
            size: PART_SIZE,
            etag: exact.headers.etag,
          }),
        ],
      });
    });

    it('should follow the ListParts pagination until the last page', async () => {
      const key = newKey();
      const { uploadId } = await storage.createMultipartUpload(key);
      const bodies = [1, 2, 3].map(() => randomBytes(1024));
      for (const [index, body] of bodies.entries()) {
        await putPart(key, uploadId, index + 1, body);
      }
      const client = module.get<S3Client>(STORAGE_INTERNAL_CLIENT);
      const send = jest.spyOn(client, 'send');

      const listed = await storage.listParts(key, uploadId, { pageSize: 2 });
      const listPartsCalls = send.mock.calls.filter(
        ([command]) => command instanceof ListPartsCommand,
      ).length;
      send.mockRestore();

      expect(listPartsCalls).toBe(2);
      expect(listed).toEqual({
        status: 'found',
        parts: bodies.map((body, index): unknown =>
          expect.objectContaining({
            partNumber: index + 1,
            checksumSha256: sha256Base64(body),
          }),
        ),
      });
    });

    it('should complete with the registered parts and answer NoSuchUpload afterwards', async () => {
      const key = newKey();
      const { uploadId } = await storage.createMultipartUpload(key, {
        contentType: 'video/mp4',
      });
      const body = randomBytes(PART_SIZE);
      const { response } = await putPart(key, uploadId, 1, body);
      const parts = [
        {
          partNumber: 1,
          etag: String(response.headers.etag),
          checksumSha256: sha256Base64(body),
        },
      ];

      const completed = await storage.completeMultipartUpload(
        key,
        uploadId,
        parts,
      );
      const head = await storage.headObject(key);
      const secondComplete = await storage.completeMultipartUpload(
        key,
        uploadId,
        parts,
      );
      const listAfter = await storage.listParts(key, uploadId);
      const abortAfter = await storage.abortMultipartUpload(key, uploadId);

      expect(completed).toEqual({
        status: 'completed',
        etag: expect.any(String) as unknown,
      });
      expect(head).toMatchObject({
        status: 'found',
        size: PART_SIZE,
        contentType: 'video/mp4',
      });
      expect(secondComplete).toEqual({ status: 'no-such-upload' });
      expect(listAfter).toEqual({ status: 'no-such-upload' });
      // The pinned storage answers 204 to an abort of a finished upload (see
      // AbortMultipartUploadResult); ListParts above is what confirms the absence.
      expect(abortAfter).toEqual({ status: 'aborted' });
    });

    it('should abort and answer NoSuchUpload afterwards, without creating the object', async () => {
      const key = newKey();
      const { uploadId } = await storage.createMultipartUpload(key);
      const body = randomBytes(PART_SIZE);
      const { response } = await putPart(key, uploadId, 1, body);

      const aborted = await storage.abortMultipartUpload(key, uploadId);
      const listAfter = await storage.listParts(key, uploadId);
      const completeAfter = await storage.completeMultipartUpload(
        key,
        uploadId,
        [
          {
            partNumber: 1,
            etag: String(response.headers.etag),
            checksumSha256: sha256Base64(body),
          },
        ],
      );
      const abortAgain = await storage.abortMultipartUpload(key, uploadId);
      const head = await storage.headObject(key);

      expect(aborted).toEqual({ status: 'aborted' });
      expect(listAfter).toEqual({ status: 'no-such-upload' });
      expect(completeAfter).toEqual({ status: 'no-such-upload' });
      // Repeated abort: the pinned storage answers 204 again instead of NoSuchUpload.
      expect(abortAgain).toEqual({ status: 'aborted' });
      expect(head).toEqual({ status: 'not-found' });
    });

    it('should list open uploads by directory prefix, which the storage only accepts as an exact key', async () => {
      const first = await storage.createMultipartUpload(
        `${prefix}listing/originals/v1/s1`,
      );
      const second = await storage.createMultipartUpload(
        `${prefix}listing/originals/v2/s1`,
      );
      await storage.createMultipartUpload(`${prefix}listing/other/v3/s1`);

      const byDirectory = await storage.listMultipartUploads(
        `${prefix}listing/originals/`,
      );
      const byExactKey = await storage.listMultipartUploads(
        `${prefix}listing/originals/v1/s1`,
      );

      expect(byDirectory.map((u) => u.uploadId).sort()).toEqual(
        [first.uploadId, second.uploadId].sort(),
      );
      expect(byExactKey).toEqual([
        expect.objectContaining({
          key: `${prefix}listing/originals/v1/s1`,
          uploadId: first.uploadId,
        }),
      ]);
    });
  });

  describe('objects', () => {
    it('should put, head, list and delete an object, with delete being idempotent', async () => {
      const key = `${prefix}thumbnails/video-1/attempt-1.jpg`;
      const body = randomBytes(2048);

      const put = await storage.putObject(key, body, 'image/jpeg');
      const head = await storage.headObject(key);
      const listed = await storage.listObjects(`${prefix}thumbnails/`);
      await storage.deleteObject(key);
      const headAfter = await storage.headObject(key);

      expect(head).toMatchObject({
        status: 'found',
        size: 2048,
        etag: put.etag,
        contentType: 'image/jpeg',
      });
      expect(listed.objects).toEqual([
        expect.objectContaining({ key, size: 2048, etag: put.etag }),
      ]);
      expect(headAfter).toEqual({ status: 'not-found' });
      await expect(storage.deleteObject(key)).resolves.toBeUndefined();
    });

    it('should page ListObjectsV2 with the continuation token', async () => {
      const area = `${prefix}paging/`;
      for (const name of ['a', 'b', 'c']) {
        await storage.putObject(
          `${area}${name}`,
          randomBytes(16),
          'text/plain',
        );
      }

      const first = await storage.listObjects(area, { maxKeys: 2 });
      const second = await storage.listObjects(area, {
        maxKeys: 2,
        continuationToken: first.nextContinuationToken,
      });

      expect(first.objects).toHaveLength(2);
      expect(first.nextContinuationToken).toEqual(expect.any(String));
      expect(second.objects).toHaveLength(1);
      expect(second.nextContinuationToken).toBeUndefined();
      expect(
        [...first.objects, ...second.objects].map((o) => o.key).sort(),
      ).toEqual([`${area}a`, `${area}b`, `${area}c`]);
    });
  });
});

describe('StorageService (integration, storage failures)', () => {
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;

  const s3Error = (status: number, code: string): Handler => {
    return (req, res) => {
      res.writeHead(status, {
        'content-type': 'application/xml',
        ...(req.method === 'HEAD' ? { 'x-minio-error-code': code } : {}),
      });
      res.end(
        req.method === 'HEAD'
          ? undefined
          : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>stub</Message><RequestId>stub</RequestId></Error>`,
      );
    };
  };

  // A stub S3 server in the test process. It stands for a broken storage, so it listens on the
  // loopback of this process, not on a Compose service.
  const withStubStorage = async (
    handler: Handler,
    run: (storage: StorageService, requests: () => number) => Promise<void>,
    timeouts?: { connectionMs: number; socketIdleMs: number },
  ): Promise<void> => {
    let count = 0;
    const server: Server = createServer((req, res) => {
      count += 1;
      req.resume();
      handler(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const config = storageConfig();
    const module = await createStorageTestingModule({
      internalClient: createStorageClient(
        config,
        `http://127.0.0.1:${port}`,
        timeouts,
      ),
    });
    try {
      await run(module.get(StorageService), () => count);
    } finally {
      await module.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  const expectUnavailable = async (call: Promise<unknown>) => {
    const error: unknown = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageUnavailableException);
    expect(error).toMatchObject({
      errorCode: 'STORAGE_UNAVAILABLE',
      httpStatus: 503,
    });
    return error as StorageUnavailableException;
  };

  it.each([
    ['HeadObject', (s: StorageService) => s.headObject('k')],
    ['ListParts', (s: StorageService) => s.listParts('k', 'u')],
    [
      'CreateMultipartUpload',
      (s: StorageService) => s.createMultipartUpload('k'),
    ],
  ])(
    'should report a network error of %s as STORAGE_UNAVAILABLE',
    async (_operation, call) => {
      const config = storageConfig();
      // A closed port on the Compose storage service refuses the connection.
      const module = await createStorageTestingModule({
        internalClient: createStorageClient(config, 'http://storage:1'),
      });
      try {
        const error = await expectUnavailable(call(module.get(StorageService)));
        // The code is in the message both for the raw Node error and for the SDK wrapper.
        expect(String((error.cause as Error).message)).toContain(
          'ECONNREFUSED',
        );
      } finally {
        await module.close();
      }
    },
  );

  it.each([500, 502, 503, 504])(
    'should report an HTTP %i of the storage as STORAGE_UNAVAILABLE',
    async (status) => {
      await withStubStorage(
        s3Error(status, 'InternalError'),
        async (storage, requests) => {
          await expectUnavailable(storage.listParts('k', 'u'));
          await expectUnavailable(storage.headObject('k'));
          expect(requests()).toBeGreaterThan(0);
        },
      );
    },
  );

  it('should report a storage that stops answering as STORAGE_UNAVAILABLE after the idle timeout', async () => {
    await withStubStorage(
      () => undefined,
      async (storage) => {
        const error = await expectUnavailable(storage.headObject('k'));
        expect(error.cause).toMatchObject({ name: 'TimeoutError' });
      },
      { connectionMs: 1_000, socketIdleMs: 300 },
    );
  });

  it('should map a 404 NoSuchUpload of ListParts, Complete and Abort to explicit results', async () => {
    await withStubStorage(s3Error(404, 'NoSuchUpload'), async (storage) => {
      const listed = await storage.listParts('k', 'u');
      const completed = await storage.completeMultipartUpload('k', 'u', [
        { partNumber: 1, etag: '"e"', checksumSha256: 'c' },
      ]);
      const aborted = await storage.abortMultipartUpload('k', 'u');

      expect([listed, completed, aborted]).toEqual([
        { status: 'no-such-upload' },
        { status: 'no-such-upload' },
        { status: 'no-such-upload' },
      ]);
    });
  });

  it('should propagate a non-transient error unchanged', async () => {
    await withStubStorage(s3Error(403, 'AccessDenied'), async (storage) => {
      const error: unknown = await storage
        .listParts('k', 'u')
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(StorageUnavailableException);
      expect(error).toMatchObject({ name: 'AccessDenied' });
    });
  });

  it('should not report a 404 for a missing bucket as a missing object', async () => {
    await withStubStorage(s3Error(404, 'NoSuchBucket'), async (storage) => {
      const error: unknown = await storage
        .headObject('k')
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(StorageUnavailableException);
      expect(error).toMatchObject({ $metadata: { httpStatusCode: 404 } });
    });
  });
});
