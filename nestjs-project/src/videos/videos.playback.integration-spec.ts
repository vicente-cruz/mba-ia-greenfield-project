import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { createStorageClient } from '../storage/storage.clients';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { VIDEO_FIXTURES } from '../test/processing-fixtures';
import { requestPresignedUrl } from '../test/storage';
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
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';
import { VideoLockService } from './video-lock.service';
import { VideosService } from './videos.service';

jest.setTimeout(30_000);

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

/** The valid fixtures of SI-03.6 (V-04). */
const MP4 = readFileSync(join(VIDEO_FIXTURES, 'h264-aac-faststart.mp4'));
const WEBM = readFileSync(join(VIDEO_FIXTURES, 'vp9-opus.webm'));
const RANGE = 'bytes=0-1023';

function createModule(playbackUrlTtlSeconds?: number): Promise<TestingModule> {
  const builder = Test.createTestingModule({
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
  });
  return playbackUrlTtlSeconds === undefined
    ? builder.compile()
    : builder
        .overrideProvider(videoConfig.KEY)
        .useValue({ ...videoConfig(), playbackUrlTtlSeconds })
        .compile();
}

/**
 * GET /videos/:publicId/playback-url at the service (TD-13, TD-14, AMB-1), against the database
 * and the storage of the Compose: the URL is requested from inside the container, connecting to
 * the storage service and keeping the signed Host of S3_PUBLIC_ENDPOINT.
 */
