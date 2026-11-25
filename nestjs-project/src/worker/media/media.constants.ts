/**
 * Network options of ffprobe and ffmpeg over the internal presigned URL, the values adopted by
 * V-04 for FFmpeg 5.1.9 (G-09):
 * - `-rw_timeout 10000000`: 10 s without progress in an I/O operation;
 * - `-reconnect 1 -reconnect_on_network_error 1 -reconnect_delay_max 4`: up to 4 connections,
 *   waiting 0, 1 and 3 s. Without `-reconnect_delay_max`, the default of 5.1 (120 s) keeps the
 *   process reconnecting for minutes.
 * Against a storage that accepts the connection and sends no bytes, the process ends by itself in
 * about 44 s (measured 44.6 s), below the per-call timeout (`VIDEO_PROCESSING_TIMEOUT_MS`, 60 s).
 */
export const FFMPEG_NETWORK_ARGS: readonly string[] = [
  '-rw_timeout',
  '10000000',
  '-reconnect',
  '1',
  '-reconnect_on_network_error',
  '1',
  '-reconnect_delay_max',
  '4',
];

/**
 * Validity of the internal presigned URL beyond the per-call timeout: the URL must stay valid for
 * every Range request of the call, including the reconnections.
 */
export const MEDIA_URL_TTL_MARGIN_SECONDS = 60;

/** Accepted containers and codecs ("Error Catalog → MEDIA_UNSUPPORTED_CODEC"; Q-03, TD-13). */
export const ACCEPTED_MEDIA = {
  'video/mp4': {
    /** `format_name` of ffprobe for the ISO BMFF family. MOV shares it; see `MOV_MAJOR_BRAND`. */
    formatName: 'mp4',
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
  },
  'video/webm': {
    formatName: 'webm',
    videoCodecs: ['vp8', 'vp9', 'av1'],
    audioCodecs: ['vorbis', 'opus'],
  },
} as const satisfies Record<
  string,
  {
    formatName: string;
    videoCodecs: readonly string[];
    audioCodecs: readonly string[];
  }
>;

/** `major_brand` of a QuickTime file: an MP4 declaration with it is a MOV, refused (Q-03). */
export const MOV_MAJOR_BRAND = 'qt  ';
