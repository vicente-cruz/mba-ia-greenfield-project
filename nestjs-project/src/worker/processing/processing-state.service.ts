import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository, UpdateQueryBuilder } from 'typeorm';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import type { VideoErrorCode } from '../../videos/exceptions/video.exceptions';
import type { MediaMetadata } from '../media/media-probe.rules';
import type { ProcessingAttempt } from './processing-attempt';

/** What the current attempt needs from the video to process it. */
export interface AssumedVideo {
  originalKey: string;
  contentType: string;
}

/**
 * Transitions of the worker on `videos` under the current attempt of P3 (TD-12). Each one is a
 * single conditional `UPDATE`; zero rows means that another attempt, a recovery of P5 or the end
 * of the execution won, which is an expected outcome and never an internal error.
 */
@Injectable()
export class ProcessingStateService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
  ) {}

  /**
   * Assumes the attempt with the fence of P3: the video in `processing`, in the same execution and
   * generation, and a token (`dispatch`, `seq`) lexicographically greater than the largest one
   * already accepted. The fence only advances. Returns the original to process, or `null` when the
   * delivery is obsolete, the video is terminal or the execution changed (G-08).
   */
  async assume(attempt: ProcessingAttempt): Promise<AssumedVideo | null> {
    const result = await this.videos
      .createQueryBuilder()
      .update(Video)
      .set({
        current_attempt_id: attempt.attemptId,
        attempt_fence_dispatch: attempt.dispatch,
        attempt_fence_seq: attempt.seq,
      })
      .where('id = :videoId', { videoId: attempt.videoId })
      .andWhere('status = :processing', { processing: VideoStatus.PROCESSING })
      .andWhere('processing_run = :run', { run: attempt.run })
      .andWhere('processing_dispatch = :dispatch', {
        dispatch: attempt.dispatch,
      })
      .andWhere(
        '(attempt_fence_dispatch IS NULL' +
          ' OR attempt_fence_dispatch < :dispatch' +
          ' OR (attempt_fence_dispatch = :dispatch AND attempt_fence_seq < :seq))',
        { dispatch: attempt.dispatch, seq: attempt.seq },
      )
      .returning(['original_key', 'content_type'])
      .execute();
    const rows = result.raw as {
      original_key: string | null;
      content_type: string;
    }[];
    if (result.affected !== 1 || rows.length !== 1) {
      return null;
    }
    const [row] = rows;
    if (!row.original_key) {
      // P2 writes `original_key` in the same UPDATE that moves the video to `processing`.
      throw new Error(
        `video ${attempt.videoId} is in processing without original_key`,
      );
    }
    return { originalKey: row.original_key, contentType: row.content_type };
  }

  /**
   * Publishes `ready` with the metadata and the thumbnail of the attempt in the same `UPDATE`,
   * only while the attempt is still the current one. `false` means it lost the attempt.
   */
  async publishReady(
    attempt: ProcessingAttempt,
    metadata: MediaMetadata,
    thumbnailKey: string,
  ): Promise<boolean> {
    const query = this.videos
      .createQueryBuilder()
      .update(Video)
      .set({
        status: VideoStatus.READY,
        duration_seconds:
          metadata.durationSeconds === null
            ? null
            : metadata.durationSeconds.toFixed(3),
        width: metadata.width,
        height: metadata.height,
        media_format: metadata.mediaFormat,
        video_codec: metadata.videoCodec,
        audio_codec: metadata.audioCodec,
        thumbnail_key: thumbnailKey,
        error_code: null,
        error_message: null,
      });
    const result = await this.whileCurrent(query, attempt).execute();
    return result.affected === 1;
  }

  /**
   * Ends the execution in `error` with the cause, under the same guard as `ready`. `false` means it
   * lost the attempt, and nothing was written.
   */
  async recordError(
    attempt: ProcessingAttempt,
    code: VideoErrorCode,
    message: string,
  ): Promise<boolean> {
    const query = this.videos.createQueryBuilder().update(Video).set({
      status: VideoStatus.ERROR,
      error_code: code,
      error_message: message,
    });
    const result = await this.whileCurrent(query, attempt).execute();
    return result.affected === 1;
  }

  /** Publication guard of P3: the attempt is still valid and current. */
  private whileCurrent(
    query: UpdateQueryBuilder<Video>,
    attempt: ProcessingAttempt,
  ): UpdateQueryBuilder<Video> {
    return query
      .where('id = :videoId', { videoId: attempt.videoId })
      .andWhere('status = :processing', { processing: VideoStatus.PROCESSING })
      .andWhere('processing_run = :run', { run: attempt.run })
      .andWhere('processing_dispatch = :dispatch', {
        dispatch: attempt.dispatch,
      })
      .andWhere('current_attempt_id = :attemptId', {
        attemptId: attempt.attemptId,
      });
  }
}
