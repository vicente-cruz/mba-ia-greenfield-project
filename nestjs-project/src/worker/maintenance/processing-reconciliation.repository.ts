import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository, type UpdateQueryBuilder } from 'typeorm';
import {
  Video,
  VideoPendingJobAction,
  VideoStatus,
} from '../../videos/entities/video.entity';
import { NOW_PLUS_SECONDS } from '../../videos/upload-sessions.repository';
import type {
  ClosingCode,
  ProcessingSnapshot,
} from './processing-reconciliation.decisions';

interface SnapshotRow {
  id: string;
  processing_run: number;
  processing_dispatch: number;
  processing_recoveries: number;
  current_attempt_id: string | null;
  attempt_fence_dispatch: number | null;
  attempt_fence_seq: number | null;
  pending_job_action: VideoPendingJobAction | null;
  pending_job_dispatch: number | null;
  pending_job_token: string | null;
  pending_expired: boolean;
  sort_at: string;
}

/**
 * Position of the batches of the reconciliation: the sort key of the last video read, kept as the
 * text of the database so the next page starts exactly after it (microseconds included).
 */
export interface SnapshotCursor {
  sortAt: string;
  id: string;
}

export interface SnapshotPage {
  snapshots: ProcessingSnapshot[];
  /** Position of the last video of the page, `null` when the page is empty. */
  last: SnapshotCursor | null;
}

/** Start of the execution, the order of the batches (P2 always records it in `processing`). */
const SORT_AT = 'COALESCE(video.processing_started_at, video.created_at)';

/** What the collection of jobs reads of a video (P5, "Retenção e coleta de jobs"). */
export interface CollectionFacts {
  status: VideoStatus;
  run: number;
  dispatch: number;
}

/**
 * The writes of the reconciliation (P5) on `videos`. Each one is a single conditional `UPDATE`
 * guarded by the retrato that the decision used (G_R or G_P). Zero rows means that the retrato is
 * stale: the caller discards it together with its observation of the queue.
 */
