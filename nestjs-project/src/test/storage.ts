import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { createStorageClient } from '../storage/storage.clients';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PUBLIC_CLIENT,
} from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import type {
  CompletedPartInput,
  CompleteMultipartUploadResult,
} from '../storage/storage.types';

/** Every test object lives under this root, in the bucket of the Compose storage. */
const TEST_ROOT = 'tests/';

/** Isolated prefix for one suite: `tests/<suite>-<time>-<random>/`. */
export function createStorageTestPrefix(suite: string): string {
  return `${TEST_ROOT}${suite}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}/`;
}

export interface StorageTestingModuleOptions {
  internalClient?: S3Client;
  publicClient?: S3Client;
}

/** StorageModule with the storage config from `.env`; clients can be replaced (error tests). */
export async function createStorageTestingModule(
  options: StorageTestingModuleOptions = {},
): Promise<TestingModule> {
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  });
  if (options.internalClient) {
    builder = builder
      .overrideProvider(STORAGE_INTERNAL_CLIENT)
      .useValue(options.internalClient);
  }
  if (options.publicClient) {
    builder = builder
      .overrideProvider(STORAGE_PUBLIC_CLIENT)
      .useValue(options.publicClient);
  }
  return builder.compile();
}

export interface StorageCleanupReport {
  abortedUploads: number;
  deletedObjects: number;
}

/**
 * Aborts every multipart upload and deletes every object under a test prefix, then confirms that
 * nothing is left. It uses its own client instead of StorageService, so a defect in the code under
 * test cannot hide leftovers. Call it from `afterAll`, which Jest runs even when tests fail.
 */
export async function cleanupStoragePrefix(
  prefix: string,
): Promise<StorageCleanupReport> {
  if (!prefix.startsWith(TEST_ROOT) || prefix.length <= TEST_ROOT.length) {
    throw new Error(
      `Refusing to clean a prefix outside ${TEST_ROOT}: ${prefix}`,
    );
  }
  const config = storageConfig();
  const client = createStorageClient(config, config.endpoint);
  try {
    const uploads = await listUploadsUnder(client, config.bucket, prefix);
    for (const upload of uploads) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: config.bucket,
          Key: upload.key,
          UploadId: upload.uploadId,
        }),
      );
    }
    const keys = await listKeysUnder(client, config.bucket, prefix);
    for (const key of keys) {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    }
    const uploadsLeft = await listUploadsUnder(client, config.bucket, prefix);
    const keysLeft = await listKeysUnder(client, config.bucket, prefix);
    if (uploadsLeft.length > 0 || keysLeft.length > 0) {
      throw new Error(
        `Storage cleanup left ${uploadsLeft.length} upload(s) and ${keysLeft.length} object(s) under ${prefix}`,
      );
    }
    return { abortedUploads: uploads.length, deletedObjects: keys.length };
  } finally {
    client.destroy();
  }
}

/** Bucket-wide listing filtered here: the pinned storage only accepts an exact key as Prefix. */
export async function listUploadsUnder(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<{ key: string; uploadId: string }[]> {
  const uploads: { key: string; uploadId: string }[] = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (;;) {
    const page = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );
    for (const upload of page.Uploads ?? []) {
      if (upload.Key?.startsWith(prefix) && upload.UploadId) {
        uploads.push({ key: upload.Key, uploadId: upload.UploadId });
      }
    }
    if (
      !page.IsTruncated ||
      (page.NextKeyMarker === keyMarker &&
        page.NextUploadIdMarker === uploadIdMarker)
    ) {
      return uploads;
    }
    keyMarker = page.NextKeyMarker;
    uploadIdMarker = page.NextUploadIdMarker;
  }
}

export async function listKeysUnder(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    keys.push(...(page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : [])));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export interface RawHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Sends an HTTP request to a presigned URL from inside the container. URLs signed for the browser
 * point to S3_PUBLIC_ENDPOINT, which the browser reaches through the port published on the host.
 * Here the connection goes to S3_ENDPOINT, the Compose service, while the signed Host header of
 * the URL is kept, so the signature still matches what the browser would send.
 */
export function requestPresignedUrl(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
  } = {},
): Promise<RawHttpResponse> {
  const target = new URL(url);
  const config = storageConfig();
  const connectTo =
    target.host === new URL(config.publicEndpoint).host
      ? new URL(config.endpoint)
      : target;
  if (connectTo.protocol !== 'http:') {
    throw new Error(`Only http endpoints are supported in tests: ${url}`);
  }
  const headers: Record<string, string> = {
    host: target.host,
    ...options.headers,
  };
  if (options.body) {
    headers['content-length'] = String(options.body.length);
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: connectTo.hostname,
        port: connectTo.port,
        method: options.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(30_000, () =>
      req.destroy(new Error(`Request to ${target.host} timed out`)),
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** SHA-256 in base64 with padding, the format of `x-amz-checksum-sha256`. */
export function sha256Base64(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64');
}

/**
 * Calls the real `createMultipartUpload` of a StorageService whose method is spied on, so a spy
 * can run code before the real call: `jest.spyOn` replaces the instance property, and the
 * prototype keeps the original.
 */
export function realCreateMultipartUpload(
  storage: StorageService,
  key: string,
  options: { contentType?: string } = {},
): Promise<{ uploadId: string }> {
  return StorageService.prototype.createMultipartUpload.call(
    storage,
    key,
    options,
  ) as Promise<{ uploadId: string }>;
}

/** As `realCreateMultipartUpload`, for the `completeMultipartUpload` of a spied StorageService. */
export function realCompleteMultipartUpload(
  storage: StorageService,
  key: string,
  uploadId: string,
  parts: CompletedPartInput[],
): Promise<CompleteMultipartUploadResult> {
  return StorageService.prototype.completeMultipartUpload.call(
    storage,
    key,
    uploadId,
    parts,
  ) as Promise<CompleteMultipartUploadResult>;
}
