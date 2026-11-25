import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { DataSource } from 'typeorm';
import { VIDEO_DEFAULTS } from '../../src/config/config.constants';
import storageConfig from '../../src/config/storage.config';
import { createStorageClient } from '../../src/storage/storage.clients';
import {
  listKeysUnder,
  listUploadsUnder,
  sha256Base64,
} from '../../src/test/storage';
import { UploadPart } from '../../src/videos/entities/upload-part.entity';
import {
  UploadSession,
  UploadSessionStatus,
} from '../../src/videos/entities/upload-session.entity';
import { Video, VideoStatus } from '../../src/videos/entities/video.entity';
import type { VideoErrorCode } from '../../src/videos/exceptions/video.exceptions';
import { generatePublicId } from '../../src/videos/public-id';

/*
 * Writes video, session and part states consistent with the plan's Data Model, so a scenario can
 * test only the current route. When the state requires it, the objects are written to the
 * storage of the environment through the internal S3 client: the multipart upload of the session,
 * the parts, the original at `original_key` and the thumbnail at `thumbnail_key`. The keys follow
 * the real layout (`originals/{videoId}/{sessionId}`, `thumbnails/{videoId}/{attemptId}.jpg`);
 * call `removeVideoStorage` for each seeded video in the cleanup of the suite.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_MS = 5 * 60 * 1000;

export interface VideoFixtureContext {
  dataSource: DataSource;
  s3: S3Client;
  bucket: string;
}

/** Context with the internal S3 client of `.env`; close it with `closeVideoFixtureContext`. */
export function createVideoFixtureContext(
  dataSource: DataSource,
): VideoFixtureContext {
  const config = storageConfig();
  return {
    dataSource,
    s3: createStorageClient(config, config.endpoint),
    bucket: config.bucket,
  };
}

export function closeVideoFixtureContext(context: VideoFixtureContext): void {
  context.s3.destroy();
}

/** Upload plan of a session, as P1 computes it (`part_count` and `expected_size`). */
export function partPlan(
  sizeBytes: number,
  partSize: number = VIDEO_DEFAULTS.UPLOAD_PART_SIZE_BYTES,
): { partCount: number; expectedSize: (partNumber: number) => number } {
  return {
    partCount: Math.max(1, Math.ceil(sizeBytes / partSize)),
    expectedSize: (partNumber) =>
      Math.min(partSize, sizeBytes - (partNumber - 1) * partSize),
  };
}

// ---- draft videos and sessions ----

export interface SeedSessionOptions {
  status?: UploadSessionStatus;
  partSize?: number;
  /** Absolute expiry; defaults to the claim deadline for `initiating`, otherwise 24 h ahead. */
  expiresAt?: Date;
  /** Claim deadline of `initiating`, `completing` and `aborting`; defaults to 5 min ahead. */
  claimExpiresAt?: Date;
  fileMismatchAt?: Date | null;
  /**
   * Creates the multipart upload in the storage, with SHA-256 checksums. Default: true for
   * `active`, `completing` and `aborting`. Without it, `upload_id` is null, as in a session that
   * never left `initiating`.
   */
  multipart?: boolean;
}

export interface SeedDraftVideoOptions {
  channelId: string;
  sizeBytes?: number;
  contentType?: string;
  originalFilename?: string;
  /** Current session of the video; without it, the video has none. */
  session?: SeedSessionOptions;
}

/** Video in `draft`, optionally with its current session in the requested state. */
export async function seedDraftVideo(
  context: VideoFixtureContext,
  options: SeedDraftVideoOptions,
): Promise<{ video: Video; session: UploadSession | null }> {
  const videos = context.dataSource.getRepository(Video);
  const video = await videos.save(
    videos.create({
      public_id: generatePublicId(),
      channel_id: options.channelId,
      status: VideoStatus.DRAFT,
      original_filename: options.originalFilename ?? 'video.mp4',
      content_type: options.contentType ?? 'video/mp4',
      size_bytes: options.sizeBytes ?? 1_048_576,
    }),
  );
  if (!options.session) {
    return { video, session: null };
  }
  const session = await seedUploadSession(context, video, options.session);
  await setCurrentSession(context, video, session);
  return { video, session };
}

