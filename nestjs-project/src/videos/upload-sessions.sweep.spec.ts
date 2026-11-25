import { Test } from '@nestjs/testing';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { StorageUnavailableException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import {
  type UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import {
  decideSweep,
  UploadSessionsRepository,
} from './upload-sessions.repository';
import { UploadSessionsService } from './upload-sessions.service';
import { ABORT_CONFIRMATION } from './videos.constants';

const VIDEO_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
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

describe('sweep of upload sessions (SI-03.24)', () => {
  describe('decideSweep: what the sweep claims for abort under the lock', () => {
    it.each<[UploadSessionStatus, boolean, boolean, boolean]>([
      // status, claim expired, session expired, claimed for abort
      [UploadSessionStatus.ACTIVE, false, true, true],
      [UploadSessionStatus.ACTIVE, false, false, false],
      [UploadSessionStatus.INITIATING, true, false, true],
      [UploadSessionStatus.INITIATING, false, true, false],
      [UploadSessionStatus.ABORTING, true, false, true],
      [UploadSessionStatus.ABORTING, false, true, false],
      // A completing session is resumed, never aborted, whatever its deadlines.
      [UploadSessionStatus.COMPLETING, true, true, false],
      [UploadSessionStatus.COMPLETING, false, true, false],
      [UploadSessionStatus.COMPLETED, true, true, false],
      [UploadSessionStatus.ABORTED, true, true, false],
    ])(
      '%s with claim expired = %s and session expired = %s → %s',
      (status, claimExpired, expired, take) => {
        expect(decideSweep(session({ status }), claimExpired, expired)).toBe(
          take,
        );
      },
    );
  });

  describe('UploadSessionsService.sweepAbort', () => {
    let service: UploadSessionsService;
    let repository: { claimForSweep: jest.Mock; markAborted: jest.Mock };
    let storage: {
      abortMultipartUpload: jest.Mock;
      listParts: jest.Mock;
      listMultipartUploads: jest.Mock;
    };

    beforeEach(async () => {
      repository = {
        claimForSweep: jest.fn().mockResolvedValue({
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
          { provide: UploadSessionAccessService, useValue: {} },
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

    it('should mark aborted by the token of the sweep only after NoSuchUpload', async () => {
      await expect(service.sweepAbort(VIDEO_ID, SESSION_ID)).resolves.toBe(
        'aborted',
      );

      expect(repository.claimForSweep).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        sessionId: SESSION_ID,
        claimTtlSeconds: 300,
      });
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        OBJECT_KEY,
        'upload-1',
      );
      expect(storage.listParts.mock.invocationCallOrder[0]).toBeLessThan(
        repository.markAborted.mock.invocationCallOrder[0],
      );
      expect(repository.markAborted).toHaveBeenCalledWith(
        SESSION_ID,
        CLAIM_TOKEN,
      );
    });

    it('should touch nothing in the storage when, under the lock, there is nothing to do', async () => {
      repository.claimForSweep.mockResolvedValue({
        outcome: 'nothing-to-do',
        session: session({ status: UploadSessionStatus.COMPLETING }),
      });

      await expect(service.sweepAbort(VIDEO_ID, SESSION_ID)).resolves.toBe(
        'nothing-to-do',
      );

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(repository.markAborted).not.toHaveBeenCalled();
    });

    it('should find the uploads at the exact key of a session without upload_id', async () => {
      repository.claimForSweep.mockResolvedValue({
        outcome: 'claimed',
        claimToken: CLAIM_TOKEN,
        session: session({ upload_id: null }),
      });
      storage.listMultipartUploads.mockResolvedValue([
        { key: OBJECT_KEY, uploadId: 'orphan-1' },
        { key: `${OBJECT_KEY}-other`, uploadId: 'other-1' },
      ]);

      await expect(service.sweepAbort(VIDEO_ID, SESSION_ID)).resolves.toBe(
        'aborted',
      );

      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        OBJECT_KEY,
        'orphan-1',
      );
    });

    it.each([
      [
        'the listing keeps the upload (F-09)',
        () =>
          storage.listParts.mockResolvedValue({ status: 'found', parts: [] }),
      ],
      [
        'the storage cannot be reached',
        () =>
          storage.abortMultipartUpload.mockRejectedValue(
            new StorageUnavailableException(
              'AbortMultipartUpload',
              new Error('ECONNREFUSED'),
            ),
          ),
      ],
    ])(
      'should keep the claim of the sweep without marking aborted when %s',
      async (_, failure) => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        failure();

        const outcome = service.sweepAbort(VIDEO_ID, SESSION_ID);
        await jest.advanceTimersByTimeAsync(
          ABORT_CONFIRMATION.ATTEMPTS * ABORT_CONFIRMATION.RETRY_DELAY_MS,
        );

        await expect(outcome).resolves.toBe('abort-unconfirmed');
        expect(repository.markAborted).not.toHaveBeenCalled();
      },
    );

    it('should report a session taken over before the mark', async () => {
      repository.markAborted.mockResolvedValue(false);

      await expect(service.sweepAbort(VIDEO_ID, SESSION_ID)).resolves.toBe(
        'taken-over',
      );
    });
  });
});
