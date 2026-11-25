import { Test } from '@nestjs/testing';
import videoConfig from '../config/video.config';
import { StorageUnavailableException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import {
  type UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import { type Video, VideoStatus } from './entities/video.entity';
import {
  UploadCompletionInterruptedException,
  UploadFileMismatchException,
  UploadIncompleteException,
  UploadPartMismatchException,
  UploadSessionCompletingException,
  UploadSessionExpiredException,
  UploadSessionNotActiveException,
  UploadSessionNotFoundException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { VideoJobDispatcherService } from './jobs/video-job-dispatcher.service';
import {
  type CompletionRefusal,
  UploadCompletionRepository,
} from './upload-completion.repository';
import { UploadCompletionService } from './upload-completion.service';
import {
  type ClassifiedPart,
  UploadPartState,
} from './upload-part-classification';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { VIDEO_JOB_PUBLISH_TIMEOUT_MS } from './videos.constants';

const USER_ID = 'b6f1c2a4-3d5e-4f60-8a7b-9c0d1e2f3a4b';
const VIDEO_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const PUBLIC_ID = 'AbCdEfGhIjK';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const OBJECT_KEY = `originals/${VIDEO_ID}/${SESSION_ID}`;
const CLAIM_TOKEN = '99999999-8888-4777-8666-555555555555';
const PENDING_TOKEN = '77777777-6666-4555-8444-333333333333';
const SIZE_BYTES = 6_291_456;
const CHECKSUM_A = 'A'.repeat(43) + '=';
const CHECKSUM_B = 'B'.repeat(43) + '=';
const CONFIG = {
  uploadSessionClaimTtlSeconds: 300,
  processingJobActionTtlSeconds: 120,
};

function session(overrides: Partial<UploadSession> = {}): UploadSession {
  return {
    id: SESSION_ID,
    video_id: VIDEO_ID,
    object_key: OBJECT_KEY,
    upload_id: 'upload-1',
    status: UploadSessionStatus.COMPLETING,
    size_bytes: SIZE_BYTES,
    part_size: 5_242_880,
    part_count: 2,
    claim_token: CLAIM_TOKEN,
    file_mismatch_at: null,
    ...overrides,
  } as UploadSession;
}

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: VIDEO_ID,
    public_id: PUBLIC_ID,
    status: VideoStatus.DRAFT,
    current_upload_session_id: SESSION_ID,
    original_key: null,
    ...overrides,
  } as Video;
}

const CONFIRMED: ClassifiedPart[] = [
  {
    partNumber: 1,
    state: UploadPartState.CONFIRMED,
    checksumSha256: CHECKSUM_A,
    etag: '"e1"',
  },
  {
    partNumber: 2,
    state: UploadPartState.CONFIRMED,
    checksumSha256: CHECKSUM_B,
    etag: '"e2"',
  },
];

describe('UploadCompletionService', () => {
  let service: UploadCompletionService;
  let access: { getOwnedSession: jest.Mock };
  let completions: {
    claimCompletion: jest.Mock;
    revertCompletion: jest.Mock;
    abortCompletion: jest.Mock;
    finalizeCompletion: jest.Mock;
    readCompletionState: jest.Mock;
  };
  let parts: { classifyParts: jest.Mock };
  let storage: { completeMultipartUpload: jest.Mock; headObject: jest.Mock };
  let dispatcher: { publish: jest.Mock; confirm: jest.Mock };

  beforeEach(async () => {
    access = {
      getOwnedSession: jest.fn().mockResolvedValue({
        video: video(),
        session: session({ status: UploadSessionStatus.ACTIVE }),
        expired: false,
      }),
    };
    completions = {
      claimCompletion: jest.fn().mockResolvedValue({
        outcome: 'claimed',
        claimToken: CLAIM_TOKEN,
        session: session(),
        resumed: false,
      }),
      revertCompletion: jest.fn().mockResolvedValue(true),
      abortCompletion: jest.fn().mockResolvedValue(true),
      finalizeCompletion: jest.fn().mockResolvedValue({
        finalized: true,
        run: 1,
        pendingJobToken: PENDING_TOKEN,
      }),
      readCompletionState: jest.fn(),
    };
    parts = {
      classifyParts: jest.fn().mockResolvedValue({
        status: 'found',
        parts: CONFIRMED,
        extraPartNumbers: [],
      }),
    };
    storage = {
      completeMultipartUpload: jest
        .fn()
        .mockResolvedValue({ status: 'completed', etag: '"final"' }),
      headObject: jest
        .fn()
        .mockResolvedValue({ status: 'found', size: SIZE_BYTES, etag: '"x"' }),
    };
    dispatcher = {
      publish: jest.fn().mockResolvedValue({
        jobId: `video-${VIDEO_ID}-1-1`,
        stored: { data: { videoId: VIDEO_ID, run: 1 } },
      }),
      confirm: jest.fn().mockResolvedValue(true),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadCompletionService,
        { provide: UploadSessionAccessService, useValue: access },
        { provide: UploadCompletionRepository, useValue: completions },
        { provide: UploadPartsService, useValue: parts },
        { provide: StorageService, useValue: storage },
        { provide: VideoJobDispatcherService, useValue: dispatcher },
        { provide: videoConfig.KEY, useValue: CONFIG },
      ],
    }).compile();
    service = moduleRef.get(UploadCompletionService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function complete() {
    return service.completeUpload(USER_ID, PUBLIC_ID, SESSION_ID);
  }

  function classified(
    partsOfPlan: ClassifiedPart[],
    extraPartNumbers: number[] = [],
  ): void {
    parts.classifyParts.mockResolvedValue({
      status: 'found',
      parts: partsOfPlan,
      extraPartNumbers,
    });
  }

  function expectNoTransition(): void {
    expect(completions.finalizeCompletion).not.toHaveBeenCalled();
    expect(dispatcher.publish).not.toHaveBeenCalled();
  }

  describe('success (steps 1 to 4)', () => {
    it('should claim, check, complete from the registry, finalize and publish generation 1, answering 202', async () => {
      await expect(complete()).resolves.toEqual({
        transitioned: true,
        body: { publicId: PUBLIC_ID, status: VideoStatus.PROCESSING },
      });

      expect(access.getOwnedSession).toHaveBeenCalledWith(
        USER_ID,
        PUBLIC_ID,
        SESSION_ID,
      );
      expect(completions.claimCompletion).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        sessionId: SESSION_ID,
        claimTtlSeconds: 300,
      });
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        OBJECT_KEY,
        'upload-1',
        [
          { partNumber: 1, etag: '"e1"', checksumSha256: CHECKSUM_A },
          { partNumber: 2, etag: '"e2"', checksumSha256: CHECKSUM_B },
        ],
      );
      expect(completions.finalizeCompletion).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        sessionId: SESSION_ID,
        claimToken: CLAIM_TOKEN,
        objectKey: OBJECT_KEY,
        actionTtlSeconds: 120,
      });
      expect(dispatcher.publish).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        run: 1,
        dispatch: 1,
      });
      expect(dispatcher.confirm).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        dispatch: 1,
        token: PENDING_TOKEN,
      });
      const order = [
        completions.claimCompletion,
        parts.classifyParts,
        storage.completeMultipartUpload,
        completions.finalizeCompletion,
        dispatcher.publish,
        dispatcher.confirm,
      ].map((mock) => mock.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(storage.headObject).not.toHaveBeenCalled();
    });

    it('should resume an expired claim taken over with a new token in the same way', async () => {
      completions.claimCompletion.mockResolvedValue({
        outcome: 'claimed',
        claimToken: 'new-token',
        session: session({ claim_token: 'new-token' }),
        resumed: true,
      });

      await expect(complete()).resolves.toMatchObject({ transitioned: true });
      expect(completions.finalizeCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ claimToken: 'new-token' }) as unknown,
      );
    });
  });

  describe('step 1: claim under the lock', () => {
    it('should answer 200 with the current state of the video for a completed current session, with no new effect (G-03)', async () => {
      completions.claimCompletion.mockResolvedValue({
        outcome: 'completed',
        video: video({ status: VideoStatus.READY, original_key: OBJECT_KEY }),
      });

      await expect(complete()).resolves.toEqual({
        transitioned: false,
        body: { publicId: PUBLIC_ID, status: VideoStatus.READY },
      });
      expect(parts.classifyParts).not.toHaveBeenCalled();
      expectNoTransition();
    });

    it.each<[CompletionRefusal, new () => Error]>([
      ['video-not-found', VideoNotFoundException],
      ['session-not-found', UploadSessionNotFoundException],
      ['not-current', UploadSessionNotActiveException],
      ['not-active', UploadSessionNotActiveException],
      ['completing', UploadSessionCompletingException],
      ['expired', UploadSessionExpiredException],
      ['file-mismatch', UploadFileMismatchException],
      ['inconsistent', UploadSessionNotActiveException],
    ])(
      'should answer %s with its error, without calling the storage',
      async (reason, exception) => {
        completions.claimCompletion.mockResolvedValue({
          outcome: 'refused',
          reason,
        });

        await expect(complete()).rejects.toBeInstanceOf(exception);
        expect(parts.classifyParts).not.toHaveBeenCalled();
        expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
        expectNoTransition();
      },
    );

    it('should let the 404 of the ownership lookup through, claiming nothing', async () => {
      access.getOwnedSession.mockRejectedValue(new VideoNotFoundException());

      await expect(complete()).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(completions.claimCompletion).not.toHaveBeenCalled();
    });
  });

  describe('step 2: conference against the storage (G-04)', () => {
    const part = (
      partNumber: number,
      state: UploadPartState,
      checksumSha256: string | null = CHECKSUM_A,
      etag: string | null = '"e"',
    ): ClassifiedPart => ({ partNumber, state, checksumSha256, etag });

    it.each<[string, ClassifiedPart[], number[], new () => Error]>([
      [
        'a part missing from the storage',
        [CONFIRMED[0], part(2, UploadPartState.MISSING, CHECKSUM_B, null)],
        [],
        UploadIncompleteException,
      ],
      [
        'a part sent without a registered ETag',
        [CONFIRMED[0], part(2, UploadPartState.UNREGISTERED, CHECKSUM_B, null)],
        [],
        UploadIncompleteException,
      ],
      [
        'a part divergent from the registry',
        [CONFIRMED[0], part(2, UploadPartState.DIVERGENT)],
        [],
        UploadPartMismatchException,
      ],
      [
        'a part present without any registry',
        [CONFIRMED[0], part(2, UploadPartState.UNREGISTERED, null, null)],
        [],
        UploadPartMismatchException,
      ],
      [
        'a part listed beyond the plan',
        CONFIRMED,
        [3],
        UploadPartMismatchException,
      ],
      [
        'a mismatch together with a missing part',
        [
          part(1, UploadPartState.MISSING, CHECKSUM_A, null),
          part(2, UploadPartState.DIVERGENT),
        ],
        [],
        UploadPartMismatchException,
      ],
    ])(
      'should revert the claim by the token for %s',
      async (_, partsOfPlan, extras, exception) => {
        classified(partsOfPlan, extras);

        await expect(complete()).rejects.toBeInstanceOf(exception);
        expect(completions.revertCompletion).toHaveBeenCalledWith(
          VIDEO_ID,
          SESSION_ID,
          CLAIM_TOKEN,
        );
        expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
        expectNoTransition();
      },
    );

    it('should re-read instead of answering the conference error when the revert affects zero rows', async () => {
      classified([CONFIRMED[0], part(2, UploadPartState.MISSING, null, null)]);
      completions.revertCompletion.mockResolvedValue(false);
      completions.readCompletionState.mockResolvedValue({
        session: session({ claim_token: 'other' }),
        video: video(),
        expired: false,
      });

      await expect(complete()).rejects.toBeInstanceOf(
        UploadSessionCompletingException,
      );
      expectNoTransition();
    });
  });

  describe('step 2: NoSuchUpload resolved by HeadObject at the key of the session', () => {
    it('should finalize without a Complete when the listing answers NoSuchUpload and the object has the declared size (T-01)', async () => {
      parts.classifyParts.mockResolvedValue({
        status: 'no-such-upload',
        uploadId: 'upload-1',
      });

      await expect(complete()).resolves.toMatchObject({ transitioned: true });
      expect(storage.headObject).toHaveBeenCalledWith(OBJECT_KEY);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(completions.finalizeCompletion).toHaveBeenCalled();
    });

    it('should finalize when the Complete answers NoSuchUpload and the object has the declared size', async () => {
      storage.completeMultipartUpload.mockResolvedValue({
        status: 'no-such-upload',
      });

      await expect(complete()).resolves.toMatchObject({ transitioned: true });
      expect(storage.headObject).toHaveBeenCalledWith(OBJECT_KEY);
    });

    it.each([
      ['no object at the key', { status: 'not-found' }],
      [
        'an object of another size',
        { status: 'found', size: SIZE_BYTES - 1, etag: '"x"' },
      ],
    ])(
      'should abort by the token and answer UPLOAD_SESSION_EXPIRED for %s',
      async (_, head) => {
        storage.completeMultipartUpload.mockResolvedValue({
          status: 'no-such-upload',
        });
        storage.headObject.mockResolvedValue(head);

        await expect(complete()).rejects.toBeInstanceOf(
          UploadSessionExpiredException,
        );
        expect(completions.abortCompletion).toHaveBeenCalledWith(
          VIDEO_ID,
          SESSION_ID,
          CLAIM_TOKEN,
        );
        expectNoTransition();
      },
    );

    it('should re-read when the abort affects zero rows', async () => {
      parts.classifyParts.mockResolvedValue({
        status: 'no-such-upload',
        uploadId: 'upload-1',
      });
      storage.headObject.mockResolvedValue({ status: 'not-found' });
      completions.abortCompletion.mockResolvedValue(false);
      completions.readCompletionState.mockResolvedValue({
        session: session({ status: UploadSessionStatus.ACTIVE }),
        video: video(),
        expired: false,
      });

      await expect(complete()).rejects.toBeInstanceOf(
        UploadCompletionInterruptedException,
      );
      expectNoTransition();
    });
  });

  describe('step 2: transient storage failure', () => {
    it.each(['classifyParts', 'completeMultipartUpload', 'headObject'])(
      'should answer STORAGE_UNAVAILABLE when %s fails, leaving the claim to expire',
      async (operation) => {
        const failure = new StorageUnavailableException(operation);
        if (operation === 'classifyParts') {
          parts.classifyParts.mockRejectedValue(failure);
        } else if (operation === 'completeMultipartUpload') {
          storage.completeMultipartUpload.mockRejectedValue(failure);
        } else {
          storage.completeMultipartUpload.mockResolvedValue({
            status: 'no-such-upload',
          });
          storage.headObject.mockRejectedValue(failure);
        }

        await expect(complete()).rejects.toBe(failure);
        expect(completions.revertCompletion).not.toHaveBeenCalled();
        expect(completions.abortCompletion).not.toHaveBeenCalled();
        expectNoTransition();
      },
    );
  });

  describe('step 5: re-read after zero rows in T2', () => {
    beforeEach(() => {
      completions.finalizeCompletion.mockResolvedValue({ finalized: false });
    });

    function rereadFinds(
      sessionOverrides: Partial<UploadSession>,
      videoOverrides: Partial<Video> = {},
      expired = false,
    ): void {
      completions.readCompletionState.mockResolvedValue({
        session: session(sessionOverrides),
        video: video(videoOverrides),
        expired,
      });
    }

    it('should answer 200 only when the session is completed and recorded by the video', async () => {
      rereadFinds(
        { status: UploadSessionStatus.COMPLETED },
        { status: VideoStatus.PROCESSING, original_key: OBJECT_KEY },
      );

      await expect(complete()).resolves.toEqual({
        transitioned: false,
        body: { publicId: PUBLIC_ID, status: VideoStatus.PROCESSING },
      });
      expect(completions.readCompletionState).toHaveBeenCalledWith(SESSION_ID);
      expect(dispatcher.publish).not.toHaveBeenCalled();
    });

    it.each<
      [string, Partial<UploadSession>, Partial<Video>, boolean, new () => Error]
    >([
      [
        'completing by another process',
        { status: UploadSessionStatus.COMPLETING, claim_token: 'other' },
        {},
        false,
        UploadSessionCompletingException,
      ],
      [
        'active again, reverted by another call',
        { status: UploadSessionStatus.ACTIVE, claim_token: null },
        {},
        false,
        UploadCompletionInterruptedException,
      ],
      [
        'aborting with the deadline passed',
        { status: UploadSessionStatus.ABORTING },
        {},
        true,
        UploadSessionExpiredException,
      ],
      [
        'aborted with the deadline passed',
        { status: UploadSessionStatus.ABORTED },
        {},
        true,
        UploadSessionExpiredException,
      ],
      [
        'aborting within the deadline',
        { status: UploadSessionStatus.ABORTING },
        {},
        false,
        UploadSessionNotActiveException,
      ],
      [
        'aborted within the deadline',
        { status: UploadSessionStatus.ABORTED },
        {},
        false,
        UploadSessionNotActiveException,
      ],
      [
        'replaced: the video points to another session',
        { status: UploadSessionStatus.ABORTED },
        { current_upload_session_id: 'another' },
        true,
        UploadSessionNotActiveException,
      ],
      [
        'completed without the video pointing to it',
        { status: UploadSessionStatus.COMPLETED },
        { current_upload_session_id: 'another', original_key: OBJECT_KEY },
        false,
        UploadSessionNotActiveException,
      ],
      [
        'completed with another original',
        { status: UploadSessionStatus.COMPLETED },
        { original_key: 'originals/other' },
        false,
        UploadSessionNotActiveException,
      ],
    ])(
      'should never answer 200 for a session %s',
      async (_, sessionOverrides, videoOverrides, expired, exception) => {
        rereadFinds(sessionOverrides, videoOverrides, expired);

        await expect(complete()).rejects.toBeInstanceOf(exception);
        expect(dispatcher.publish).not.toHaveBeenCalled();
      },
    );

    it('should answer UPLOAD_SESSION_NOT_FOUND when the session no longer exists', async () => {
      completions.readCompletionState.mockResolvedValue(null);

      await expect(complete()).rejects.toBeInstanceOf(
        UploadSessionNotFoundException,
      );
    });
  });

  describe('step 4: publication after the commit (F-02)', () => {
    it('should keep the 202 and leave the action pending when the add fails', async () => {
      dispatcher.publish.mockRejectedValue(new Error('Connection is closed.'));

      await expect(complete()).resolves.toEqual({
        transitioned: true,
        body: { publicId: PUBLIC_ID, status: VideoStatus.PROCESSING },
      });
      expect(dispatcher.confirm).not.toHaveBeenCalled();
    });

    it('should keep the 202 when the add does not answer within the bound', async () => {
      jest.useFakeTimers();
      dispatcher.publish.mockReturnValue(new Promise(() => undefined));

      const completion = complete();
      await jest.advanceTimersByTimeAsync(VIDEO_JOB_PUBLISH_TIMEOUT_MS);

      await expect(completion).resolves.toMatchObject({ transitioned: true });
      expect(dispatcher.confirm).not.toHaveBeenCalled();
    });

    it('should not confirm an action whose job is not found after the add', async () => {
      dispatcher.publish.mockResolvedValue({
        jobId: `video-${VIDEO_ID}-1-1`,
        stored: null,
      });

      await expect(complete()).resolves.toMatchObject({ transitioned: true });
      expect(dispatcher.confirm).not.toHaveBeenCalled();
    });

    it.each([
      ['taken over (zero rows)', () => Promise.resolve(false)],
      ['failing', () => Promise.reject(new Error('connection lost'))],
    ])(
      'should keep the 202 when the confirmation is %s',
      async (_, confirm) => {
        dispatcher.confirm.mockImplementation(confirm);

        await expect(complete()).resolves.toMatchObject({ transitioned: true });
      },
    );
  });
});