/** A session of `video`, current or not, with the fields its state requires. */
export async function seedUploadSession(
  context: VideoFixtureContext,
  video: Video,
  options: SeedSessionOptions = {},
): Promise<UploadSession> {
  const status = options.status ?? UploadSessionStatus.ACTIVE;
  const partSize = options.partSize ?? VIDEO_DEFAULTS.UPLOAD_PART_SIZE_BYTES;
  const id = randomUUID();
  const objectKey = `originals/${video.id}/${id}`;
  const claimed = [
    UploadSessionStatus.INITIATING,
    UploadSessionStatus.COMPLETING,
    UploadSessionStatus.ABORTING,
  ].includes(status);
  const claimExpiresAt = claimed
    ? (options.claimExpiresAt ?? new Date(Date.now() + CLAIM_MS))
    : null;
  const withMultipart =
    options.multipart ??
    [
      UploadSessionStatus.ACTIVE,
      UploadSessionStatus.COMPLETING,
      UploadSessionStatus.ABORTING,
    ].includes(status);
  const uploadId = withMultipart
    ? await createMultipart(context, objectKey, video.content_type)
    : null;
  const defaultExpiry =
    status === UploadSessionStatus.INITIATING && claimExpiresAt
      ? claimExpiresAt
      : new Date(Date.now() + DAY_MS);

  const sessions = context.dataSource.getRepository(UploadSession);
  return sessions.save(
    sessions.create({
      id,
      video_id: video.id,
      object_key: objectKey,
      upload_id: uploadId,
      status,
      size_bytes: video.size_bytes,
      part_size: partSize,
      part_count: partPlan(video.size_bytes, partSize).partCount,
      expires_at: options.expiresAt ?? defaultExpiry,
      claim_token: claimed ? randomUUID() : null,
      claim_expires_at: claimExpiresAt,
      file_mismatch_at: options.fileMismatchAt ?? null,
    }),
  );
}

/**
 * Blocks a session as a failed file verification leaves it (F-11): `file_mismatch_at` recorded by
 * the clock of the database, nothing else changed.
 */
export async function blockSessionByFileMismatch(
  context: VideoFixtureContext,
  sessionId: string,
): Promise<void> {
  await context.dataSource
    .getRepository(UploadSession)
    .update({ id: sessionId }, { file_mismatch_at: () => 'now()' });
}

/**
 * Puts a session in `completing` as the claim of P2 leaves it, as if a completion were in
 * progress: a new `claim_token` and `claim_expires_at` (default: 5 min ahead).
 */
export async function claimSessionForCompletion(
  context: VideoFixtureContext,
  sessionId: string,
  claimExpiresAt: Date = new Date(Date.now() + CLAIM_MS),
): Promise<UploadSession> {
  const sessions = context.dataSource.getRepository(UploadSession);
  await sessions.update(
    { id: sessionId },
    {
      status: UploadSessionStatus.COMPLETING,
      claim_token: randomUUID(),
      claim_expires_at: claimExpiresAt,
    },
  );
  return sessions.findOneByOrFail({ id: sessionId });
}

// ---- parts ----

export interface SeedPartInput {
  partNumber: number;
  /** Declared checksum; defaults to the SHA-256 of `body` when a body is given. */
  checksumSha256?: string;
  /** Uploads these bytes to the multipart upload of the session, which needs `upload_id`. */
  body?: Buffer;
  /** Registered ETag: `true` stores the ETag returned by the upload; a string is stored as is. */
  etag?: string | true | null;
}

