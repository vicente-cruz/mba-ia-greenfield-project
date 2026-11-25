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
  UploadSessionCompletingException,
  UploadSessionInitiatingException,
  UploadSessionNotActiveException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import {
  type AbortRefusal,
  decideAbort,
  UploadSessionsRepository,
} from './upload-sessions.repository';
import { UploadSessionsService } from './upload-sessions.service';
import { ABORT_CONFIRMATION } from './videos.constants';

const USER_ID = 'b6f1c2a4-3d5e-4f60-8a7b-9c0d1e2f3a4b';
const VIDEO_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const PUBLIC_ID = 'AbCdEfGhIjK';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const OBJECT_KEY = `originals/${VIDEO_ID}/${SESSION_ID}`;
const CLAIM_TOKEN = '99999999-8888-4777-8666-555555555555';

function session(overrides: Partial<UploadSession> = {}): UploadSession {
  return {
    id: SESSION_ID,
    video_id: VIDEO_ID,
    object_key: OBJECT_KEY,
    upload_id: 'upload-1',
    status: UploadSessionStatus.ABORTING,
    claim_token: CLAIM_TOKEN,
    ...overrides,
  } as UploadSession;
}

describe('UploadSessionsService.abortSession', () => {
  describe('conduct for each state of origin (decideAbort, F-07)', () => {
    it.each<
      [
        UploadSessionStatus,
        boolean,
        ReturnType<typeof decideAbort>['outcome'],
        AbortRefusal | null,
      ]
    >([
      [UploadSessionStatus.ACTIVE, false, 'take', null],
      [UploadSessionStatus.INITIATING, true, 'take', null],
      [UploadSessionStatus.INITIATING, false, 'refused', 'initiating'],
      [UploadSessionStatus.ABORTING, true, 'take', null],
      [UploadSessionStatus.ABORTING, false, 'nothing-to-do', null],
      [UploadSessionStatus.ABORTED, false, 'nothing-to-do', null],
      [UploadSessionStatus.COMPLETING, false, 'refused', 'completing'],
      [UploadSessionStatus.COMPLETING, true, 'refused', 'completing'],
      [UploadSessionStatus.COMPLETED, false, 'refused', 'completed'],
    ])(
      '%s with an expired claim = %s → %s (%s)',
      (status, claimExpired, outcome, reason) => {
        const decision = decideAbort(session({ status }), claimExpired);

        expect(decision.outcome).toBe(outcome);
        if (decision.outcome === 'refused') {
          expect(decision.reason).toBe(reason);
        }
      },
    );
  });

  describe('service', () => {
    let service: UploadSessionsService;
    let access: { getOwnedSession: jest.Mock };
    let repository: { claimAbort: jest.Mock; markAborted: jest.Mock };
    let storage: {
      abortMultipartUpload: jest.Mock;
      listParts: jest.Mock;
      listMultipartUploads: jest.Mock;
    };

    beforeEach(async () => {
      access = {
        getOwnedSession: jest.fn().mockResolvedValue({
          video: { id: VIDEO_ID } as Video,
          session: session({ status: UploadSessionStatus.ACTIVE }),
          expired: false,
        }),
      };
      repository = {
        claimAbort: jest.fn().mockResolvedValue({
          outcome: 'claimed',
          claimToken: CLAIM_TOKEN,
          session: session(),
        }),
        markAborted: jest.fn().mockResolvedValue(true),
      };
      storage = {
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
          {
            provide: videoConfig.KEY,
            useValue: { uploadSessionClaimTtlSeconds: 300 },
          },
        ],
      }).compile();
      service = moduleRef.get(UploadSessionsService);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function abort() {
      return service.abortSession(USER_ID, PUBLIC_ID, SESSION_ID);
    }

    function claimed(overrides: Partial<UploadSession>): void {
      repository.claimAbort.mockResolvedValue({
        outcome: 'claimed',
        claimToken: CLAIM_TOKEN,
        session: session(overrides),
      });
    }

    function expectNoStorageCall(): void {
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(storage.listParts).not.toHaveBeenCalled();
      expect(storage.listMultipartUploads).not.toHaveBeenCalled();
    }

    it('should claim under the lock, abort the upload, confirm it by ListParts and only then mark it aborted by the token', async () => {
      await expect(abort()).resolves.toBeUndefined();

      expect(access.getOwnedSession).toHaveBeenCalledWith(
        USER_ID,
        PUBLIC_ID,
        SESSION_ID,
      );
      expect(repository.claimAbort).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        sessionId: SESSION_ID,
        claimTtlSeconds: 300,
      });
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        OBJECT_KEY,
        'upload-1',
      );
      expect(storage.listParts).toHaveBeenCalledWith(OBJECT_KEY, 'upload-1', {
        pageSize: 1_000,
      });
      expect(repository.markAborted).toHaveBeenCalledWith(
        SESSION_ID,
        CLAIM_TOKEN,
      );
      const order = [
        repository.claimAbort,
        storage.abortMultipartUpload,
        storage.listParts,
        repository.markAborted,
      ].map((mock) => mock.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(storage.listMultipartUploads).not.toHaveBeenCalled();
    });

    it('should find the uploads of a session without upload_id at its exact key, and abort each of them', async () => {
      claimed({ upload_id: null });
      storage.listMultipartUploads.mockResolvedValue([
        { key: OBJECT_KEY, uploadId: 'orphan-1' },
        { key: `${OBJECT_KEY}-other`, uploadId: 'not-ours' },
        { key: OBJECT_KEY, uploadId: 'orphan-2' },
      ]);

      await abort();

      expect(storage.listMultipartUploads).toHaveBeenCalledWith(OBJECT_KEY);
      expect(storage.abortMultipartUpload.mock.calls).toEqual([
        [OBJECT_KEY, 'orphan-1'],
        [OBJECT_KEY, 'orphan-2'],
      ]);
      expect(repository.markAborted).toHaveBeenCalledWith(
        SESSION_ID,
        CLAIM_TOKEN,
      );
    });

    it('should mark aborted a session without upload_id when no upload is open at its key', async () => {
      claimed({ upload_id: null });

      await abort();

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(repository.markAborted).toHaveBeenCalled();
    });

    it('should repeat the abort while the upload is still listed and mark it once ListParts answers NoSuchUpload', async () => {
      jest.useFakeTimers();
      storage.listParts
        .mockResolvedValueOnce({ status: 'found', parts: [] })
        .mockResolvedValueOnce({ status: 'no-such-upload' });

      const aborting = abort();
      await jest.advanceTimersByTimeAsync(ABORT_CONFIRMATION.RETRY_DELAY_MS);
      await aborting;

      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(2);
      expect(repository.markAborted).toHaveBeenCalled();
    });

    it('should stop after the last attempt and keep the session aborting for the sweep when a part in transit keeps the upload listed (F-09)', async () => {
      jest.useFakeTimers();
      storage.listParts.mockResolvedValue({ status: 'found', parts: [] });

      const aborting = abort();
      await jest.advanceTimersByTimeAsync(
        ABORT_CONFIRMATION.RETRY_DELAY_MS * ABORT_CONFIRMATION.ATTEMPTS,
      );

      await expect(aborting).resolves.toBeUndefined();
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(
        ABORT_CONFIRMATION.ATTEMPTS,
      );
      expect(repository.markAborted).not.toHaveBeenCalled();
    });

    it('should not mark the session when one of its uploads is not confirmed', async () => {
      jest.useFakeTimers();
      claimed({ upload_id: null });
      storage.listMultipartUploads.mockResolvedValue([
        { key: OBJECT_KEY, uploadId: 'gone' },
        { key: OBJECT_KEY, uploadId: 'in-transit' },
      ]);
      storage.listParts.mockImplementation((_key: string, uploadId: string) =>
        Promise.resolve(
          uploadId === 'gone'
            ? { status: 'no-such-upload' }
            : { status: 'found', parts: [] },
        ),
      );

      const aborting = abort();
      await jest.advanceTimersByTimeAsync(
        ABORT_CONFIRMATION.RETRY_DELAY_MS * ABORT_CONFIRMATION.ATTEMPTS,
      );
      await aborting;

      expect(repository.markAborted).not.toHaveBeenCalled();
    });

    it.each([
      ['AbortMultipartUpload', 'abortMultipartUpload'],
      ['ListParts', 'listParts'],
    ] as const)(
      'should keep the session aborting for the sweep when %s fails transiently, without marking it',
      async (operation, method) => {
        storage[method].mockRejectedValue(
          new StorageUnavailableException(operation),
        );

        await expect(abort()).resolves.toBeUndefined();
        expect(repository.markAborted).not.toHaveBeenCalled();
      },
    );

    it('should let a non-transient storage error through, without marking the session', async () => {
      const failure = new Error('AccessDenied');
      storage.abortMultipartUpload.mockRejectedValue(failure);

      await expect(abort()).rejects.toBe(failure);
      expect(repository.markAborted).not.toHaveBeenCalled();
    });

    it('should not overwrite a session taken over before the mark: zero rows end the call without error', async () => {
      repository.markAborted.mockResolvedValue(false);

      await expect(abort()).resolves.toBeUndefined();
    });

    it('should do nothing for an aborted session or one aborting within the claim of another operation', async () => {
      repository.claimAbort.mockResolvedValue({
        outcome: 'nothing-to-do',
        session: session({ status: UploadSessionStatus.ABORTED }),
      });

      await expect(abort()).resolves.toBeUndefined();
      expectNoStorageCall();
      expect(repository.markAborted).not.toHaveBeenCalled();
    });

    it.each<[AbortRefusal, new () => Error]>([
      ['video-not-found', VideoNotFoundException],
      ['session-not-found', UploadSessionNotFoundException],
      ['initiating', UploadSessionInitiatingException],
      ['completing', UploadSessionCompletingException],
      ['completed', UploadSessionNotActiveException],
    ])(
      'should answer %s with its error, without calling the storage',
      async (reason, exception) => {
        repository.claimAbort.mockResolvedValue({ outcome: 'refused', reason });

        await expect(abort()).rejects.toBeInstanceOf(exception);
        expectNoStorageCall();
        expect(repository.markAborted).not.toHaveBeenCalled();
      },
    );

    it('should let the 404 of the ownership lookup through, claiming nothing', async () => {
      access.getOwnedSession.mockRejectedValue(new VideoNotFoundException());

      await expect(abort()).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repository.claimAbort).not.toHaveBeenCalled();
    });
  });
});
