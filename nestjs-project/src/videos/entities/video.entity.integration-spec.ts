import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { captureQueryError } from '../../test/query-error';
import {
  buildVideo,
  saveTestChannel,
  testPublicId,
} from '../../test/video-entity-fixtures';
import { User } from '../../users/entities/user.entity';
import { UploadPart } from './upload-part.entity';
import { UploadSession } from './upload-session.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    channel = await saveTestChannel(dataSource);
  });

  it('should reject a second video with the same public_id', async () => {
    const publicId = testPublicId();
    await videoRepository.insert(
      buildVideo(channel.id, { public_id: publicId }),
    );

    const error = await captureQueryError(
      videoRepository.insert(buildVideo(channel.id, { public_id: publicId })),
    );

    expect(error.code).toBe('23505');
    expect(error.detail).toContain('(public_id)');
  });

  it('should start as draft with the processing counters at 0', async () => {
    const { identifiers } = await videoRepository.insert(
      buildVideo(channel.id),
    );

    const video = await videoRepository.findOneByOrFail({
      id: identifiers[0].id as string,
    });
    expect(video).toMatchObject({
      status: VideoStatus.DRAFT,
      processing_run: 0,
      processing_dispatch: 0,
      processing_recoveries: 0,
      current_upload_session_id: null,
      original_key: null,
      current_attempt_id: null,
      attempt_fence_dispatch: null,
      attempt_fence_seq: null,
      pending_job_action: null,
      thumbnail_key: null,
    });
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should read size_bytes = 10000000000 back as the exact integer', async () => {
    const { identifiers } = await videoRepository.insert(
      buildVideo(channel.id, { size_bytes: 10_000_000_000 }),
    );
    const id = identifiers[0].id as string;

    const video = await videoRepository.findOneByOrFail({ id });
    const [raw] = await dataSource.query<{ size_bytes: string }[]>(
      'SELECT size_bytes FROM videos WHERE id = $1',
      [id],
    );

    expect(video.size_bytes).toBe(10_000_000_000);
    expect(Number.isSafeInteger(video.size_bytes)).toBe(true);
    expect(raw.size_bytes).toBe('10000000000');
  });

  it.each([0, -1])('should reject size_bytes = %i', async (sizeBytes) => {
    await expect(
      captureQueryError(
        videoRepository.insert(
          buildVideo(channel.id, { size_bytes: sizeBytes }),
        ),
      ),
    ).resolves.toMatchObject({
      code: '23514',
      constraint: 'CHK_videos_size_bytes_positive',
    });
  });

  it('should reject a channel_id that does not exist', async () => {
    const error = await captureQueryError(
      videoRepository.insert(
        buildVideo('00000000-0000-4000-8000-000000000000'),
      ),
    );

    expect(error.code).toBe('23503');
    expect(error.detail).toContain('is not present in table "channels"');
  });

  it('should keep a channel that still has videos (ON DELETE RESTRICT)', async () => {
    await videoRepository.insert(buildVideo(channel.id));

    const error = await captureQueryError(
      dataSource.getRepository(Channel).delete({ id: channel.id }),
    );

    expect(error.code).toBe('23503');
    expect(error.table).toBe('videos');
    await expect(
      dataSource.getRepository(Channel).existsBy({ id: channel.id }),
    ).resolves.toBe(true);
  });

  it('should load the videos of a channel through the inverse relation', async () => {
    await videoRepository.insert([
      buildVideo(channel.id),
      buildVideo(channel.id),
    ]);

    const found = await dataSource.getRepository(Channel).findOneOrFail({
      where: { id: channel.id },
      relations: { videos: true },
    });

    expect(found.videos).toHaveLength(2);
    expect(found.videos.every((v) => v.channel_id === channel.id)).toBe(true);
  });
});
