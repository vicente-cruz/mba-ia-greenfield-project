import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';
import {
  UploadSession,
  type UploadSessionStatus,
} from '../../videos/entities/upload-session.entity';
import { Video } from '../../videos/entities/video.entity';
import type {
  OriginalKeyFacts,
  ThumbnailVideoFacts,
} from './storage-cleaner.decisions';

/**
 * The facts of the database that the cleanup of P4 reads, once for a batch and again right before
 * each removal. It never writes: the ownership of the sessions goes through the sweep of the
 * sessions (SI-03.24).
 */
@Injectable()
export class StorageCleanupRepository {
  constructor(
    @InjectRepository(UploadSession)
    private readonly sessions: Repository<UploadSession>,
    @InjectRepository(Video) private readonly videos: Repository<Video>,
  ) {}

  /** For each key of `originals/`: its session and whether a video references it. */
  async originalKeyFacts(
    keys: string[],
  ): Promise<Map<string, OriginalKeyFacts>> {
    const facts = new Map<string, OriginalKeyFacts>(
      keys.map((key) => [key, { session: null, referenced: false }]),
    );
    if (keys.length === 0) {
      return facts;
    }
    const sessions = await this.sessions
      .createQueryBuilder('session')
      .select('session.object_key', 'objectKey')
      .addSelect('session.id', 'sessionId')
      .addSelect('session.video_id', 'videoId')
      .addSelect('session.status', 'status')
      .addSelect(
        'session.claim_expires_at IS NOT NULL AND session.claim_expires_at <= now()',
        'claimExpired',
      )
      .where('session.object_key IN (:...keys)', { keys })
      .getRawMany<{
        objectKey: string;
        sessionId: string;
        videoId: string;
        status: UploadSessionStatus;
        claimExpired: boolean;
      }>();
    for (const { objectKey, ...session } of sessions) {
      facts.get(objectKey)!.session = session;
    }
    const referencing = await this.videos.find({
      select: ['id', 'original_key'],
      where: { original_key: In(keys) },
    });
    for (const video of referencing) {
      facts.get(video.original_key!)!.referenced = true;
    }
    return facts;
  }

  /** For each video of a batch of thumbnails: status, published key and current attempt. */
  async thumbnailVideoFacts(
    videoIds: string[],
  ): Promise<Map<string, ThumbnailVideoFacts>> {
    if (videoIds.length === 0) {
      return new Map();
    }
    const videos = await this.videos.find({
      select: ['id', 'status', 'thumbnail_key', 'current_attempt_id'],
      where: { id: In(videoIds) },
    });
    return new Map(
      videos.map((video) => [
        video.id,
        {
          status: video.status,
          thumbnailKey: video.thumbnail_key,
          currentAttemptId: video.current_attempt_id,
        },
      ]),
    );
  }
}
