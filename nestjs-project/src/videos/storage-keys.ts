/**
 * Key of the original of a session (TD-02, TD-06): exclusive to the session and never reused, so
 * every upload session writes to its own key.
 */
export function originalObjectKey(videoId: string, sessionId: string): string {
  return `originals/${videoId}/${sessionId}`;
}

/**
 * Key of the thumbnail of a worker attempt (TD-06, TD-12; P3): exclusive to the attempt, so
 * concurrent or repeated attempts never write to the same key, and only the current attempt
 * publishes its own key as `thumbnail_key`.
 */
export function thumbnailObjectKey(videoId: string, attemptId: string): string {
  return `thumbnails/${videoId}/${attemptId}.jpg`;
}

/** Prefixes of the bucket walked by the cleanup of P4 (TD-06). */
export const ORIGINALS_PREFIX = 'originals/';
export const THUMBNAILS_PREFIX = 'thumbnails/';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ORIGINAL_KEY = new RegExp(`^originals/(${UUID})/(${UUID})$`);
const THUMBNAIL_KEY = new RegExp(`^thumbnails/(${UUID})/(${UUID})\\.jpg$`);

/** Inverse of `originalObjectKey`; `null` for any key that it would not produce. */
export function parseOriginalObjectKey(
  key: string,
): { videoId: string; sessionId: string } | null {
  const match = ORIGINAL_KEY.exec(key);
  return match ? { videoId: match[1], sessionId: match[2] } : null;
}

/** Inverse of `thumbnailObjectKey`; `null` for any key that it would not produce. */
export function parseThumbnailObjectKey(
  key: string,
): { videoId: string; attemptId: string } | null {
  const match = THUMBNAIL_KEY.exec(key);
  return match ? { videoId: match[1], attemptId: match[2] } : null;
}