describe('VideosService.getPlaybackUrl (integration)', () => {
  const config = storageConfig();
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let owner: Channel;
  let other: Channel;
  let ownerUserId: string;
  /** Originals written by the scenario, removed after it. */
  const writtenKeys = new Set<string>();

  beforeAll(async () => {
    moduleRef = await createModule();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideosService);
  });

  afterAll(async () => {
    try {
      await cleanAllTables(dataSource);
    } finally {
      s3.destroy();
      await moduleRef.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    owner = await saveTestChannel(dataSource);
    other = await saveTestChannel(dataSource);
    ownerUserId = owner.user_id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const key of writtenKeys) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    }
    writtenKeys.clear();
  });

  /**
   * A video of `channel` in `status`, with its completed session; for `ready`, the metadata and
   * the original written at `original_key` (the bytes of a fixture of SI-03.6).
   */
  async function saveVideo(
    channel: Channel,
    status: VideoStatus,
    original: { body: Buffer; contentType: string } = {
      body: MP4,
      contentType: 'video/mp4',
    },
  ): Promise<Video> {
    const videos = dataSource.getRepository(Video);
    const video = await videos.save(
      buildVideo(channel.id, {
        content_type: original.contentType,
        size_bytes: original.body.length,
      }),
    );
    if (status === VideoStatus.DRAFT) {
      return video;
    }
    const session = await dataSource.getRepository(UploadSession).save(
      buildUploadSession(video.id, {
        status: UploadSessionStatus.COMPLETED,
        upload_id: 'completed-upload',
        size_bytes: original.body.length,
        claim_token: null,
        claim_expires_at: null,
      }),
    );
    // No ContentType at the upload: the response type comes only from the signature.
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: session.object_key,
        Body: original.body,
        ContentLength: original.body.length,
      }),
    );
    writtenKeys.add(session.object_key);
    await videos.update(video.id, {
      status,
      current_upload_session_id: session.id,
      original_key: session.object_key,
      processing_run: 1,
      processing_dispatch: 1,
      ...(status === VideoStatus.READY
        ? {
            duration_seconds: '4.000',
            width: 320,
            height: 240,
            thumbnail_key: `thumbnails/${video.id}/attempt.jpg`,
          }
        : {}),
      ...(status === VideoStatus.ERROR
        ? {
            error_code: VIDEO_ERROR_CODES.MEDIA_INVALID,
            error_message: 'The original is not a valid video',
          }
        : {}),
    });
    return videos.findOneByOrFail({ id: video.id });
  }

  describe('owner of a ready video', () => {
    it('should sign the original on the public endpoint with the content type of the video and the configured TTL', async () => {
      const video = await saveVideo(owner, VideoStatus.READY);
      const before = Date.now();

      const playback = await service.getPlaybackUrl(
        ownerUserId,
        video.public_id,
      );

      const ttl = videoConfig().playbackUrlTtlSeconds;
      const url = new URL(playback.url);
      expect(url.host).toBe(new URL(config.publicEndpoint).host);
      expect(decodeURIComponent(url.pathname)).toBe(
        `/${config.bucket}/${video.original_key}`,
      );
      expect(url.searchParams.get('response-content-type')).toBe('video/mp4');
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBe(ttl);
      expect(playback.contentType).toBe('video/mp4');
      // Signed on a whole second, at most one second before the call.
      expect(playback.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before - 1_000 + ttl * 1_000,
      );
      expect(playback.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + ttl * 1_000,
      );
    });

    it('should hand a URL that answers Range: bytes=0-1023 with 206, Content-Range and the first bytes of the fixture', async () => {
      const video = await saveVideo(owner, VideoStatus.READY);
      const { url } = await service.getPlaybackUrl(
        ownerUserId,
        video.public_id,
      );

      const response = await requestPresignedUrl(url, {
        headers: { range: RANGE },
      });

      expect(response.status).toBe(206);
      expect(response.headers['content-range']).toBe(
        `bytes 0-1023/${MP4.length}`,
      );
      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.body.equals(MP4.subarray(0, 1024))).toBe(true);
    });

    it('should sign the type of a WebM video, which the storage then answers', async () => {
      const video = await saveVideo(owner, VideoStatus.READY, {
        body: WEBM,
        contentType: 'video/webm',
      });

      const playback = await service.getPlaybackUrl(
        ownerUserId,
        video.public_id,
      );
      const response = await requestPresignedUrl(playback.url, {
        headers: { range: RANGE },
      });

      expect(playback.contentType).toBe('video/webm');
      expect(response.status).toBe(206);
      expect(response.headers['content-type']).toBe('video/webm');
      expect(response.headers['content-range']).toBe(
        `bytes 0-1023/${WEBM.length}`,
      );
    });

    it('should hand a URL that the storage refuses after PLAYBACK_URL_TTL_SECONDS', async () => {
      const shortLived = await createModule(1);
      try {
        const video = await saveVideo(owner, VideoStatus.READY);
        const playback = await shortLived
          .get(VideosService)
          .getPlaybackUrl(ownerUserId, video.public_id);
        expect(playback.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
          1_000,
        );

        await new Promise((resolve) =>
          setTimeout(
            resolve,
            playback.expiresAt.getTime() - Date.now() + 1_500,
          ),
        );
        const response = await requestPresignedUrl(playback.url, {
          headers: { range: RANGE },
        });

        expect(response.status).toBe(403);
      } finally {
        await shortLived.close();
      }
    });
  });

  describe('refusals', () => {
    it('should answer VIDEO_NOT_FOUND to another user and to a malformed publicId, without signing', async () => {
      const video = await saveVideo(owner, VideoStatus.READY);
      const presign = jest.spyOn(moduleRef.get(StorageService), 'presignGet');

      await expect(
        service.getPlaybackUrl(other.user_id, video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.getPlaybackUrl(ownerUserId, 'not-a-public-id'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(presign).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
      'should answer VIDEO_NOT_READY to the owner of a video in %s, without signing',
      async (status) => {
        const video = await saveVideo(owner, status);
        const presign = jest.spyOn(moduleRef.get(StorageService), 'presignGet');

        await expect(
          service.getPlaybackUrl(ownerUserId, video.public_id),
        ).rejects.toBeInstanceOf(VideoNotReadyException);

        expect(presign).not.toHaveBeenCalled();
      },
    );
  });
});
