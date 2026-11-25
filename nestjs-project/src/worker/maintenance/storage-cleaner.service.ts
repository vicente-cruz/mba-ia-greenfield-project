import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../../config/video.config';
import { StorageService } from '../../storage/storage.service';
import type {
  ListObjectsPage,
  MultipartUploadSummary,
  StorageObjectSummary,
} from '../../storage/storage.types';
import {
  ORIGINALS_PREFIX,
  parseOriginalObjectKey,
  parseThumbnailObjectKey,
  THUMBNAILS_PREFIX,
} from '../../videos/storage-keys';
import { UploadSessionsService } from '../../videos/upload-sessions.service';
import { LIST_PARTS_PAGE_SIZE } from '../../videos/videos.constants';
import type { MaintenanceJobData, MaintenanceTask } from './maintenance-task';
import {
  decideOriginalKey,
  decideThumbnail,
  type OriginalKeyFacts,
  pastGrace,
} from './storage-cleaner.decisions';
import { StorageCleanupRepository } from './storage-cleanup.repository';

/** Counts of one run of the cleanup, kept by BullMQ as the result of the job. */
export interface StorageCleanupResult {
  /** Objects, multipart uploads and thumbnails looked at in this run. */
  examined: number;
  /** Objects deleted (originals and thumbnails). */
  removed: number;
  /** Multipart uploads aborted, with NoSuchUpload confirmed. */
  aborted: number;
  /** Aborted, but the listing still shows the upload; the next cycle tries again. */
  abortUnconfirmed: number;
  /** Sessions `initiating`/`aborting` with an expired claim taken over and aborted (P1, P4). */
  claimed: number;
  /** Not removable: referenced, still usable, outside the layout, or changed at the re-read. */
  kept: number;
  /** Eligible or not, younger than `STORAGE_CLEANUP_GRACE_MS`. */
  withinGrace: number;
  /** Passes that failed; the job fails after the three passes, and the next run tries again. */
  failed: number;
}

type ObjectListing = 'originals' | 'thumbnails';

/**
 * The cleanup of abandoned objects (`cleanup-storage`, SI-03.26; P4, TD-06, G-10). A key is
 * removed only when a fact of the database that never regresses proves that no future transition
 * can reference it; the grace and the re-read right before each removal are an additional margin,
 * never the protection. Three passes, each one bounded by `batchSize` and moving on between runs
 * (positions kept in memory, per process), so the keys that must stay never hold the following
 * ones out:
 * - objects of `originals/` and multipart uploads of `originals/`, by the table of originals;
 * - objects of `thumbnails/{videoId}/`, by the table of derivatives.
 */
@Injectable()
export class StorageCleanerService implements MaintenanceTask {
  private readonly logger = new Logger(StorageCleanerService.name);
  /** Continuation of each object listing; `undefined` starts again from the first key. */
  private readonly objectTokens: Record<ObjectListing, string | undefined> = {
    originals: undefined,
    thumbnails: undefined,
  };
  /** The last multipart upload handled; `null` starts again from the first one. */
  private uploadCursor: { key: string; uploadId: string } | null = null;

