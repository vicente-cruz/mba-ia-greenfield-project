import { Test } from '@nestjs/testing';
import type { UploadSession } from './entities/upload-session.entity';
import type { Video } from './entities/video.entity';
import {
  UploadSessionNotFoundException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';

const USER_ID = 'b6f1c2a4-3d5e-4f60-8a7b-9c0d1e2f3a4b';
const VIDEO_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const PUBLIC_ID = 'AbCdEfGhIjK';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

describe('UploadSessionAccessService', () => {
  let service: UploadSessionAccessService;
  let repository: { findOwnedSession: jest.Mock; findOwnedVideo: jest.Mock };

  beforeEach(async () => {
    repository = { findOwnedSession: jest.fn(), findOwnedVideo: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadSessionAccessService,
        { provide: UploadSessionsRepository, useValue: repository },
      ],
    }).compile();
    service = moduleRef.get(UploadSessionAccessService);
  });

  describe('getOwnedVideo', () => {
    it('should answer VIDEO_NOT_FOUND for a malformed publicId, without querying', async () => {
      await expect(
        service.getOwnedVideo(USER_ID, 'short'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repository.findOwnedVideo).not.toHaveBeenCalled();
    });

    it('should answer VIDEO_NOT_FOUND for a missing video or a video of another channel', async () => {
      repository.findOwnedVideo.mockResolvedValue(null);

      await expect(
        service.getOwnedVideo(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repository.findOwnedVideo).toHaveBeenCalledWith(
        USER_ID,
        PUBLIC_ID,
      );
    });

    it('should return the video of the owner', async () => {
      const video = { id: VIDEO_ID } as Video;
      repository.findOwnedVideo.mockResolvedValue(video);

      await expect(service.getOwnedVideo(USER_ID, PUBLIC_ID)).resolves.toBe(
        video,
      );
    });
  });

  describe('getOwnedSession', () => {
    it('should answer VIDEO_NOT_FOUND for a malformed publicId, without querying', async () => {
      await expect(
        service.getOwnedSession(USER_ID, 'short', SESSION_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repository.findOwnedSession).not.toHaveBeenCalled();
    });

    it('should answer UPLOAD_SESSION_NOT_FOUND for a malformed sessionId, without querying', async () => {
      await expect(
        service.getOwnedSession(USER_ID, PUBLIC_ID, 'not-a-uuid'),
      ).rejects.toBeInstanceOf(UploadSessionNotFoundException);
      expect(repository.findOwnedSession).not.toHaveBeenCalled();
    });

    it('should answer VIDEO_NOT_FOUND for a missing video or a video of another channel', async () => {
      repository.findOwnedSession.mockResolvedValue({ found: 'none' });

      await expect(
        service.getOwnedSession(USER_ID, PUBLIC_ID, SESSION_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repository.findOwnedSession).toHaveBeenCalledWith(
        USER_ID,
        PUBLIC_ID,
        SESSION_ID,
      );
    });

    it('should answer UPLOAD_SESSION_NOT_FOUND for a session of another video', async () => {
      repository.findOwnedSession.mockResolvedValue({
        found: 'video',
        video: {} as Video,
      });

      await expect(
        service.getOwnedSession(USER_ID, PUBLIC_ID, SESSION_ID),
      ).rejects.toBeInstanceOf(UploadSessionNotFoundException);
    });

    it('should return the video, the session and the expiry, looking up the sessionId in lowercase', async () => {
      const video = { id: VIDEO_ID } as Video;
      const session = { id: SESSION_ID } as UploadSession;
      repository.findOwnedSession.mockResolvedValue({
        found: 'session',
        video,
        session,
        expired: true,
      });

      await expect(
        service.getOwnedSession(USER_ID, PUBLIC_ID, SESSION_ID.toUpperCase()),
      ).resolves.toEqual({ video, session, expired: true });
      expect(repository.findOwnedSession).toHaveBeenCalledWith(
        USER_ID,
        PUBLIC_ID,
        SESSION_ID,
      );
    });
  });
});