@Injectable()
export class ProcessingReconciliationRepository {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
  ) {}

  /**
   * Step 1 of P5, in a batch: videos in `processing` past the grace of the reconciliation, or with
   * an expired pending action, oldest execution first and, with `after`, only those after that
   * position. The caller moves the position, so videos that must stay untouched do not hold the
   * following ones out of every batch.
   */
  async findSnapshots(
    batchSize: number,
    graceMs: number,
    after: SnapshotCursor | null = null,
  ): Promise<SnapshotPage> {
    const query = this.videos
      .createQueryBuilder('video')
      .select('video.id', 'id')
      .addSelect('video.processing_run', 'processing_run')
      .addSelect('video.processing_dispatch', 'processing_dispatch')
      .addSelect('video.processing_recoveries', 'processing_recoveries')
      .addSelect('video.current_attempt_id', 'current_attempt_id')
      .addSelect('video.attempt_fence_dispatch', 'attempt_fence_dispatch')
      .addSelect('video.attempt_fence_seq', 'attempt_fence_seq')
      .addSelect('video.pending_job_action', 'pending_job_action')
      .addSelect('video.pending_job_dispatch', 'pending_job_dispatch')
      .addSelect('video.pending_job_token', 'pending_job_token')
      .addSelect(
        'COALESCE(video.pending_job_expires_at < now(), false)',
        'pending_expired',
      )
      .addSelect(`CAST(${SORT_AT} AS text)`, 'sort_at')
      .where('video.status = :processing', {
        processing: VideoStatus.PROCESSING,
      })
      .andWhere(
        "(video.processing_started_at <= now() - (:graceMs * interval '1 millisecond')" +
          ' OR (video.pending_job_action IS NOT NULL AND video.pending_job_expires_at < now()))',
        { graceMs },
      );
    if (after) {
      query.andWhere(
        `(${SORT_AT}, video.id) > (CAST(:afterSortAt AS timestamptz), CAST(:afterId AS uuid))`,
        { afterSortAt: after.sortAt, afterId: after.id },
      );
    }
    const rows = await query
      .orderBy(SORT_AT, 'ASC')
      .addOrderBy('video.id', 'ASC')
      .limit(batchSize)
      .getRawMany<SnapshotRow>();
    const snapshots = rows.map((row) => ({
      videoId: row.id,
      run: row.processing_run,
      dispatch: row.processing_dispatch,
      recoveries: row.processing_recoveries,
      attemptId: row.current_attempt_id,
      fenceDispatch: row.attempt_fence_dispatch,
      fenceSeq: row.attempt_fence_seq,
      pendingAction: row.pending_job_action,
      pendingDispatch: row.pending_job_dispatch,
      pendingToken: row.pending_job_token,
      pendingExpired: row.pending_expired,
    }));
    const lastRow = rows.at(-1);
    return {
      snapshots,
      last: lastRow ? { sortAt: lastRow.sort_at, id: lastRow.id } : null,
    };
  }

  /**
   * R1 with G_R: one write reserves the next generation, counts the recovery, revokes the current
   * attempt and records the `republish` action with its token and deadline. The limit is checked
   * in the write itself. Returns the reserved generation, or `null` for zero rows.
   */
  async reserveGeneration(
    snapshot: ProcessingSnapshot,
    token: string,
    actionTtlSeconds: number,
    maxRecoveries: number,
  ): Promise<number | null> {
    const query = this.videos
      .createQueryBuilder()
      .update(Video)
      .set({
        processing_recoveries: () => 'processing_recoveries + 1',
        processing_dispatch: () => 'processing_dispatch + 1',
        current_attempt_id: null,
        pending_job_action: VideoPendingJobAction.REPUBLISH,
        // The SET of PostgreSQL reads the previous values of the row.
        pending_job_dispatch: () => 'processing_dispatch + 1',
        pending_job_token: token,
        pending_job_expires_at: () => NOW_PLUS_SECONDS('actionTtlSeconds'),
      });
    const result = await this.withRetratoGuard(query, snapshot)
      .andWhere('processing_recoveries < :maxRecoveries', { maxRecoveries })
      .setParameter('actionTtlSeconds', actionTtlSeconds)
      .returning(['pending_job_dispatch'])
      .execute();
    const rows = result.raw as { pending_job_dispatch: number }[];
    return result.affected === 1 && rows.length === 1
      ? rows[0].pending_job_dispatch
      : null;
  }

  /**
   * Closes the execution in `error` with G_R. For a `failed` job, the fence of the retrato must
   * not be ahead of the job: `(attempt_fence_dispatch, attempt_fence_seq) <= (g, attemptsStarted)`.
   * `true` only when the `RETURNING` shows the terminal row, which confirms the collection.
   */
  async closeInError(
    snapshot: ProcessingSnapshot,
    code: ClosingCode,
    message: string,
    failedJob: { dispatch: number; attemptsStarted: number } | null,
  ): Promise<boolean> {
    const query = this.withRetratoGuard(
      this.videos.createQueryBuilder().update(Video).set({
        status: VideoStatus.ERROR,
        error_code: code,
        error_message: message,
      }),
      snapshot,
    );
    if (failedJob) {
      query.andWhere(
        '(attempt_fence_dispatch IS NULL' +
          ' OR (attempt_fence_dispatch, attempt_fence_seq) <= (:jobDispatch, :jobAttemptsStarted))',
        {
          jobDispatch: failedJob.dispatch,
          jobAttemptsStarted: failedJob.attemptsStarted,
        },
      );
    }
    const result = await query
      .returning(['status', 'processing_run'])
      .execute();
    const rows = result.raw as {
      status: VideoStatus;
      processing_run: number;
    }[];
    return (
      result.affected === 1 &&
      rows.length === 1 &&
      rows[0].status === VideoStatus.ERROR &&
      rows[0].processing_run === snapshot.run
    );
  }

  /**
   * Takes over an expired pending action with G_P and the old token: a new token and deadline,
   * the same reserved generation. `false` for zero rows.
   */
  async takeOverAction(
    snapshot: ProcessingSnapshot,
    newToken: string,
    actionTtlSeconds: number,
  ): Promise<boolean> {
    const query = this.videos
      .createQueryBuilder()
      .update(Video)
      .set({
        pending_job_token: newToken,
        pending_job_expires_at: () => NOW_PLUS_SECONDS('actionTtlSeconds'),
      });
    const result = await this.withPendingGuard(query, snapshot)
      .andWhere('pending_job_expires_at < now()')
      .setParameter('actionTtlSeconds', actionTtlSeconds)
      .execute();
    return result.affected === 1;
  }

  /** The facts of the collection for the videos of a batch of finished jobs. */
  async collectionFacts(
    videoIds: string[],
  ): Promise<Map<string, CollectionFacts>> {
    if (videoIds.length === 0) {
      return new Map();
    }
    const videos = await this.videos.find({
      select: ['id', 'status', 'processing_run', 'processing_dispatch'],
      where: { id: In(videoIds) },
    });
    return new Map(
      videos.map((video) => [
        video.id,
        {
          status: video.status,
          run: video.processing_run,
          dispatch: video.processing_dispatch,
        },
      ]),
    );
  }

  /** G_R: the retrato without a pending action. */
  private withRetratoGuard(
    query: UpdateQueryBuilder<Video>,
    snapshot: ProcessingSnapshot,
  ): UpdateQueryBuilder<Video> {
    return query
      .where('id = :videoId', { videoId: snapshot.videoId })
      .andWhere('status = :processing', { processing: VideoStatus.PROCESSING })
      .andWhere('processing_run = :run', { run: snapshot.run })
      .andWhere('processing_dispatch = :dispatch', {
        dispatch: snapshot.dispatch,
      })
      .andWhere('processing_recoveries = :recoveries', {
        recoveries: snapshot.recoveries,
      })
      .andWhere('pending_job_action IS NULL')
      .andWhere('current_attempt_id IS NOT DISTINCT FROM :attemptId', {
        attemptId: snapshot.attemptId,
      })
      .andWhere('attempt_fence_dispatch IS NOT DISTINCT FROM :fenceDispatch', {
        fenceDispatch: snapshot.fenceDispatch,
      })
      .andWhere('attempt_fence_seq IS NOT DISTINCT FROM :fenceSeq', {
        fenceSeq: snapshot.fenceSeq,
      });
  }

  /** G_P: the retrato with a pending action, by its token and its reserved generation. */
  private withPendingGuard(
    query: UpdateQueryBuilder<Video>,
    snapshot: ProcessingSnapshot,
  ): UpdateQueryBuilder<Video> {
    return query
      .where('id = :videoId', { videoId: snapshot.videoId })
      .andWhere('status = :processing', { processing: VideoStatus.PROCESSING })
      .andWhere('processing_run = :run', { run: snapshot.run })
      .andWhere('pending_job_token = :pendingToken', {
        pendingToken: snapshot.pendingToken,
      })
      .andWhere('pending_job_dispatch = :pendingDispatch', {
        pendingDispatch: snapshot.pendingDispatch,
      })
      .andWhere('attempt_fence_dispatch IS NOT DISTINCT FROM :fenceDispatch', {
        fenceDispatch: snapshot.fenceDispatch,
      })
      .andWhere('attempt_fence_seq IS NOT DISTINCT FROM :fenceSeq', {
        fenceSeq: snapshot.fenceSeq,
      });
  }
}