  constructor(
    private readonly storage: StorageService,
    private readonly facts: StorageCleanupRepository,
    private readonly uploadSessions: UploadSessionsService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async run(data: MaintenanceJobData): Promise<StorageCleanupResult> {
    const { batchSize } = data;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error(`invalid batchSize for the cleanup: ${batchSize}`);
    }
    const result: StorageCleanupResult = {
      examined: 0,
      removed: 0,
      aborted: 0,
      abortUnconfirmed: 0,
      claimed: 0,
      kept: 0,
      withinGrace: 0,
      failed: 0,
    };
    const passes: [string, () => Promise<void>][] = [
      ['originals', () => this.cleanOriginalObjects(batchSize, result)],
      [
        'multipart uploads',
        () => this.cleanMultipartUploads(batchSize, result),
      ],
      ['thumbnails', () => this.cleanThumbnails(batchSize, result)],
    ];
    for (const [pass, clean] of passes) {
      try {
        await clean();
      } catch (error) {
        result.failed += 1;
        this.logger.warn({
          event: 'video-maintenance.cleanup-pass-failed',
          pass,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (result.examined > 0) {
      this.logger.log({ event: 'video-maintenance.cleanup', ...result });
    }
    if (result.failed > 0) {
      throw new Error(
        `cleanup of the storage: ${result.failed} of ${passes.length} passes failed`,
      );
    }
    return result;
  }

  /** Objects of `originals/`: the original of an `aborted` session or of a key without a row. */
  private async cleanOriginalObjects(
    batchSize: number,
    result: StorageCleanupResult,
  ): Promise<void> {
    const objects = await this.nextObjects(
      'originals',
      ORIGINALS_PREFIX,
      batchSize,
    );
    const facts = await this.facts.originalKeyFacts(
      objects.map((object) => object.key),
    );
    const now = Date.now();
    for (const object of objects) {
      result.examined += 1;
      if (!parseOriginalObjectKey(object.key)) {
        result.kept += 1;
        continue;
      }
      if (
        !pastGrace(object.lastModified, now, this.config.storageCleanupGraceMs)
      ) {
        result.withinGrace += 1;
        continue;
      }
      await this.actOnOriginalKey(
        object.key,
        facts.get(object.key)!,
        result,
        () => this.removeObject(object.key, result),
      );
    }
  }

  /**
   * Multipart uploads of `originals/`. The storage ignores `MaxUploads` and only lists the uploads
   * of the whole bucket (SI-03.9, SI-03.26), so the listing is read whole and the batch is taken
   * from it, in the order of key and upload id, after the last upload handled.
   */
  private async cleanMultipartUploads(
    batchSize: number,
    result: StorageCleanupResult,
  ): Promise<void> {
    const uploads = (await this.storage.listMultipartUploads(ORIGINALS_PREFIX))
      .slice()
      .sort(byKeyAndUploadId);
    let start = this.uploadCursor
      ? uploads.findIndex(
          (upload) => byKeyAndUploadId(upload, this.uploadCursor!) > 0,
        )
      : 0;
    if (start < 0 || start >= uploads.length) {
      start = 0;
    }
    const batch = uploads.slice(start, start + batchSize);
    const last = batch.at(-1);
    this.uploadCursor =
      last && start + batch.length < uploads.length
        ? { key: last.key, uploadId: last.uploadId }
        : null;

    const facts = await this.facts.originalKeyFacts([
      ...new Set(batch.map((upload) => upload.key)),
    ]);
    const claimedSessions = new Set<string>();
    const now = Date.now();
    for (const upload of batch) {
      result.examined += 1;
      if (!parseOriginalObjectKey(upload.key)) {
        result.kept += 1;
        continue;
      }
      if (
        !pastGrace(upload.initiated, now, this.config.storageCleanupGraceMs)
      ) {
        result.withinGrace += 1;
        continue;
      }
      const keyFacts = facts.get(upload.key)!;
      const sessionId = keyFacts.session?.sessionId;
      if (sessionId && claimedSessions.has(sessionId)) {
        // Already taken over in this run, for another upload at the same key.
        continue;
      }
      await this.actOnOriginalKey(upload.key, keyFacts, result, () =>
        this.abortUpload(upload, result),
      );
      if (sessionId && decideOriginalKey(keyFacts) === 'claim-and-abort') {
        claimedSessions.add(sessionId);
      }
    }
  }

  /** Objects of `thumbnails/{videoId}/`, by the table of derivatives of P4. */
  private async cleanThumbnails(
    batchSize: number,
    result: StorageCleanupResult,
  ): Promise<void> {
    const objects = await this.nextObjects(
      'thumbnails',
      THUMBNAILS_PREFIX,
      batchSize,
    );
    const parsed = objects.map((object) => ({
      object,
      key: parseThumbnailObjectKey(object.key),
    }));
    const videos = await this.facts.thumbnailVideoFacts([
      ...new Set(parsed.flatMap(({ key }) => (key ? [key.videoId] : []))),
    ]);
    const now = Date.now();
    for (const { object, key } of parsed) {
      result.examined += 1;
      if (!key) {
        result.kept += 1;
        continue;
      }
      if (
        !pastGrace(object.lastModified, now, this.config.storageCleanupGraceMs)
      ) {
        result.withinGrace += 1;
        continue;
      }
      if (
        decideThumbnail(
          object.key,
          key.attemptId,
          videos.get(key.videoId) ?? null,
        ) !== 'remove'
      ) {
        result.kept += 1;
        continue;
      }
      // Re-read right before the removal: the decision must hold on the current row.
      const fresh = await this.facts.thumbnailVideoFacts([key.videoId]);
      if (
        decideThumbnail(
          object.key,
          key.attemptId,
          fresh.get(key.videoId) ?? null,
        ) !== 'remove'
      ) {
        this.keptAtReread(object.key, result);
        continue;
      }
      await this.removeObject(object.key, result);
    }
  }

  /**
   * The table of originals for one key: `remove` after the re-read, `claim-and-abort` through the
   * sweep of the sessions, which takes the ownership by token before aborting (P1, P4).
   */
  private async actOnOriginalKey(
    key: string,
    facts: OriginalKeyFacts,
    result: StorageCleanupResult,
    remove: () => Promise<void>,
  ): Promise<void> {
    switch (decideOriginalKey(facts)) {
      case 'keep':
        result.kept += 1;
        return;
      case 'claim-and-abort': {
        const outcome = await this.uploadSessions.sweepAbort(
          facts.session!.videoId,
          facts.session!.sessionId,
        );
        result.claimed += outcome === 'aborted' ? 1 : 0;
        this.logger.log({
          event: 'video-maintenance.cleanup-claimed-session',
          key,
          sessionId: facts.session!.sessionId,
          outcome,
        });
        return;
      }
      case 'remove': {
        // Re-read right before the removal: the decision must hold on the current rows.
        const fresh = (await this.facts.originalKeyFacts([key])).get(key)!;
        if (decideOriginalKey(fresh) !== 'remove') {
          this.keptAtReread(key, result);
          return;
        }
        await remove();
        return;
      }
    }
  }

  private async removeObject(
    key: string,
    result: StorageCleanupResult,
  ): Promise<void> {
    await this.storage.deleteObject(key);
    result.removed += 1;
    this.logger.log({ event: 'video-maintenance.cleanup-removed', key });
  }

  /** Abort, then `ListParts` to confirm that the upload is gone (SI-03.17). */
  private async abortUpload(
    upload: MultipartUploadSummary,
    result: StorageCleanupResult,
  ): Promise<void> {
    await this.storage.abortMultipartUpload(upload.key, upload.uploadId);
    const listed = await this.storage.listParts(upload.key, upload.uploadId, {
      pageSize: LIST_PARTS_PAGE_SIZE,
    });
    if (listed.status === 'no-such-upload') {
      result.aborted += 1;
      this.logger.log({
        event: 'video-maintenance.cleanup-aborted',
        key: upload.key,
      });
    } else {
      result.abortUnconfirmed += 1;
    }
  }

  private keptAtReread(key: string, result: StorageCleanupResult): void {
    result.kept += 1;
    this.logger.log({
      event: 'video-maintenance.cleanup-kept-at-reread',
      key,
      reason:
        'the database changed since the listing; the key is no longer removable',
    });
  }

  /**
   * The next page of a listing, after the page of the previous run. The end of the listing starts
   * again from the first key in the next run; an empty page after a position starts again now. A
   * continuation that the storage refuses starts again from the first key.
   */
  private async nextObjects(
    listing: ObjectListing,
    prefix: string,
    batchSize: number,
  ): Promise<StorageObjectSummary[]> {
    const continuationToken = this.objectTokens[listing];
    let page: ListObjectsPage;
    try {
      page = await this.storage.listObjects(prefix, {
        continuationToken,
        maxKeys: batchSize,
      });
    } catch (error) {
      if (!continuationToken) {
        throw error;
      }
      page = { objects: [], nextContinuationToken: undefined };
    }
    if (page.objects.length === 0 && continuationToken) {
      page = await this.storage.listObjects(prefix, { maxKeys: batchSize });
    }
    this.objectTokens[listing] = page.nextContinuationToken;
    return page.objects;
  }
}

function byKeyAndUploadId(
  a: { key: string; uploadId: string },
  b: { key: string; uploadId: string },
): number {
  return a.key === b.key
    ? a.uploadId.localeCompare(b.uploadId)
    : a.key.localeCompare(b.key);
}
