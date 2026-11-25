import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  buildUploadSession,
  buildVideo,
  saveTestChannel,
} from '../test/video-entity-fixtures';
import { User } from '../users/entities/user.entity';
import { UploadPart } from './entities/upload-part.entity';
import {
  UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VIDEO_ERROR_CODES,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import { VideoLockService } from './video-lock.service';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

/** The fields of "API Contracts → GET /videos/:publicId", and only them. */
const CONTRACT_FIELDS = [
  'audioCodec',
  'contentType',
  'createdAt',
  'durationSeconds',
  'errorCode',
  'errorMessage',
  'hasThumbnail',
  'height',
  'originalFilename',
  'publicId',
  'sizeBytes',
  'status',
  'updatedAt',
  'uploadSession',
  'videoCodec',
  'width',
];

describe('VideosService.getOwnVideo (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let owner: Channel;
  let other: Channel;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([UploadSession]),
        StorageModule,
      ],
      providers: [
        VideosService,
        UploadSessionAccessService,
        UploadSessionsRepository,
        VideoLockService,
      ],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideosService);
  });

  afterAll(async () => {
    try {
      await cleanAllTables(dataSource);
    } finally {
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    owner = await saveTestChannel(dataSource);
    other = await saveTestChannel(dataSource);
  });

  /** A video of `channel`, with its current session when `session` is given. */
  async function saveVideo(
    channel: Channel,
    overrides: Partial<Video> = {},
    session?: Partial<UploadSession>,
  ): Promise<{ video: Video; session: UploadSession | null }> {
    const videos = dataSource.getRepository(Video);
    const { identifiers } = await videos.insert(
      buildVideo(channel.id, overrides),
    );
    const videoId = identifiers[0].id as string;
    let current: UploadSession | null = null;
    if (session) {
      const sessions = dataSource.getRepository(UploadSession);
      const built = buildUploadSession(videoId, session);
      await sessions.insert(built);
      current = await sessions.findOneByOrFail({ id: built.id });
      await videos.update(
        { id: videoId },
        { current_upload_session_id: current.id },
      );
    }
    return {
      video: await videos.findOneByOrFail({ id: videoId }),
      session: current,
    };
  }

  it('should give the owner the draft with its current session and the metadata still empty', async () => {
    const { video, session } = await saveVideo(
      owner,
      { original_filename: 'clip.mp4', size_bytes: 1_048_576 },
      {
        status: UploadSessionStatus.ACTIVE,
        upload_id: 'upload-1',
        claim_token: null,
        claim_expires_at: null,
      },
    );

    const result = await service.getOwnVideo(owner.user_id, video.public_id);

    expect(Object.keys(result).sort()).toEqual(CONTRACT_FIELDS);
    expect(result).toEqual({
      publicId: video.public_id,
      status: VideoStatus.DRAFT,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1_048_576,
      durationSeconds: null,
      width: null,
      height: null,
      videoCodec: null,
      audioCodec: null,
      hasThumbnail: false,
      errorCode: null,
      errorMessage: null,
      uploadSession: {
        id: session?.id,
        status: UploadSessionStatus.ACTIVE,
        expiresAt: session?.expires_at,
      },
      createdAt: video.created_at,
      updatedAt: video.updated_at,
    });
    expect(Object.keys(result.uploadSession ?? {}).sort()).toEqual([
      'expiresAt',
      'id',
      'status',
    ]);
  });

  it('should give the metadata of a ready video, with the duration as a number and the thumbnail flag', async () => {
    const { video, session } = await saveVideo(
      owner,
      {
        status: VideoStatus.READY,
        size_bytes: 10_000_000_000,
        duration_seconds: '125.375',
        width: 1280,
        height: 720,
        media_format: 'mov,mp4,m4a,3gp,3g2,mj2',
        video_codec: 'h264',
        audio_codec: 'aac',
        thumbnail_key: `thumbnails/${randomUUID()}/${randomUUID()}.jpg`,
        original_key: 'originals/some/key',
        processing_run: 1,
        processing_dispatch: 1,
      },
      {
        status: UploadSessionStatus.COMPLETED,
        claim_token: null,
        claim_expires_at: null,
      },
    );

    const result = await service.getOwnVideo(owner.user_id, video.public_id);

    expect(result).toMatchObject({
      status: VideoStatus.READY,
      sizeBytes: 10_000_000_000,
      durationSeconds: 125.375,
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasThumbnail: true,
      errorCode: null,
      errorMessage: null,
      uploadSession: { id: session?.id, status: UploadSessionStatus.COMPLETED },
    });
    expect(typeof result.durationSeconds).toBe('number');
    // Internal fields stay out of the answer.
    expect(Object.keys(result).sort()).toEqual(CONTRACT_FIELDS);
  });

  it('should give the code and the message of a video in error', async () => {
    const { video } = await saveVideo(owner, {
      status: VideoStatus.ERROR,
      error_code: VIDEO_ERROR_CODES.MEDIA_INVALID,
      error_message: 'The file is not a valid video',
      processing_run: 1,
    });

    await expect(
      service.getOwnVideo(owner.user_id, video.public_id),
    ).resolves.toMatchObject({
      status: VideoStatus.ERROR,
      errorCode: 'MEDIA_INVALID',
      errorMessage: 'The file is not a valid video',
      hasThumbnail: false,
    });
  });

  it('should give a null uploadSession, and keep a null duration, for a video without a current session', async () => {
    const { video } = await saveVideo(owner);

    const result = await service.getOwnVideo(owner.user_id, video.public_id);

    expect(result.uploadSession).toBeNull();
    expect(result.durationSeconds).toBeNull();
  });

  it.each([
    ['a video of another channel', 'other'],
    ['a well-formed publicId with no video', 'missing'],
    ['a malformed publicId', 'malformed'],
  ])('should answer VIDEO_NOT_FOUND for %s', async (_, kind) => {
    const { video } = await saveVideo(other);
    const publicId =
      kind === 'other'
        ? video.public_id
        : kind === 'missing'
          ? 'zzzzzzzzzzz'
          : 'abc';

    await expect(
      service.getOwnVideo(owner.user_id, publicId),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
