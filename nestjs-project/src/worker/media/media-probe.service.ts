import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../../config/queue.config';
import { StorageService } from '../../storage/storage.service';
import {
  FFMPEG_NETWORK_ARGS,
  MEDIA_URL_TTL_MARGIN_SECONDS,
} from './media.constants';
import { MediaRejectedError, type MediaTransientError } from './media.errors';
import {
  classifyFailure,
  evaluateMedia,
  isJpeg,
  type MediaMetadata,
  parseFfprobeOutput,
} from './media-probe.rules';
import {
  type MediaProcessResult,
  MediaProcessRunner,
} from './media-process.runner';

/**
 * ffprobe and ffmpeg over the internal presigned URL of the original, read by HTTP Range without
 * downloading it (TD-10, TD-11; V-04). Every call has the network options of V-04 and the per-call
 * timeout `VIDEO_PROCESSING_TIMEOUT_MS`, which kills the process (G-09).
 *
 * Outcomes: the metadata or the JPEG; `MediaRejectedError` for a media refused by the "Error
 * Catalog" (permanent); `MediaTransientError` for network, storage, timeout or a failure without a
 * media cause. No message carries the signed query of the URL.
 */
@Injectable()
export class MediaProbeService {
  private readonly logger = new Logger(MediaProbeService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly runner: MediaProcessRunner,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * `ffprobe -print_format json -show_format -show_streams` on the object `key`, validated
   * against the declared `contentType`: video stream, container and codecs (TD-13; Q-03).
   */
  async probe(key: string, contentType: string): Promise<MediaMetadata> {
    const url = await this.internalUrl(key);
    const result = await this.runner.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        ...FFMPEG_NETWORK_ARGS,
        url,
      ],
      this.config.videoProcessing.timeoutMs,
    );
    if (result.timedOut || result.code !== 0) {
      throw this.failure(result, 'ffprobe', key);
    }
    const output = parseFfprobeOutput(result.stdout);
    if (!output) {
      throw this.failure(
        { ...result, stderr: `${result.stderr}\nno JSON on stdout` },
        'ffprobe',
        key,
      );
    }
    return evaluateMedia(output, contentType);
  }

  /**
   * One frame of the object `key` at `atSeconds`, as a JPEG buffer. `-ss` comes before `-i`, so
   * ffmpeg seeks by the index of the file, by Range, instead of decoding from the start (TD-11).
   */
  async extractFrame(key: string, atSeconds: number): Promise<Buffer> {
    if (!Number.isFinite(atSeconds) || atSeconds < 0) {
      throw new RangeError(
        `atSeconds must be a non-negative number: ${atSeconds}`,
      );
    }
    const url = await this.internalUrl(key);
    const result = await this.runner.run(
      'ffmpeg',
      [
        '-hide_banner',
        '-v',
        'error',
        '-nostdin',
        ...FFMPEG_NETWORK_ARGS,
        '-ss',
        String(atSeconds),
        '-i',
        url,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      this.config.videoProcessing.timeoutMs,
    );
    if (result.timedOut || result.code !== 0) {
      throw this.failure(result, 'ffmpeg', key);
    }
    if (!isJpeg(result.stdout)) {
      throw new MediaRejectedError(
        'MEDIA_INVALID',
        `no frame decoded at ${atSeconds} s`,
      );
    }
    return result.stdout;
  }

  /** Valid for the whole call, reconnections included. */
  private async internalUrl(key: string): Promise<string> {
    const { url } = await this.storage.presignGet({
      key,
      audience: 'internal',
      expiresInSeconds:
        Math.ceil(this.config.videoProcessing.timeoutMs / 1000) +
        MEDIA_URL_TTL_MARGIN_SECONDS,
    });
    return url;
  }

  private failure(
    result: MediaProcessResult,
    operation: string,
    key: string,
  ): MediaRejectedError | MediaTransientError {
    const error = classifyFailure(result, operation);
    const kind =
      error instanceof MediaRejectedError ? error.code : 'transient failure';
    this.logger.warn(`${operation} of ${key}: ${kind}: ${error.reason}`);
    return error;
  }
}