/** Registers parts as the signing and the ETag batch do, uploading their bytes when given. */
export async function seedUploadParts(
  context: VideoFixtureContext,
  session: UploadSession,
  parts: SeedPartInput[],
): Promise<UploadPart[]> {
  const plan = partPlan(session.size_bytes, session.part_size);
  const repository = context.dataSource.getRepository(UploadPart);
  const saved: UploadPart[] = [];
  for (const part of parts) {
    const checksum =
      part.checksumSha256 ?? (part.body ? sha256Base64(part.body) : undefined);
    if (!checksum) {
      throw new Error(`Part ${part.partNumber} needs a checksum or a body`);
    }
    const uploadedEtag = part.body
      ? await uploadPart(context, session, part.partNumber, part.body, checksum)
      : null;
    const etag = part.etag === true ? uploadedEtag : (part.etag ?? null);
    saved.push(
      await repository.save(
        repository.create({
          upload_session_id: session.id,
          part_number: part.partNumber,
          expected_size: plan.expectedSize(part.partNumber),
          checksum_sha256: checksum,
          etag,
          etag_registered_at: etag ? new Date() : null,
        }),
      ),
    );
  }
  return saved;
}

// ---- processed videos ----

export interface SeedProcessedVideoOptions {
  channelId: string;
  /** Bytes of the original, completed by a real multipart upload at `original_key`. */
  original: Buffer;
  contentType?: string;
  originalFilename?: string;
}

/** Video after the T2 of P2 and the R3 of `publish`: `processing`, run 1, generation 1. */
export async function seedProcessingVideo(
  context: VideoFixtureContext,
  options: SeedProcessedVideoOptions,
): Promise<{ video: Video; session: UploadSession }> {
  const { video, session } = await seedCompletedUpload(context, options);
  await context.dataSource.getRepository(Video).update(
    { id: video.id },
    {
      status: VideoStatus.PROCESSING,
      original_key: session.object_key,
      processing_run: 1,
      processing_started_at: new Date(),
      processing_dispatch: 1,
    },
  );
  return { video: await reloadVideo(context, video.id), session };
}

export type VideoMediaMetadata = Pick<
  Video,
  | 'duration_seconds'
  | 'width'
  | 'height'
  | 'media_format'
  | 'video_codec'
  | 'audio_codec'
>;

export interface SeedReadyVideoOptions extends SeedProcessedVideoOptions {
  /** Bytes of the thumbnail, written at `thumbnail_key`. */
  thumbnail: Buffer;
  metadata?: Partial<VideoMediaMetadata>;
}

/** Video published by the current attempt of run 1, generation 1 (P3), with both objects. */
export async function seedReadyVideo(
  context: VideoFixtureContext,
  options: SeedReadyVideoOptions,
): Promise<{ video: Video; session: UploadSession }> {
  const { video, session } = await seedProcessingVideo(context, options);
  const attemptId = randomUUID();
  const thumbnailKey = `thumbnails/${video.id}/${attemptId}.jpg`;
  await context.s3.send(
    new PutObjectCommand({
      Bucket: context.bucket,
      Key: thumbnailKey,
      Body: options.thumbnail,
      ContentLength: options.thumbnail.length,
      ContentType: 'image/jpeg',
    }),
  );
  await context.dataSource.getRepository(Video).update(
    { id: video.id },
    {
      status: VideoStatus.READY,
      current_attempt_id: attemptId,
      attempt_fence_dispatch: 1,
      attempt_fence_seq: 1,
      thumbnail_key: thumbnailKey,
      ...defaultMetadata(video.content_type),
      ...options.metadata,
    },
  );
  return { video: await reloadVideo(context, video.id), session };
}

/** Video closed in `error` by the current attempt of run 1, generation 1. */
export async function seedErrorVideo(
  context: VideoFixtureContext,
  options: SeedProcessedVideoOptions & {
    errorCode: VideoErrorCode;
    errorMessage?: string;
  },
): Promise<{ video: Video; session: UploadSession }> {
  const { video, session } = await seedProcessingVideo(context, options);
  await context.dataSource.getRepository(Video).update(
    { id: video.id },
    {
      status: VideoStatus.ERROR,
      current_attempt_id: randomUUID(),
      attempt_fence_dispatch: 1,
      attempt_fence_seq: 1,
      error_code: options.errorCode,
      error_message: options.errorMessage ?? options.errorCode,
    },
  );
  return { video: await reloadVideo(context, video.id), session };
}

// ---- storage cleanup ----

/**
 * Aborts the multipart uploads and deletes the objects of a video, under `originals/{videoId}/`
 * and `thumbnails/{videoId}/`.
 */
