import { Test } from '@nestjs/testing';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { StorageUnavailableException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import {
  type UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import type { Video } from './entities/video.entity';
import {
  UnsupportedVideoTypeException,
  UploadSessionCompletingException,
  UploadSessionInitiatingException,
  UploadSessionNotActiveException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import {
  type CreationIntent,
  decideRestart,
  type RestartRefusal,
  UploadSessionsRepository,
} from './upload-sessions.repository';
import {
  type UploadDeclaration,
  UploadSessionsService,
} from './upload-sessions.service';
import { ABORT_CONFIRMATION } from './videos.constants';

const USER_ID = 'b6f1c2a4-3d5e-4f60-8a7b-9c0d1e2f3a4b';
const VIDEO_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const PUBLIC_ID = 'AbCdEfGhIjK';
const PREVIOUS_ID = '22222222-3333-4444-8555-666666666666';
const PREVIOUS_KEY = `originals/${VIDEO_ID}/${PREVIOUS_ID}`;
const PREVIOUS_TOKEN = '33333333-4444-4555-8666-777777777777';
const INTENT: CreationIntent = {
  videoId: VIDEO_ID,
  publicId: PUBLIC_ID,
  sessionId: '11111111-2222-4333-8444-555555555555',
  objectKey: `originals/${VIDEO_ID}/11111111-2222-4333-8444-555555555555`,
  claimToken: '99999999-8888-4777-8666-555555555555',
};
const EXPIRES_AT = new Date('2026-11-23T12:00:00.000Z');
const CONFIG = {
  maxSizeBytes: 10_000_000_000,
  uploadPartSizeBytes: 67_108_864,
  uploadSessionTtlSeconds: 86_400,
  uploadSessionClaimTtlSeconds: 300,
};

function previousSession(
  overrides: Partial<UploadSession> = {},
): UploadSession {
  return {
    id: PREVIOUS_ID,
    video_id: VIDEO_ID,
    object_key: PREVIOUS_KEY,
    upload_id: 'previous-upload',
    status: UploadSessionStatus.ABORTING,
    claim_token: PREVIOUS_TOKEN,
    ...overrides,
  } as UploadSession;
}

function declaration(
  overrides: Partial<UploadDeclaration> = {},
): UploadDeclaration {
  return {
    fileName: 'b.mp4',
    sizeBytes: 134_217_728,
    contentType: 'Video/MP4',
    ...overrides,
  };
}

describe('UploadSessionsService.restartSession', () => {
  describe('conduct for each state of the current session (decideRestart, P1)', () => {
    it.each<[UploadSessionStatus, boolean, ReturnType<typeof decideRestart>]>([
      [UploadSessionStatus.ACTIVE, false, 'take'],
      [UploadSessionStatus.INITIATING, true, 'take'],
      [UploadSessionStatus.INITIATING, false, 'initiating'],
      [UploadSessionStatus.COMPLETING, false, 'completing'],
      [UploadSessionStatus.COMPLETING, true, 'completing'],
      [UploadSessionStatus.ABORTING, false, 'proceed'],
      [UploadSessionStatus.ABORTING, true, 'proceed'],
      [UploadSessionStatus.ABORTED, false, 'proceed'],
      [UploadSessionStatus.COMPLETED, false, 'inconsistent'],
    ])(
      '%s with an expired claim = %s → %s',
      (status, claimExpired, conduct) => {
        expect(decideRestart(previousSession({ status }), claimExpired)).toBe(
          conduct,
        );
      },
    );
  });

  describe('service', () => {
    let service: UploadSessionsService;
    let access: { getOwnedVideo: jest.Mock };
    let repository: {
      recordRestartIntent: jest.Mock;
      activateSession: jest.Mock;
      abortInitiatingSession: jest.Mock;
      markAborted: jest.Mock;
    };
    let storage: {
      createMultipartUpload: jest.Mock;
      abortMultipartUpload: jest.Mock;
      listParts: jest.Mock;
      listMultipartUploads: jest.Mock;
    };

    beforeEach(async () => {
      access = {
        getOwnedVideo: jest
          .fn()
          .mockResolvedValue({ id: VIDEO_ID, public_id: PUBLIC_ID } as Video),
      };
      repository = {
        recordRestartIntent: jest.fn().mockResolvedValue({
          outcome: 'recorded',
          intent: INTENT,
          previous: {
            session: previousSession(),
            claimToken: PREVIOUS_TOKEN,
          },
        }),
        activateSession: jest.fn().mockResolvedValue(EXPIRES_AT),
        abortInitiatingSession: jest.fn().mockResolvedValue(true),
        markAborted: jest.fn().mockResolvedValue(true),
      };
      storage = {
        createMultipartUpload: jest
          .fn()
          .mockResolvedValue({ uploadId: 'new-upload' }),
        abortMultipartUpload: jest
          .fn()
          .mockResolvedValue({ status: 'aborted' }),
        listParts: jest.fn().mockResolvedValue({ status: 'no-such-upload' }),
        listMultipartUploads: jest.fn().mockResolvedValue([]),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          UploadSessionsService,
          { provide: ChannelsService, useValue: {} },
          { provide: UploadSessionAccessService, useValue: access },
          { provide: UploadSessionsRepository, useValue: repository },
          { provide: UploadPartsService, useValue: {} },
          { provide: StorageService, useValue: storage },
          { provide: videoConfig.KEY, useValue: CONFIG },
        ],
      }).compile();
      service = moduleRef.get(UploadSessionsService);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function restart(body: UploadDeclaration = declaration()) {
      return service.restartSession(USER_ID, PUBLIC_ID, body);
    }

    function expectNoStorageCall(): void {
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    }

    it('should record T1, create the new multipart, abort the previous session by its token and activate the new one', async () => {
      await expect(restart()).resolves.toEqual({
        publicId: PUBLIC_ID,
        status: 'draft',
        uploadSession: {
          id: INTENT.sessionId,
          status: UploadSessionStatus.ACTIVE,
          partSize: 67_108_864,
          partCount: 2,
          checksumAlgorithm: 'SHA256',
          expiresAt: EXPIRES_AT,
        },
      });

      expect(access.getOwnedVideo).toHaveBeenCalledWith(USER_ID, PUBLIC_ID);
      expect(repository.recordRestartIntent).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        fileName: 'b.mp4',
        sizeBytes: 134_217_728,
        contentType: 'video/mp4',
        plan: { partSize: 67_108_864, partCount: 2 },
        claimTtlSeconds: 300,
      });
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        INTENT.objectKey,
        { contentType: 'video/mp4' },
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        PREVIOUS_KEY,
        'previous-upload',
      );
      expect(repository.markAborted).toHaveBeenCalledWith(
        PREVIOUS_ID,
        PREVIOUS_TOKEN,
      );
      expect(repository.activateSession).toHaveBeenCalledWith({
        sessionId: INTENT.sessionId,
        claimToken: INTENT.claimToken,
        uploadId: 'new-upload',
        sessionTtlSeconds: 86_400,
      });
      const order = [
        repository.recordRestartIntent,
        storage.createMultipartUpload,
        storage.abortMultipartUpload,
        storage.listParts,
        repository.markAborted,
        repository.activateSession,
      ].map((mock) => mock.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('should not abort anything when the current session needed no claim (aborting, aborted or none)', async () => {
      repository.recordRestartIntent.mockResolvedValue({
        outcome: 'recorded',
        intent: INTENT,
        previous: null,
      });

      await expect(restart()).resolves.toMatchObject({
        uploadSession: { id: INTENT.sessionId },
      });
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(repository.markAborted).not.toHaveBeenCalled();
    });

    describe('before T1', () => {
      it('should let the 404 of the ownership lookup through', async () => {
        access.getOwnedVideo.mockRejectedValue(new VideoNotFoundException());

        await expect(restart()).rejects.toBeInstanceOf(VideoNotFoundException);
        expect(repository.recordRestartIntent).not.toHaveBeenCalled();
      });

      it.each([
        [
          'a size above VIDEO_MAX_SIZE_BYTES',
          declaration({ sizeBytes: 10_000_000_001 }),
          VideoTooLargeException,
        ],
        [
          'an unsupported type',
          declaration({ contentType: 'video/quicktime' }),
          UnsupportedVideoTypeException,
        ],
      ])(
        'should refuse %s with the domain rules of the creation, recording nothing',
        async (_, body, exception) => {
          await expect(restart(body)).rejects.toBeInstanceOf(exception);
          expect(repository.recordRestartIntent).not.toHaveBeenCalled();
          expectNoStorageCall();
        },
      );
    });

    it.each<[RestartRefusal, new () => Error]>([
      ['video-not-found', VideoNotFoundException],
      ['video-not-draft', VideoInvalidStateException],
      ['inconsistent', VideoInvalidStateException],
      ['completing', UploadSessionCompletingException],
      ['initiating', UploadSessionInitiatingException],
    ])(
      'should answer the refusal %s of T1 with its error, without calling the storage',
      async (reason, exception) => {
        repository.recordRestartIntent.mockResolvedValue({
          outcome: 'refused',
          reason,
        });

        await expect(restart()).rejects.toBeInstanceOf(exception);
        expectNoStorageCall();
        expect(repository.activateSession).not.toHaveBeenCalled();
      },
    );

    describe('failure of the CreateMultipartUpload', () => {
      it('should mark the new session aborted by its token, still abort the previous one and answer STORAGE_UNAVAILABLE', async () => {
        const failure = new StorageUnavailableException(
          'CreateMultipartUpload',
        );
        storage.createMultipartUpload.mockRejectedValue(failure);

        await expect(restart()).rejects.toBe(failure);
        expect(repository.abortInitiatingSession).toHaveBeenCalledWith(INTENT);
        expect(repository.markAborted).toHaveBeenCalledWith(
          PREVIOUS_ID,
          PREVIOUS_TOKEN,
        );
        expect(repository.activateSession).not.toHaveBeenCalled();
      });

      it.each([
        ['taken over (zero rows)', () => Promise.resolve(false)],
        ['failing', () => Promise.reject(new Error('connection lost'))],
      ])(
        'should keep the storage failure when the abandon of the new session is %s',
        async (_, abandon) => {
          const failure = new StorageUnavailableException(
            'CreateMultipartUpload',
          );
          storage.createMultipartUpload.mockRejectedValue(failure);
          repository.abortInitiatingSession.mockImplementation(abandon);

          await expect(restart()).rejects.toBe(failure);
        },
      );
    });

    describe('abort of the previous session', () => {
      it('should activate the new session and leave the previous one aborting when the storage does not confirm (F-09)', async () => {
        jest.useFakeTimers();
        storage.listParts.mockResolvedValue({ status: 'found', parts: [] });

        const restarting = restart();
        await jest.advanceTimersByTimeAsync(
          ABORT_CONFIRMATION.RETRY_DELAY_MS * ABORT_CONFIRMATION.ATTEMPTS,
        );

        await expect(restarting).resolves.toMatchObject({
          uploadSession: { id: INTENT.sessionId },
        });
        expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(
          ABORT_CONFIRMATION.ATTEMPTS,
        );
        expect(repository.markAborted).not.toHaveBeenCalled();
        expect(repository.activateSession).toHaveBeenCalled();
      });

      it('should find the uploads of a previous session without upload_id at its key', async () => {
        repository.recordRestartIntent.mockResolvedValue({
          outcome: 'recorded',
          intent: INTENT,
          previous: {
            session: previousSession({ upload_id: null }),
            claimToken: PREVIOUS_TOKEN,
          },
        });
        storage.listMultipartUploads.mockResolvedValue([
          { key: PREVIOUS_KEY, uploadId: 'orphan' },
          { key: INTENT.objectKey, uploadId: 'new-upload' },
        ]);

        await restart();

        expect(storage.abortMultipartUpload.mock.calls).toEqual([
          [PREVIOUS_KEY, 'orphan'],
        ]);
        expect(repository.markAborted).toHaveBeenCalled();
      });

      it('should still activate the new session when the abort of the previous one fails', async () => {
        storage.abortMultipartUpload.mockRejectedValue(
          new Error('AccessDenied'),
        );

        await expect(restart()).resolves.toMatchObject({
          uploadSession: { id: INTENT.sessionId },
        });
        expect(repository.markAborted).not.toHaveBeenCalled();
      });
    });

    describe('T2 (activation conditioned on the token)', () => {
      it('should abort the own upload and answer UPLOAD_SESSION_NOT_ACTIVE when T2 affects zero rows', async () => {
        repository.activateSession.mockResolvedValue(null);

        await expect(restart()).rejects.toBeInstanceOf(
          UploadSessionNotActiveException,
        );
        expect(storage.abortMultipartUpload).toHaveBeenLastCalledWith(
          INTENT.objectKey,
          'new-upload',
        );
      });

      it('should abort the own upload and rethrow when T2 itself fails', async () => {
        const failure = new Error('connection lost');
        repository.activateSession.mockRejectedValue(failure);

        await expect(restart()).rejects.toBe(failure);
        expect(storage.abortMultipartUpload).toHaveBeenLastCalledWith(
          INTENT.objectKey,
          'new-upload',
        );
      });
    });
  });
});
