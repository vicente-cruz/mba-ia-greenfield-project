import { Injectable, Logger } from '@nestjs/common';
import { UploadSessionStatus } from '../../videos/entities/upload-session.entity';
import { UploadCompletionService } from '../../videos/upload-completion.service';
import {
  type SweepCandidate,
  UploadSessionsRepository,
} from '../../videos/upload-sessions.repository';
import { UploadSessionsService } from '../../videos/upload-sessions.service';
import type { MaintenanceJobData, MaintenanceTask } from './maintenance-task';

/** Counts of one run of the sweep, kept by BullMQ as the result of the job. */
export interface UploadSessionSweepResult {
  examined: number;
  /** `aborting → aborted` by this run, after NoSuchUpload. */
  aborted: number;
  /** Claimed, but the storage did not confirm the abort (F-09); retried after the claim deadline. */
  abortUnconfirmed: number;
  /** Completions resumed and finalized by this run (P2). */
  completed: number;
  /** Completions resumed whose protocol ended otherwise (reverted, aborted, or re-read). */
  completionDecided: number;
  /** Read under the lock, nothing to do anymore (another operation acted first). */
  skipped: number;
  /** Unexpected failures; the job fails after the batch, and the next run tries again. */
  failed: number;
}

/**
 * The sweep of upload sessions (`sweep-upload-sessions`, SI-03.24; P1, P2, G-02, G-10, F-01,
 * F-08, F-09), in batches of `batchSize`:
 * - `active` past `expires_at`, and `initiating` or `aborting` past the claim deadline: claimed
 *   for abort under the lock of the video, aborted in the storage until NoSuchUpload, and marked
 *   `aborted` by the token;
 * - `completing` past the claim deadline: its completion is resumed from step 2 of P2, never
 *   aborted.
 * Every step is a transition conditioned on state and token, so running the same batch again,
 * or in two instances, has no further effect (G-01).
 */
@Injectable()
export class UploadSessionSweeperService implements MaintenanceTask {
  private readonly logger = new Logger(UploadSessionSweeperService.name);

  constructor(
    private readonly uploadSessionsRepository: UploadSessionsRepository,
    private readonly uploadSessions: UploadSessionsService,
    private readonly completions: UploadCompletionService,
  ) {}

  async run(data: MaintenanceJobData): Promise<UploadSessionSweepResult> {
    const { batchSize } = data;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error(`invalid batchSize for the sweep: ${batchSize}`);
    }
    const result: UploadSessionSweepResult = {
      examined: 0,
      aborted: 0,
      abortUnconfirmed: 0,
      completed: 0,
      completionDecided: 0,
      skipped: 0,
      failed: 0,
    };
    const candidates =
      await this.uploadSessionsRepository.findSweepCandidates(batchSize);
    for (const candidate of candidates) {
      result.examined += 1;
      try {
        await this.sweep(candidate, result);
      } catch (error) {
        result.failed += 1;
        this.logger.warn({
          event: 'video-maintenance.sweep-session-failed',
          sessionId: candidate.sessionId,
          status: candidate.status,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (result.examined > 0) {
      this.logger.log({ event: 'video-maintenance.sweep', ...result });
    }
    if (result.failed > 0) {
      throw new Error(
        `sweep of upload sessions: ${result.failed} of ${result.examined} sessions failed`,
      );
    }
    return result;
  }

  private async sweep(
    candidate: SweepCandidate,
    result: UploadSessionSweepResult,
  ): Promise<void> {
    if (candidate.status === UploadSessionStatus.COMPLETING) {
      const resumed = await this.completions.resumeExpiredCompletion(
        candidate.videoId,
        candidate.publicId,
        candidate.sessionId,
      );
      switch (resumed.outcome) {
        case 'finalized':
          result.completed += 1;
          return;
        case 'not-resumed':
          result.skipped += 1;
          return;
        case 'completed-elsewhere':
        case 'decided':
          result.completionDecided += 1;
          return;
      }
    }
    const aborted = await this.uploadSessions.sweepAbort(
      candidate.videoId,
      candidate.sessionId,
    );
    switch (aborted) {
      case 'aborted':
        result.aborted += 1;
        return;
      case 'abort-unconfirmed':
        result.abortUnconfirmed += 1;
        return;
      case 'taken-over':
      case 'nothing-to-do':
        result.skipped += 1;
        return;
    }
  }
}
