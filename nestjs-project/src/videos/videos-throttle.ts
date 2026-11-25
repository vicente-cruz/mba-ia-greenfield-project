/**
 * Explicit limit of each route of the phase ("API Contracts → Throttle"), applied with
 * `@Throttle(VIDEOS_THROTTLE.<ROUTE>)`. The key `default` overrides the unnamed global throttler
 * (10 requests every 60 s per IP, phase-02-auth/TD-08), which stays active for the other routes.
 */
const perMinute = (limit: number) => ({
  default: { limit, ttl: 60_000 },
});

export const VIDEOS_THROTTLE = {
  /** POST /videos (SI-03.12). */
  CREATE_VIDEO: perMinute(10),
  /** POST /videos/:publicId/upload-sessions/:sessionId/part-urls (SI-03.13). */
  SIGN_PART_URLS: perMinute(60),
  /** GET /videos/:publicId/upload-sessions/:sessionId (SI-03.14). */
  GET_UPLOAD_SESSION: perMinute(30),
  /** POST /videos/:publicId/upload-sessions/:sessionId/file-verifications (SI-03.15). */
  VERIFY_UPLOAD_FILE: perMinute(10),
  /** POST /videos/:publicId/upload-sessions/:sessionId/completion (SI-03.16). */
  COMPLETE_UPLOAD: perMinute(20),
  /** DELETE /videos/:publicId/upload-sessions/:sessionId (SI-03.17). */
  ABORT_UPLOAD_SESSION: perMinute(10),
  /** POST /videos/:publicId/upload-sessions (SI-03.18). */
  RESTART_UPLOAD_SESSION: perMinute(10),
  /** GET /videos/:publicId (SI-03.19): polling every 2 s, with margin. */
  GET_VIDEO: perMinute(60),
  /** GET /videos/:publicId/playback-url (SI-03.27). */
  GET_PLAYBACK_URL: perMinute(30),
  /** GET /videos/:publicId/download-url (SI-03.28). */
  GET_DOWNLOAD_URL: perMinute(30),
} as const;
