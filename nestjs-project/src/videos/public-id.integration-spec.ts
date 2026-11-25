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
import { generatePublicId, withPublicIdRetry } from './public-id';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

describe('withPublicIdRetry (integration)', () => {
  let dataSource: DataSource;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    channel = await saveTestChannel(dataSource);
  });

  it('should recover from a real collision inside a transaction and commit the new video', async () => {
    const takenId = generatePublicId();
    await dataSource
      .getRepository(Video)
      .insert(buildVideo(channel.id, { public_id: takenId }));
    const freshId = generatePublicId();
    const generate = jest
      .fn<string, []>()
      .mockReturnValueOnce(takenId)
      .mockReturnValueOnce(freshId);

    const savedId = await dataSource.transaction(async (manager) => {
      const publicId = await withPublicIdRetry(
        async (candidate) => {
          await manager.insert(
            Video,
            buildVideo(channel.id, { public_id: candidate }),
          );
          return candidate;
        },
        { manager, generate },
      );
      // The transaction is still usable after the rolled-back attempt.
      await manager.update(
        Video,
        { public_id: publicId },
        { original_filename: 'after-retry.mp4' },
      );
      return publicId;
    });

    expect(savedId).toBe(freshId);
    const videos = await dataSource
      .getRepository(Video)
      .find({ order: { created_at: 'ASC' } });
    expect(videos.map((v) => [v.public_id, v.original_filename])).toEqual([
      [takenId, 'video.mp4'],
      [freshId, 'after-retry.mp4'],
    ]);
  });
});
