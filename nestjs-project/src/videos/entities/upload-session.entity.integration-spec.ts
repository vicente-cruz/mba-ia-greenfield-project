import { randomUUID } from 'node:crypto';
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
  buildUploadPart,
  buildUploadSession,
  buildVideo,
  saveTestChannel,
} from '../../test/video-entity-fixtures';
import { User } from '../../users/entities/user.entity';
import { UploadPart } from './upload-part.entity';
import { UploadSession, UploadSessionStatus } from './upload-session.entity';
import { Video } from './video.entity';

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

describe('UploadSession entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let sessionRepository: Repository<UploadSession>;
  let videoId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    sessionRepository = dataSource.getRepository(UploadSession);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const channel = await saveTestChannel(dataSource);
    const { identifiers } = await videoRepository.insert(
      buildVideo(channel.id),
    );
    videoId = identifiers[0].id as string;
  });

  it('should keep the server-generated id and apply the defaults', async () => {
    const id = randomUUID();
    await sessionRepository.insert(
      buildUploadSession(videoId, {
        id,
        status: undefined,
        size_bytes: 10_000_000_000,
        part_count: 150,
      }),
    );

    const session = await sessionRepository.findOneByOrFail({ id });
    expect(session).toMatchObject({
      object_key: `originals/${videoId}/${id}`,
      status: UploadSessionStatus.INITIATING,
      checksum_algorithm: 'SHA256',
      upload_id: null,
      file_mismatch_at: null,
      size_bytes: 10_000_000_000,
    });
  });

  it('should refuse a session without an explicit id (no database default)', async () => {
    const withoutId = buildUploadSession(videoId);
    delete withoutId.id;

    await expect(
      captureQueryError(sessionRepository.insert(withoutId)),
    ).resolves.toMatchObject({ code: '23502', column: 'id' });
  });

  it('should reject a second session with the same object_key', async () => {
    const objectKey = `originals/${videoId}/${randomUUID()}`;
    await sessionRepository.insert(
      buildUploadSession(videoId, { object_key: objectKey }),
    );

    const error = await captureQueryError(
      sessionRepository.insert(
        buildUploadSession(videoId, { object_key: objectKey }),
      ),
    );

    expect(error.code).toBe('23505');
    expect(error.detail).toContain('(object_key)');
  });

  describe('partial unique index of active sessions', () => {
    it('should reject a second active session for the same video', async () => {
      await sessionRepository.insert(
        buildUploadSession(videoId, { status: UploadSessionStatus.ACTIVE }),
      );

      await expect(
        captureQueryError(
          sessionRepository.insert(
            buildUploadSession(videoId, { status: UploadSessionStatus.ACTIVE }),
          ),
        ),
      ).resolves.toMatchObject({
        code: '23505',
        constraint: 'UQ_upload_sessions_video_id_active',
      });
    });

    it('should reject the activation of a second session by UPDATE', async () => {
      await sessionRepository.insert(
        buildUploadSession(videoId, { status: UploadSessionStatus.ACTIVE }),
      );
      const second = buildUploadSession(videoId);
      await sessionRepository.insert(second);

      await expect(
        captureQueryError(
          sessionRepository.update(
            { id: second.id },
            { status: UploadSessionStatus.ACTIVE },
          ),
        ),
      ).resolves.toMatchObject({
        code: '23505',
        constraint: 'UQ_upload_sessions_video_id_active',
      });
    });

    it('should let an aborted and an active session of the same video coexist', async () => {
      await sessionRepository.insert([
        buildUploadSession(videoId, { status: UploadSessionStatus.ABORTED }),
        buildUploadSession(videoId, { status: UploadSessionStatus.ACTIVE }),
      ]);

      await expect(
        sessionRepository.countBy({ video_id: videoId }),
      ).resolves.toBe(2);
    });

    it('should leave sessions outside active out of the index', async () => {
      await sessionRepository.insert(
        [
          UploadSessionStatus.INITIATING,
          UploadSessionStatus.ACTIVE,
          UploadSessionStatus.COMPLETING,
          UploadSessionStatus.ABORTING,
          UploadSessionStatus.ABORTED,
          UploadSessionStatus.ABORTED,
        ].map((status) => buildUploadSession(videoId, { status })),
      );

      await expect(
        sessionRepository.countBy({ video_id: videoId }),
      ).resolves.toBe(6);
    });
  });

  describe('circular foreign keys between videos and upload_sessions', () => {
    async function saveCurrentSession(): Promise<string> {
      const session = buildUploadSession(videoId);
      await sessionRepository.insert(session);
      await videoRepository.update(
        { id: videoId },
        { current_upload_session_id: session.id },
      );
      return session.id as string;
    }

    it('should point the video to its current session', async () => {
      const sessionId = await saveCurrentSession();

      const video = await videoRepository.findOneOrFail({
        where: { id: videoId },
        relations: { current_upload_session: true, upload_sessions: true },
      });

      expect(video.current_upload_session?.id).toBe(sessionId);
      expect(video.upload_sessions.map((s) => s.id)).toEqual([sessionId]);
    });

    it('should reject a current_upload_session_id that does not exist', async () => {
      const error = await captureQueryError(
        videoRepository.update(
          { id: videoId },
          { current_upload_session_id: MISSING_ID },
        ),
      );

      expect(error.code).toBe('23503');
      expect(error.detail).toContain(
        'is not present in table "upload_sessions"',
      );
    });

    it('should reject a session whose video does not exist', async () => {
      const error = await captureQueryError(
        sessionRepository.insert(buildUploadSession(MISSING_ID)),
      );

      expect(error.code).toBe('23503');
      expect(error.detail).toContain('is not present in table "videos"');
    });

    it('should clear the pointer of the video when its current session is deleted (SET NULL)', async () => {
      const sessionId = await saveCurrentSession();

      await sessionRepository.delete({ id: sessionId });

      const video = await videoRepository.findOneByOrFail({ id: videoId });
      expect(video.current_upload_session_id).toBeNull();
    });

    it('should delete the sessions and parts of a deleted video, even the current one (CASCADE)', async () => {
      const sessionId = await saveCurrentSession();
      await sessionRepository.insert(buildUploadSession(videoId));
      await dataSource
        .getRepository(UploadPart)
        .insert(buildUploadPart(sessionId));

      await videoRepository.delete({ id: videoId });

      await expect(
        sessionRepository.countBy({ video_id: videoId }),
      ).resolves.toBe(0);
      await expect(
        dataSource
          .getRepository(UploadPart)
          .countBy({ upload_session_id: sessionId }),
      ).resolves.toBe(0);
    });
  });
});
