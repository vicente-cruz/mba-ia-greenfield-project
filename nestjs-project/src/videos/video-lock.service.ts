import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { Video } from './entities/video.entity';

/**
 * Serialization point of P1 and P2 (plan's "Coordenação e fencing"): every operation that
 * creates, replaces, claims, finishes or aborts a session runs a short transaction holding the
 * row of the video with `SELECT … FOR UPDATE`.
 *
 * The callback must only read and write the database. Storage calls never run inside it (G-01):
 * the caller alternates a short locked transaction, the storage call and a new short
 * transaction. This service does not depend on the storage, on purpose.
 */
@Injectable()
export class VideoLockService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Opens a transaction, locks the row of the video and runs `work` with it. `video` is `null`
   * when the row does not exist; the caller decides what that means. The transaction commits when
   * `work` resolves and rolls back when it throws.
   */
  async withLockedVideo<T>(
    videoId: string,
    work: (video: Video | null, manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const video = await manager.getRepository(Video).findOne({
        where: { id: videoId },
        lock: { mode: 'pessimistic_write' },
      });
      return work(video, manager);
    });
  }
}
