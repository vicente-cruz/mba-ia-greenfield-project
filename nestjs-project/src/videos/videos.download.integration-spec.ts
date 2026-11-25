import { createHash } from 'node:crypto';
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
import { parseContentDisposition } from '../test/content-disposition';
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
import { attachmentDisposition } from './content-disposition';
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

/** The valid MP4 of SI-03.6 (V-04). */
const MP4 = readFileSync(join(VIDEO_FIXTURES, 'h264-aac-faststart.mp4'));
const ACCENTED_NAME = 'vídeo de ação.mp4';

const sha256 = (data: Buffer) =>
  createHash('sha256').update(data).digest('hex');

function createModule(downloadUrlTtlSeconds?: number): Promise<TestingModule> {
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
  return downloadUrlTtlSeconds === undefined
    ? builder.compile()
    : builder
        .overrideProvider(videoConfig.KEY)
        .useValue({ ...videoConfig(), downloadUrlTtlSeconds })
        .compile();
}

/**
 * GET /videos/:publicId/download-url at the service (TD-14, AMB-1), against the database and the
 * storage of the Compose: the URL is requested from inside the container, connecting to the
 * storage service and keeping the signed Host of S3_PUBLIC_ENDPOINT.
 */
describe('VideosService.getDownloadUrl (integration)', () => {
  const config = storageConfig();
  const s3 = createStorageClient(config, config.endpoint);
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let owner: Channel;
  let other: Channel;
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
   * A video of the owner in `status`, named `originalFilename`, with its completed session and the
   * MP4 of SI-03.6 written at `original_key`; for `ready`, also the metadata.
   */
  async function saveVideo(
    status: VideoStatus,
    originalFilename = 'clip.mp4',
  ): Promise<Video> {
    const videos = dataSource.getRepository(Video);
    const video = await videos.save(
      buildVideo(owner.id, {
        original_filename: originalFilename,
        size_bytes: MP4.length,
      }),
    );
    if (status === VideoStatus.DRAFT) {
      return video;
    }
    const session = await dataSource.getRepository(UploadSession).save(
      buildUploadSession(video.id, {
        status: UploadSessionStatus.COMPLETED,
        upload_id: 'completed-upload',
        size_bytes: MP4.length,
        claim_token: null,
        claim_expires_at: null,
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: session.object_key,
        Body: MP4,
        ContentLength: MP4.length,
        ContentType: 'video/mp4',
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
    it('should sign the original on the public endpoint as an attachment, with the configured TTL', async () => {
      const video = await saveVideo(VideoStatus.READY);
      const before = Date.now();

      const download = await service.getDownloadUrl(
        owner.user_id,
        video.public_id,
      );

      const ttl = videoConfig().downloadUrlTtlSeconds;
      const url = new URL(download.url);
      expect(Object.keys(download).sort()).toEqual(['expiresAt', 'url']);
      expect(url.host).toBe(new URL(config.publicEndpoint).host);
      expect(decodeURIComponent(url.pathname)).toBe(
        `/${config.bucket}/${video.original_key}`,
      );
      expect(url.searchParams.get('response-content-disposition')).toBe(
        attachmentDisposition('clip.mp4'),
      );
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBe(ttl);
      // Signed on a whole second, at most one second before the call.
      expect(download.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before - 1_000 + ttl * 1_000,
      );
      expect(download.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + ttl * 1_000,
      );
    });

    it('should hand a URL whose full download has the bytes and the SHA-256 of the original, as an attachment', async () => {
      const video = await saveVideo(VideoStatus.READY);
      const { url } = await service.getDownloadUrl(
        owner.user_id,
        video.public_id,
      );

      const response = await requestPresignedUrl(url);

      expect(response.status).toBe(200);
      expect(Number(response.headers['content-length'])).toBe(MP4.length);
      expect(sha256(response.body)).toBe(sha256(MP4));
      expect(
        parseContentDisposition(response.headers['content-disposition']),
      ).toEqual({
        type: 'attachment',
        filename: 'clip.mp4',
        filenameStar: 'clip.mp4',
      });
    });

    it('should preserve "vídeo de ação.mp4" in filename*, with an ASCII fallback in filename', async () => {
      const video = await saveVideo(VideoStatus.READY, ACCENTED_NAME);
      const { url } = await service.getDownloadUrl(
        owner.user_id,
        video.public_id,
      );

      const response = await requestPresignedUrl(url);

      const header = response.headers['content-disposition'];
      expect(header).toContain(
        "filename*=UTF-8''v%C3%ADdeo%20de%20a%C3%A7%C3%A3o.mp4",
      );
      expect(parseContentDisposition(header)).toEqual({
        type: 'attachment',
        filename: 'video de acao.mp4',
        filenameStar: ACCENTED_NAME,
      });
    });

    it('should get from the storage exactly the signed header for a name with quotes, percent, semicolon and parentheses', async () => {
      const name = 'clip "final" 100%; v2\'s (copy).mp4';
      const video = await saveVideo(VideoStatus.READY, name);
      const { url } = await service.getDownloadUrl(
        owner.user_id,
        video.public_id,
      );

      const response = await requestPresignedUrl(url);

      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toBe(
        attachmentDisposition(name),
      );
      expect(
        parseContentDisposition(response.headers['content-disposition'])
          .filenameStar,
      ).toBe(name);
    });

    it('should hand a URL that the storage refuses after DOWNLOAD_URL_TTL_SECONDS', async () => {
      const shortLived = await createModule(1);
      try {
        const video = await saveVideo(VideoStatus.READY);
        const download = await shortLived
          .get(VideosService)
          .getDownloadUrl(owner.user_id, video.public_id);
        expect(download.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
          1_000,
        );

        await new Promise((resolve) =>
          setTimeout(
            resolve,
            download.expiresAt.getTime() - Date.now() + 1_500,
          ),
        );
        const response = await requestPresignedUrl(download.url);

        expect(response.status).toBe(403);
      } finally {
        await shortLived.close();
      }
    });
  });

  describe('refusals', () => {
    it('should answer VIDEO_NOT_FOUND to another user and to a malformed publicId, without signing', async () => {
      const video = await saveVideo(VideoStatus.READY);
      const presign = jest.spyOn(moduleRef.get(StorageService), 'presignGet');

      await expect(
        service.getDownloadUrl(other.user_id, video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.getDownloadUrl(owner.user_id, 'not-a-public-id'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(presign).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
      'should answer VIDEO_NOT_READY to the owner of a video in %s, without signing',
      async (status) => {
        const video = await saveVideo(status);
        const presign = jest.spyOn(moduleRef.get(StorageService), 'presignGet');

        await expect(
          service.getDownloadUrl(owner.user_id, video.public_id),
        ).rejects.toBeInstanceOf(VideoNotReadyException);

        expect(presign).not.toHaveBeenCalled();
      },
    );
  });
});
