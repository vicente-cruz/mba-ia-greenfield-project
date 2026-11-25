import { Test } from '@nestjs/testing';
import { ChannelsService } from '../channels/channels.service';
import type { Channel } from '../channels/entities/channel.entity';
import videoConfig from '../config/video.config';
import { StorageUnavailableException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import {
  type UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import type { Video } from './entities/video.entity';
import {
  ChannelNotFoundException,
  UnsupportedVideoTypeException,
  UploadSessionExpiredException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import {
  type ClassifiedPart,
  UploadPartState,
} from './upload-part-classification';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import {
  type CreationIntent,
  UploadSessionsRepository,
} from './upload-sessions.repository';
import {
  type UploadDeclaration,
  UploadSessionsService,
} from './upload-sessions.service';

const CONFIG = {
  maxSizeBytes: 10_000_000_000,
  uploadPartSizeBytes: 67_108_864,
  uploadSessionTtlSeconds: 86_400,
  uploadSessionClaimTtlSeconds: 300,
};

const USER_ID = 'b6f1c2a4-3d5e-4f60-8a7b-9c0d1e2f3a4b';
const CHANNEL = { id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f' } as Channel;
const INTENT: CreationIntent = {
  videoId: '0f1e2d3c-4b5a-4968-8776-655443322110',
  publicId: 'AbCdEfGhIjK',
  sessionId: '11111111-2222-4333-8444-555555555555',
  objectKey:
    'originals/0f1e2d3c-4b5a-4968-8776-655443322110/11111111-2222-4333-8444-555555555555',
  claimToken: '99999999-8888-4777-8666-555555555555',
};
const EXPIRES_AT = new Date('2026-11-23T12:00:00.000Z');

function declaration(
  overrides: Partial<UploadDeclaration> = {},
): UploadDeclaration {
  return {
    fileName: 'a.mp4',
    sizeBytes: 10_000_000_000,
    contentType: 'video/mp4',
    ...overrides,
  };
}

describe('UploadSessionsService', () => {
  let service: UploadSessionsService;
  let channels: { findByUserId: jest.Mock };
  let repository: {
    recordCreationIntent: jest.Mock;
    activateSession: jest.Mock;
    compensateCreation: jest.Mock;
    claimVanishedUpload: jest.Mock;
    markAborted: jest.Mock;
  };
  let access: { getOwnedSession: jest.Mock };
  let parts: { classifyParts: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };

  beforeEach(async () => {
    channels = { findByUserId: jest.fn().mockResolvedValue(CHANNEL) };
    repository = {
      recordCreationIntent: jest.fn().mockResolvedValue(INTENT),
      activateSession: jest.fn().mockResolvedValue(EXPIRES_AT),
      compensateCreation: jest.fn().mockResolvedValue(true),
      claimVanishedUpload: jest.fn(),
      markAborted: jest.fn().mockResolvedValue(true),
    };
    access = { getOwnedSession: jest.fn() };
    parts = { classifyParts: jest.fn() };
    storage = {
      createMultipartUpload: jest
        .fn()
        .mockResolvedValue({ uploadId: 'upload-1' }),
      abortMultipartUpload: jest.fn().mockResolvedValue({ status: 'aborted' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadSessionsService,
        { provide: ChannelsService, useValue: channels },
        { provide: UploadSessionAccessService, useValue: access },
        { provide: UploadSessionsRepository, useValue: repository },
        { provide: UploadPartsService, useValue: parts },
        { provide: StorageService, useValue: storage },
        { provide: videoConfig.KEY, useValue: CONFIG },
      ],
    }).compile();
    service = moduleRef.get(UploadSessionsService);
  });

  it('should record the intent, create the multipart outside it and activate the session', async () => {
    const result = await service.createVideoWithSession(USER_ID, declaration());

    expect(channels.findByUserId).toHaveBeenCalledWith(USER_ID);
    expect(repository.recordCreationIntent).toHaveBeenCalledWith({
      channelId: CHANNEL.id,
      fileName: 'a.mp4',
      sizeBytes: 10_000_000_000,
      contentType: 'video/mp4',
      plan: { partSize: 67_108_864, partCount: 150 },
      claimTtlSeconds: 300,
    });
    expect(storage.createMultipartUpload).toHaveBeenCalledWith(
      INTENT.objectKey,
      { contentType: 'video/mp4' },
    );
    expect(repository.activateSession).toHaveBeenCalledWith({
      sessionId: INTENT.sessionId,
      claimToken: INTENT.claimToken,
      uploadId: 'upload-1',
      sessionTtlSeconds: 86_400,
    });
    const order = [
      repository.recordCreationIntent,
      storage.createMultipartUpload,
      repository.activateSession,
    ].map((mock) => mock.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(result).toEqual({
      publicId: INTENT.publicId,
      status: 'draft',
      uploadSession: {
        id: INTENT.sessionId,
        status: 'active',
        partSize: 67_108_864,
        partCount: 150,
        checksumAlgorithm: 'SHA256',
        expiresAt: EXPIRES_AT,
      },
    });
    expect(JSON.stringify(result)).not.toContain(INTENT.videoId);
  });

  describe('domain rules (before T1)', () => {
    it('should refuse a size above VIDEO_MAX_SIZE_BYTES with 413 and the limit in the message', async () => {
      const promise = service.createVideoWithSession(
        USER_ID,
        declaration({ sizeBytes: 10_000_000_001 }),
      );

      await expect(promise).rejects.toBeInstanceOf(VideoTooLargeException);
      await expect(promise).rejects.toMatchObject({
        errorCode: 'VIDEO_TOO_LARGE',
        httpStatus: 413,
        message: expect.stringContaining('10000000000') as string,
      });
      expect(channels.findByUserId).not.toHaveBeenCalled();
      expect(repository.recordCreationIntent).not.toHaveBeenCalled();
    });

    it('should accept exactly VIDEO_MAX_SIZE_BYTES', async () => {
      await expect(
        service.createVideoWithSession(
          USER_ID,
          declaration({ sizeBytes: 10_000_000_000 }),
        ),
      ).resolves.toBeDefined();
    });

    it.each(['video/quicktime', 'video/x-matroska', 'image/png'])(
      'should refuse %s with 415',
      async (contentType) => {
        await expect(
          service.createVideoWithSession(USER_ID, declaration({ contentType })),
        ).rejects.toBeInstanceOf(UnsupportedVideoTypeException);
        expect(repository.recordCreationIntent).not.toHaveBeenCalled();
      },
    );

    it('should accept the types case-insensitively and store them in lowercase', async () => {
      await service.createVideoWithSession(
        USER_ID,
        declaration({ contentType: 'Video/WebM' }),
      );

      expect(repository.recordCreationIntent).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'video/webm' }),
      );
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        INTENT.objectKey,
        { contentType: 'video/webm' },
      );
    });

    it('should answer CHANNEL_NOT_FOUND when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(
        service.createVideoWithSession(USER_ID, declaration()),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
      expect(repository.recordCreationIntent).not.toHaveBeenCalled();
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('CreateMultipartUpload failure (compensation)', () => {
    it('should compensate the intent and answer STORAGE_UNAVAILABLE', async () => {
      const failure = new StorageUnavailableException('CreateMultipartUpload');
      storage.createMultipartUpload.mockRejectedValue(failure);

      await expect(
        service.createVideoWithSession(USER_ID, declaration()),
      ).rejects.toBe(failure);
      expect(repository.compensateCreation).toHaveBeenCalledWith(INTENT);
      expect(repository.activateSession).not.toHaveBeenCalled();
    });

    it('should still answer STORAGE_UNAVAILABLE when the session was taken over and nothing is compensated', async () => {
      const failure = new StorageUnavailableException('CreateMultipartUpload');
      storage.createMultipartUpload.mockRejectedValue(failure);
      repository.compensateCreation.mockResolvedValue(false);

      await expect(
        service.createVideoWithSession(USER_ID, declaration()),
      ).rejects.toBe(failure);
    });

    it('should keep the storage failure when the compensation itself fails', async () => {
      const failure = new StorageUnavailableException('CreateMultipartUpload');
      storage.createMultipartUpload.mockRejectedValue(failure);
      repository.compensateCreation.mockRejectedValue(
        new Error('connection lost'),
      );

      await expect(
        service.createVideoWithSession(USER_ID, declaration()),
      ).rejects.toBe(failure);
    });

    it('should compensate and rethrow a non-transient storage error unchanged', async () => {
      const accessDenied = Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
      });
      storage.createMultipartUpload.mockRejectedValue(accessDenied);

      await expect(
        service.createVideoWithSession(USER_ID, declaration()),
      ).rejects.toBe(accessDenied);
      expect(repository.compensateCreation).toHaveBeenCalledWith(INTENT);
    });
  });

  describe('T2 (activation conditioned on the token)', () => {
    it('should abort the own upload and answer STORAGE_UNAVAILABLE when T2 affects zero rows, without compensation', async () => {
      repository.activateSession.mockResolvedValue(null);

      await expect(
        service.createVideoWithSession(USER_ID, declaration()),
      ).rejects.toMatchObject({
        errorCode: 'STORAGE_UNAVAILABLE',
        httpStatus: 503,
      });
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        INTENT.objectKey,
        'upload-1',
      );
      expect(repository.compensateCreation).not.toHaveBeenCalled();
    });

    it('should answer STORAGE_UNAVAILABLE even when the abort of the own upload fails', async () => {
      repository.activateSession.mockResolvedValue(null);
      storage.abortMultipartUpload.mockRejectedValue(
        new StorageUnavailableException('AbortMultipartUpload'),
      );

      await expect(
        service.createVideoWithSession(USER_ID, declaration()),
      ).rejects.toBeInstanceOf(StorageUnavailableException);
    });

    it('should abort the own upload and rethrow when T2 itself fails', async () => {
      const databaseError = new Error('connection terminated');
      repository.activateSession.mockRejectedValue(databaseError);

      await expect(
        service.createVideoWithSession(USER_ID, declaration()),
      ).rejects.toBe(databaseError);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        INTENT.objectKey,
        'upload-1',
      );
      expect(repository.compensateCreation).not.toHaveBeenCalled();
    });
  });

  describe('getSession', () => {
    const SESSION_ID = INTENT.sessionId;
    const VIDEO = { id: INTENT.videoId } as Video;
    const CLASSIFIED: ClassifiedPart[] = [
      {
        partNumber: 1,
        state: UploadPartState.CONFIRMED,
        checksumSha256: 'A'.repeat(43) + '=',
        etag: '"a"',
      },
      {
        partNumber: 2,
        state: UploadPartState.MISSING,
        checksumSha256: null,
        etag: null,
      },
    ];

    function session(overrides: Partial<UploadSession> = {}): UploadSession {
      return {
        id: SESSION_ID,
        video_id: INTENT.videoId,
        object_key: INTENT.objectKey,
        upload_id: 'upload-1',
        status: UploadSessionStatus.ACTIVE,
        size_bytes: 134_217_728,
        part_size: 67_108_864,
        part_count: 2,
        expires_at: EXPIRES_AT,
        file_mismatch_at: null,
        ...overrides,
      } as UploadSession;
    }

    function owning(current: UploadSession, expired = false): void {
      access.getOwnedSession.mockResolvedValue({
        video: VIDEO,
        session: current,
        expired,
      });
    }

    function getSession() {
      return service.getSession(USER_ID, INTENT.publicId, SESSION_ID);
    }

    it('should classify the parts of an active session and report its state', async () => {
      owning(session());
      parts.classifyParts.mockResolvedValue({
        status: 'found',
        parts: CLASSIFIED,
        extraPartNumbers: [],
      });

      await expect(getSession()).resolves.toEqual({
        id: SESSION_ID,
        status: UploadSessionStatus.ACTIVE,
        expired: false,
        fileMismatch: false,
        partSize: 67_108_864,
        partCount: 2,
        checksumAlgorithm: 'SHA256',
        expiresAt: EXPIRES_AT,
        parts: CLASSIFIED,
      });
      expect(access.getOwnedSession).toHaveBeenCalledWith(
        USER_ID,
        INTENT.publicId,
        SESSION_ID,
      );
      expect(parts.classifyParts).toHaveBeenCalledWith(session());
    });

    it('should keep the contract of the GET: parts listed beyond the plan are not reported', async () => {
      owning(session());
      parts.classifyParts.mockResolvedValue({
        status: 'found',
        parts: CLASSIFIED,
        extraPartNumbers: [3, 4],
      });

      const result = await getSession();

      expect(result.parts).toEqual(CLASSIFIED);
      expect(Object.keys(result).sort()).toEqual([
        'checksumAlgorithm',
        'expired',
        'expiresAt',
        'fileMismatch',
        'id',
        'partCount',
        'partSize',
        'parts',
        'status',
      ]);
    });

    it('should report an expired active session and still classify its parts, without aborting it', async () => {
      owning(session({ file_mismatch_at: new Date() }), true);
      parts.classifyParts.mockResolvedValue({
        status: 'found',
        parts: CLASSIFIED,
        extraPartNumbers: [],
      });

      await expect(getSession()).resolves.toMatchObject({
        status: UploadSessionStatus.ACTIVE,
        expired: true,
        fileMismatch: true,
        parts: CLASSIFIED,
      });
      expect(repository.claimVanishedUpload).not.toHaveBeenCalled();
    });

    it.each([
      UploadSessionStatus.INITIATING,
      UploadSessionStatus.COMPLETING,
      UploadSessionStatus.COMPLETED,
      UploadSessionStatus.ABORTING,
      UploadSessionStatus.ABORTED,
    ])(
      'should answer parts: [] and expired: false for a session in %s, without listing the storage',
      async (status) => {
        owning(session({ status }), true);

        await expect(getSession()).resolves.toMatchObject({
          status,
          expired: false,
          parts: [],
        });
        expect(parts.classifyParts).not.toHaveBeenCalled();
      },
    );

    it('should let the 404 of the ownership lookup through', async () => {
      access.getOwnedSession.mockRejectedValue(new VideoNotFoundException());

      await expect(getSession()).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(parts.classifyParts).not.toHaveBeenCalled();
    });

    describe('upload unknown to the storage (F-10)', () => {
      beforeEach(() => {
        owning(session());
        parts.classifyParts.mockResolvedValue({
          status: 'no-such-upload',
          uploadId: 'upload-1',
        });
      });

      it('should claim the session under the lock, mark it aborted by the token and answer UPLOAD_SESSION_EXPIRED', async () => {
        repository.claimVanishedUpload.mockResolvedValue({
          claimed: true,
          claimToken: 'token-1',
        });

        await expect(getSession()).rejects.toBeInstanceOf(
          UploadSessionExpiredException,
        );
        expect(repository.claimVanishedUpload).toHaveBeenCalledWith({
          videoId: INTENT.videoId,
          sessionId: SESSION_ID,
          uploadId: 'upload-1',
          claimTtlSeconds: 300,
        });
        expect(repository.markAborted).toHaveBeenCalledWith(
          SESSION_ID,
          'token-1',
        );
        expect(
          repository.claimVanishedUpload.mock.invocationCallOrder[0],
        ).toBeLessThan(repository.markAborted.mock.invocationCallOrder[0]);
      });

      it('should still answer UPLOAD_SESSION_EXPIRED when the claimed session was taken over before being marked aborted', async () => {
        repository.claimVanishedUpload.mockResolvedValue({
          claimed: true,
          claimToken: 'token-1',
        });
        repository.markAborted.mockResolvedValue(false);

        await expect(getSession()).rejects.toBeInstanceOf(
          UploadSessionExpiredException,
        );
      });

      it('should keep and return the state of a session moved by a concurrent operation, without marking it', async () => {
        const completing = session({ status: UploadSessionStatus.COMPLETING });
        repository.claimVanishedUpload.mockResolvedValue({
          claimed: false,
          session: completing,
        });

        await expect(getSession()).resolves.toMatchObject({
          status: UploadSessionStatus.COMPLETING,
          expired: false,
          parts: [],
        });
        expect(repository.markAborted).not.toHaveBeenCalled();
      });

      it('should answer UPLOAD_SESSION_NOT_FOUND when the session no longer exists at the claim', async () => {
        repository.claimVanishedUpload.mockResolvedValue({
          claimed: false,
          session: null,
        });

        await expect(getSession()).rejects.toBeInstanceOf(
          UploadSessionNotFoundException,
        );
        expect(repository.markAborted).not.toHaveBeenCalled();
      });
    });

    it('should answer STORAGE_UNAVAILABLE for a transient failure of ListParts, without claiming the session', async () => {
      owning(session());
      parts.classifyParts.mockRejectedValue(
        new StorageUnavailableException('ListParts'),
      );

      await expect(getSession()).rejects.toBeInstanceOf(
        StorageUnavailableException,
      );
      expect(repository.claimVanishedUpload).not.toHaveBeenCalled();
      expect(repository.markAborted).not.toHaveBeenCalled();
    });
  });
});
