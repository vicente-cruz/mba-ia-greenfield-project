import type { VideoErrorCode } from '../../videos/exceptions/video.exceptions';

/** Permanent outcomes of the media validation ("Error Catalog"): the processing is not retried. */
export type MediaRejectionCode = Extract<
  VideoErrorCode,
  'MEDIA_INVALID' | 'MEDIA_CONTAINER_MISMATCH' | 'MEDIA_UNSUPPORTED_CODEC'
>;

/**
 * The media itself is refused: the file is not a readable video, its container does not match the
 * declared type, or a codec is not accepted. Retrying gives the same result.
 */
export class MediaRejectedError extends Error {
  constructor(
    readonly code: MediaRejectionCode,
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = 'MediaRejectedError';
  }
}

/**
 * The media could not be read this time: network, storage, the per-call timeout, or a failure
 * without a media cause. A new attempt may succeed. The reason carries no signed URL.
 */
export class MediaTransientError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'MediaTransientError';
  }
}
