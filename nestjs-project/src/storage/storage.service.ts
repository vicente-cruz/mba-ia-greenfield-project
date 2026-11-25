import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  type Part,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  CHECKSUM_SHA256_HEADER,
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PUBLIC_CLIENT,
} from './storage.constants';
import {
  describeStorageError,
  isNoSuchKey,
  isNoSuchUpload,
  isTransientStorageError,
} from './storage-errors';
import { StorageUnavailableException } from './storage.exceptions';
import type {
  AbortMultipartUploadResult,
  CompletedPartInput,
  CompleteMultipartUploadResult,
  HeadObjectResult,
  ListObjectsPage,
  ListPartsResult,
  MultipartUploadSummary,
  PresignedGet,
  PresignedUploadPart,
  PresignGetInput,
  PresignUploadPartInput,
  StoragePart,
} from './storage.types';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket: string;

  constructor(
    @Inject(STORAGE_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(STORAGE_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
  }

  // ---- multipart (TD-02) ----

  async createMultipartUpload(
    key: string,
    options: { contentType?: string } = {},
  ): Promise<{ uploadId: string }> {
    const output = await this.run('CreateMultipartUpload', () =>
      this.internalClient.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: options.contentType,
          ChecksumAlgorithm: 'SHA256',
        }),
      ),
    );
    if (!output.UploadId) {
      throw new Error('CreateMultipartUpload returned no UploadId');
    }
    return { uploadId: output.UploadId };
  }

  /** Every part of the upload, following the pagination until the last page. */
  async listParts(
    key: string,
    uploadId: string,
    options: { pageSize?: number } = {},
  ): Promise<ListPartsResult> {
    const parts: StoragePart[] = [];
    let marker: string | undefined;
    try {
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            MaxParts: options.pageSize,
            PartNumberMarker: marker,
          }),
        );
        parts.push(...(page.Parts ?? []).map(toStoragePart));
        const next = page.IsTruncated ? page.NextPartNumberMarker : undefined;
        if (next !== undefined && next === marker) {
          throw new Error('ListParts pagination did not advance');
        }
        marker = next;
      } while (marker !== undefined);
    } catch (error) {
      if (isNoSuchUpload(error)) {
        return { status: 'no-such-upload' };
      }
      throw this.translate('ListParts', error);
    }
    return { status: 'found', parts };
  }

  /**
   * Completes with the parts registered by the caller. No If-None-Match and no
   * x-amz-mp-object-size: with If-None-Match a repeated Complete answers 412 instead of
   * NoSuchUpload, and the pinned storage ignores the object size (V-10, review of 2026-11-18).
   */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartInput[],
  ): Promise<CompleteMultipartUploadResult> {
    try {
      const output = await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
                ChecksumSHA256: part.checksumSha256,
              })),
          },
        }),
      );
      return { status: 'completed', etag: output.ETag ?? '' };
    } catch (error) {
      if (isNoSuchUpload(error)) {
        return { status: 'no-such-upload' };
      }
      throw this.translate('CompleteMultipartUpload', error);
    }
  }

  /** See AbortMultipartUploadResult: on the pinned storage, only `listParts` confirms absence. */
  async abortMultipartUpload(
    key: string,
    uploadId: string,
  ): Promise<AbortMultipartUploadResult> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
      return { status: 'aborted' };
    } catch (error) {
      if (isNoSuchUpload(error)) {
        return { status: 'no-such-upload' };
      }
      throw this.translate('AbortMultipartUpload', error);
    }
  }

  /**
   * Open multipart uploads whose key starts with `prefix`. The pinned storage only answers
   * ListMultipartUploads when `Prefix` is an exact object key: a directory prefix returns no
   * uploads and no error. So the whole bucket is listed and filtered here, which is also correct
   * on S3.
   */
  async listMultipartUploads(
    prefix: string,
  ): Promise<MultipartUploadSummary[]> {
    const uploads: MultipartUploadSummary[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (;;) {
      const page = await this.run('ListMultipartUploads', () =>
        this.internalClient.send(
          new ListMultipartUploadsCommand({
            Bucket: this.bucket,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
        ),
      );
      for (const upload of page.Uploads ?? []) {
        if (upload.Key?.startsWith(prefix) && upload.UploadId) {
          uploads.push({
            key: upload.Key,
            uploadId: upload.UploadId,
            initiated: upload.Initiated,
          });
        }
      }
      if (!page.IsTruncated) {
        return uploads;
      }
      if (
        page.NextKeyMarker === keyMarker &&
        page.NextUploadIdMarker === uploadIdMarker
      ) {
        throw new Error('ListMultipartUploads pagination did not advance');
      }
      keyMarker = page.NextKeyMarker;
      uploadIdMarker = page.NextUploadIdMarker;
    }
  }

  // ---- objects (TD-06) ----

  async headObject(key: string): Promise<HeadObjectResult> {
    try {
      const output = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        status: 'found',
        size: output.ContentLength ?? 0,
        etag: output.ETag ?? '',
        contentType: output.ContentType,
        lastModified: output.LastModified,
      };
    } catch (error) {
      if (isNoSuchKey(error)) {
        return { status: 'not-found' };
      }
      throw this.translate('HeadObject', error);
    }
  }

  async putObject(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<{ etag: string }> {
    const output = await this.run('PutObject', () =>
      this.internalClient.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: contentType,
        }),
      ),
    );
    return { etag: output.ETag ?? '' };
  }

  /** Idempotent: deleting a missing key succeeds. */
  async deleteObject(key: string): Promise<void> {
    await this.run('DeleteObject', () =>
      this.internalClient.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      ),
    );
  }

  /** One page of objects under `prefix`; pass `nextContinuationToken` back for the next one. */
  async listObjects(
    prefix: string,
    options: { continuationToken?: string; maxKeys?: number } = {},
  ): Promise<ListObjectsPage> {
    const page = await this.run('ListObjectsV2', () =>
      this.internalClient.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: options.continuationToken,
          MaxKeys: options.maxKeys,
        }),
      ),
    );
    return {
      objects: (page.Contents ?? []).map((object) => ({
        key: object.Key ?? '',
        size: object.Size ?? 0,
        etag: object.ETag ?? '',
        lastModified: object.LastModified,
      })),
      nextContinuationToken: page.IsTruncated
        ? page.NextContinuationToken
        : undefined,
    };
  }

  // ---- presigned URLs (TD-01, TD-03, TD-14) ----

  /**
   * Signed on the public endpoint, for the browser. `content-length` is a signed header, so a
   * body of any other size is refused by the storage (V-02, V-08); the checksum stays a signed
   * header instead of a query parameter, so the storage checks it (V-09).
   */
  async presignUploadPart(
    input: PresignUploadPartInput,
  ): Promise<PresignedUploadPart> {
    const signingDate = wholeSecondNow();
    const url = await getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        ContentLength: input.expectedSize,
        ChecksumSHA256: input.checksumSha256,
      }),
      {
        expiresIn: input.expiresInSeconds,
        signingDate,
        signableHeaders: new Set(['content-length']),
        unhoistableHeaders: new Set([CHECKSUM_SHA256_HEADER]),
      },
    );
    return {
      url,
      method: 'PUT',
      expectedSize: input.expectedSize,
      headers: { [CHECKSUM_SHA256_HEADER]: input.checksumSha256 },
      expiresAt: expiresAt(signingDate, input.expiresInSeconds),
    };
  }

  /** GET for the browser (playback, download) or for the worker on the internal endpoint. */
  async presignGet(input: PresignGetInput): Promise<PresignedGet> {
    const client =
      input.audience === 'browser' ? this.publicClient : this.internalClient;
    const signingDate = wholeSecondNow();
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ResponseContentType: input.responseContentType,
        ResponseContentDisposition: input.responseContentDisposition,
      }),
      { expiresIn: input.expiresInSeconds, signingDate },
    );
    return { url, expiresAt: expiresAt(signingDate, input.expiresInSeconds) };
  }

  // ---- errors ----

  private async run<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.translate(operation, error);
    }
  }

  /** Transient failures become STORAGE_UNAVAILABLE; any other error reaches the caller unchanged. */
  private translate(operation: string, error: unknown): unknown {
    if (!isTransientStorageError(error)) {
      return error;
    }
    this.logger.warn(
      `${operation} failed with a transient storage error: ${describeStorageError(error)}`,
    );
    return new StorageUnavailableException(operation, error);
  }
}

function toStoragePart(part: Part): StoragePart {
  if (part.PartNumber === undefined || !part.ETag || part.Size === undefined) {
    throw new Error('ListParts returned a part without number, ETag or size');
  }
  return {
    partNumber: part.PartNumber,
    etag: part.ETag,
    size: part.Size,
    checksumSha256: part.ChecksumSHA256,
    lastModified: part.LastModified,
  };
}

/** SigV4 dates have second precision; signing on a whole second makes `expiresAt` exact. */
function wholeSecondNow(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

function expiresAt(signingDate: Date, expiresInSeconds: number): Date {
  return new Date(signingDate.getTime() + expiresInSeconds * 1000);
}
