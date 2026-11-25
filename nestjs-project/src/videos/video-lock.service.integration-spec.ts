import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { buildVideo, saveTestChannel } from '../test/video-entity-fixtures';
import { User } from '../users/entities/user.entity';
import { UploadPart } from './entities/upload-part.entity';
import { UploadSession } from './entities/upload-session.entity';
import { Video } from './entities/video.entity';
import { VideoLockService } from './video-lock.service';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** A promise resolved from outside, to hold a transaction open at a known point. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('VideoLockService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let lockService: VideoLockService;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
      ],
      providers: [VideoLockService],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    lockService = moduleRef.get(VideoLockService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    channel = await saveTestChannel(dataSource);
  });

  async function saveVideo(): Promise<string> {
    const { identifiers } = await dataSource
      .getRepository(Video)
      .insert(buildVideo(channel.id));
    return identifiers[0].id as string;
  }

  /**
   * Waits until a backend of this database is blocked by another one while reading `videos`.
   * `pg_stat_activity.query` is truncated at 1024 bytes, which cuts the `FOR UPDATE` of the
   * TypeORM SELECT, so the wait is detected by `pg_blocking_pids` and by the start of the query.
   */
  async function waitForBlockedLock(timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [{ blocked }] = await dataSource.query<{ blocked: number }[]>(
        `SELECT count(*)::int AS blocked FROM pg_stat_activity
         WHERE datname = current_database()
           AND cardinality(pg_blocking_pids(pid)) > 0
           AND query LIKE 'SELECT "Video"."id"%'`,
      );
      if (blocked > 0) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error('No transaction was blocked on the video lock');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('should run two locks on the same video one after the other, never overlapping', async () => {
    const videoId = await saveVideo();
    const events: string[] = [];
    const firstHasLock = gate();
    const releaseFirst = gate();

    const first = lockService.withLockedVideo(videoId, async (_, manager) => {
      events.push('first:locked');
      firstHasLock.open();
      await releaseFirst.opened;
      await manager.update(Video, { id: videoId }, { processing_run: 1 });
      events.push('first:committing');
    });
    await firstHasLock.opened;
    const second = lockService.withLockedVideo(videoId, (video) => {
      events.push(`second:locked:processing_run=${video?.processing_run}`);
      return Promise.resolve();
    });

    try {
      await waitForBlockedLock();
      expect(events).toEqual(['first:locked']);
    } finally {
      releaseFirst.open();
      await Promise.all([first, second]);
    }

    // The second transaction only got the row after the first committed, and saw its write.
    expect(events).toEqual([
      'first:locked',
      'first:committing',
      'second:locked:processing_run=1',
    ]);
  });

  it('should not serialize locks on different videos', async () => {
    const videoA = await saveVideo();
    const videoB = await saveVideo();
    const releaseA = gate();
    const aHasLock = gate();

    const lockA = lockService.withLockedVideo(videoA, async () => {
      aHasLock.open();
      await releaseA.opened;
    });
    await aHasLock.opened;

    try {
      await expect(
        lockService.withLockedVideo(videoB, (video) =>
          Promise.resolve(video?.id),
        ),
      ).resolves.toBe(videoB);
    } finally {
      releaseA.open();
      await lockA;
    }
  });

  it('should roll back the writes and release the row when the work throws', async () => {
    const videoId = await saveVideo();

    await expect(
      lockService.withLockedVideo(videoId, async (_, manager) => {
        await manager.update(Video, { id: videoId }, { processing_run: 5 });
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    const video = await lockService.withLockedVideo(videoId, (locked) =>
      Promise.resolve(locked),
    );
    expect(video?.processing_run).toBe(0);
  });

  it('should hand null to the work when the video does not exist', async () => {
    await expect(
      lockService.withLockedVideo(MISSING_ID, (video) =>
        Promise.resolve(video),
      ),
    ).resolves.toBeNull();
  });
});