export async function removeVideoStorage(
  context: VideoFixtureContext,
  videoId: string,
): Promise<void> {
  for (const prefix of [`originals/${videoId}/`, `thumbnails/${videoId}/`]) {
    for (const upload of await listUploadsUnder(
      context.s3,
      context.bucket,
      prefix,
    )) {
      await context.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: context.bucket,
          Key: upload.key,
          UploadId: upload.uploadId,
        }),
      );
    }
    for (const key of await listKeysUnder(context.s3, context.bucket, prefix)) {
      await context.s3.send(
        new DeleteObjectCommand({ Bucket: context.bucket, Key: key }),
      );
    }
  }
}

// ---- internals ----

/** Draft video whose current session completed: one part, completed multipart, part registered. */
async function seedCompletedUpload(
  context: VideoFixtureContext,
  options: SeedProcessedVideoOptions,
): Promise<{ video: Video; session: UploadSession }> {
  const { video, session } = await seedDraftVideo(context, {
    channelId: options.channelId,
    sizeBytes: options.original.length,
    contentType: options.contentType,
    originalFilename: options.originalFilename,
    session: { status: UploadSessionStatus.ACTIVE },
  });
  if (!session?.upload_id) {
    throw new Error('The active session of the fixture has no upload_id');
  }
  const [part] = await seedUploadParts(context, session, [
    { partNumber: 1, body: options.original, etag: true },
  ]);
  await context.s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: context.bucket,
      Key: session.object_key,
      UploadId: session.upload_id,
      MultipartUpload: {
        Parts: [
          {
            PartNumber: 1,
            ETag: part.etag ?? undefined,
            ChecksumSHA256: part.checksum_sha256,
          },
        ],
      },
    }),
  );
  const sessions = context.dataSource.getRepository(UploadSession);
  await sessions.update(
    { id: session.id },
    { status: UploadSessionStatus.COMPLETED },
  );
  return {
    video,
    session: await sessions.findOneByOrFail({ id: session.id }),
  };
}

async function setCurrentSession(
  context: VideoFixtureContext,
  video: Video,
  session: UploadSession,
): Promise<void> {
  await context.dataSource
    .getRepository(Video)
    .update({ id: video.id }, { current_upload_session_id: session.id });
  video.current_upload_session_id = session.id;
}

async function createMultipart(
  context: VideoFixtureContext,
  key: string,
  contentType: string,
): Promise<string> {
  const output = await context.s3.send(
    new CreateMultipartUploadCommand({
      Bucket: context.bucket,
      Key: key,
      ContentType: contentType,
      ChecksumAlgorithm: 'SHA256',
    }),
  );
  if (!output.UploadId) {
    throw new Error('CreateMultipartUpload returned no UploadId');
  }
  return output.UploadId;
}

async function uploadPart(
  context: VideoFixtureContext,
  session: UploadSession,
  partNumber: number,
  body: Buffer,
  checksumSha256: string,
): Promise<string | null> {
  if (!session.upload_id) {
    throw new Error('Uploading a part needs a session with upload_id');
  }
  const output = await context.s3.send(
    new UploadPartCommand({
      Bucket: context.bucket,
      Key: session.object_key,
      UploadId: session.upload_id,
      PartNumber: partNumber,
      Body: body,
      ContentLength: body.length,
      ChecksumSHA256: checksumSha256,
    }),
  );
  return output.ETag ?? null;
}

function defaultMetadata(contentType: string): VideoMediaMetadata {
  return contentType === 'video/webm'
    ? {
        duration_seconds: '4.000',
        width: 320,
        height: 240,
        media_format: 'matroska,webm',
        video_codec: 'vp9',
        audio_codec: 'opus',
      }
    : {
        duration_seconds: '4.000',
        width: 320,
        height: 240,
        media_format: 'mov,mp4,m4a,3gp,3g2,mj2',
        video_codec: 'h264',
        audio_codec: 'aac',
      };
}

async function reloadVideo(
  context: VideoFixtureContext,
  videoId: string,
): Promise<Video> {
  return context.dataSource
    .getRepository(Video)
    .findOneByOrFail({ id: videoId });
}
