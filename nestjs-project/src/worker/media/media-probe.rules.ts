import { ACCEPTED_MEDIA, MOV_MAJOR_BRAND } from './media.constants';
import { MediaRejectedError, MediaTransientError } from './media.errors';
import type { MediaProcessResult } from './media-process.runner';

/** The part of `ffprobe -print_format json -show_format -show_streams` the rules read. */
export interface FfprobeOutput {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
  format?: {
    format_name?: string;
    duration?: string;
    tags?: { major_brand?: string };
  };
}

/** Metadata of an accepted video, as `videos` stores it (Data Model). */
export interface MediaMetadata {
  durationSeconds: number | null;
  width: number;
  height: number;
  /** `format_name` of ffprobe, stored in `media_format`. */
  mediaFormat: string;
  videoCodec: string;
  audioCodec: string | null;
}

/**
 * Evidence of a failed transport. It prevails over the parsing messages, which may only be the
 * consequence of an interrupted read ("moov atom not found" after a truncated body). The early
 * closes of the Range reads, made by FFmpeg itself, produce none of them (V-04, review of
 * 2026-11-18).
 */
const TRANSPORT_ERRORS: readonly RegExp[] = [
  /Connection timed out/,
  /Connection refused/,
  /Connection reset by peer/,
  /Broken pipe/,
  /Network is unreachable/,
  // FFmpeg writes the code ("Server returned 404 Not Found") or the class ("Server returned 5XX").
  /Server returned (?:[45]\d\d|[45]XX)/,
  /Input\/output error/,
  /Stream ends prematurely/,
];

/** Messages of the demuxer that a file which is not a readable video produces. */
const MEDIA_PARSE_ERRORS: readonly RegExp[] = [
  /Invalid data found when processing input/,
  /moov atom not found/,
];

/**
 * A URL and its query. The values of a presigned query are URL-encoded (`:` is `%3A`), so the
 * query ends at whitespace, at a quote or at the `:` that FFmpeg writes after the URL.
 */
const SIGNED_URL_QUERY = /(https?:\/\/[^\s?'"]+)\?[^\s'":]*/g;

/**
 * Removes the query of every URL in an FFmpeg message: the presigned URL carries the signature,
 * which must not reach the logs nor `videos.error_message` (V-04, "Para a implementação").
 */
export function redactSignedUrls(text: string): string {
  return text.replace(SIGNED_URL_QUERY, '$1');
}

/** The relevant lines of the stderr, without the signed queries, for causes and logs. */
export function describeStderr(stderr: string): string {
  return redactSignedUrls(stderr.trim()).replace(/\s*\n\s*/g, ' | ');
}

/**
 * Classifies a failed run of ffprobe or ffmpeg (V-04):
 * - killed by the per-call timeout, or with any evidence of transport → transient;
 * - a demuxer message without evidence of transport → `MEDIA_INVALID`;
 * - any other failure → transient: it is never taken as a validation of the media, and the
 *   processing retries it.
 */
export function classifyFailure(
  result: MediaProcessResult,
  operation: string,
): MediaRejectedError | MediaTransientError {
  if (result.timedOut) {
    return new MediaTransientError(
      `${operation} killed by the per-call timeout after ${result.durationMs} ms`,
    );
  }
  const cause = describeStderr(result.stderr);
  if (TRANSPORT_ERRORS.some((pattern) => pattern.test(result.stderr))) {
    return new MediaTransientError(
      `${operation} could not read the media: ${cause}`,
    );
  }
  if (MEDIA_PARSE_ERRORS.some((pattern) => pattern.test(result.stderr))) {
    return new MediaRejectedError('MEDIA_INVALID', cause);
  }
  return new MediaTransientError(
    `${operation} failed without a media cause (exit ${result.code ?? result.signal}): ${cause || 'no output'}`,
  );
}

/** The JSON of a successful ffprobe, or `null` when stdout is not a JSON object. */
export function parseFfprobeOutput(stdout: Buffer): FfprobeOutput | null {
  try {
    const parsed: unknown = JSON.parse(stdout.toString('utf8'));
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as FfprobeOutput)
      : null;
  } catch {
    return null;
  }
}

/**
 * The rules of the "Error Catalog" on a readable file (TD-11, TD-13; Q-03): a video stream is
 * required; the container must match the declared `content_type` (an MP4 with `major_brand`
 * `qt  ` is a MOV); and every codec must be in the list of that container. Throws the
 * permanent `MediaRejectedError` otherwise.
 */
export function evaluateMedia(
  output: FfprobeOutput,
  contentType: string,
): MediaMetadata {
  const streams = output.streams ?? [];
  const video = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  if (video.length === 0) {
    throw new MediaRejectedError('MEDIA_INVALID', 'no video stream');
  }

  const formatName = output.format?.format_name ?? '';
  const majorBrand = output.format?.tags?.major_brand ?? '';
  const accepted = isAcceptedContentType(contentType)
    ? ACCEPTED_MEDIA[contentType]
    : null;
  if (!accepted) {
    throw new MediaRejectedError(
      'MEDIA_CONTAINER_MISMATCH',
      `content_type ${contentType} is not accepted`,
    );
  }
  if (!formatName.split(',').includes(accepted.formatName)) {
    throw new MediaRejectedError(
      'MEDIA_CONTAINER_MISMATCH',
      `format_name ${formatName} does not match ${contentType}`,
    );
  }
  if (contentType === 'video/mp4' && majorBrand === MOV_MAJOR_BRAND) {
    throw new MediaRejectedError(
      'MEDIA_CONTAINER_MISMATCH',
      `major_brand ${MOV_MAJOR_BRAND} (QuickTime) declared as ${contentType}`,
    );
  }

  const videoCodecs: readonly string[] = accepted.videoCodecs;
  const audioCodecs: readonly string[] = accepted.audioCodecs;
  const unsupported = [
    ...video.filter((stream) => !videoCodecs.includes(stream.codec_name ?? '')),
    ...audio.filter((stream) => !audioCodecs.includes(stream.codec_name ?? '')),
  ];
  if (unsupported.length > 0) {
    throw new MediaRejectedError(
      'MEDIA_UNSUPPORTED_CODEC',
      `codecs ${unsupported.map((stream) => `${stream.codec_type}:${stream.codec_name ?? 'unknown'}`).join(', ')} not accepted in ${contentType}`,
    );
  }

  const [main] = video;
  if (!main.width || !main.height) {
    throw new MediaRejectedError(
      'MEDIA_INVALID',
      'the video stream has no dimensions',
    );
  }
  const duration = Number(output.format?.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : null,
    width: main.width,
    height: main.height,
    mediaFormat: formatName,
    videoCodec: main.codec_name ?? '',
    audioCodec: audio[0]?.codec_name ?? null,
  };
}

/** A JPEG image: the SOI marker at the start and the EOI marker at the end. */
export function isJpeg(data: Buffer): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[data.length - 2] === 0xff &&
    data[data.length - 1] === 0xd9
  );
}

function isAcceptedContentType(
  contentType: string,
): contentType is keyof typeof ACCEPTED_MEDIA {
  return Object.hasOwn(ACCEPTED_MEDIA, contentType);
}
