import { Test } from '@nestjs/testing';
import videoConfig from '../config/video.config';
import { StorageUnavailableException } from '../storage/storage.exceptions';
import { StorageService } from '../storage/storage.service';
import type { StoragePart } from '../storage/storage.types';
import type { UploadPart } from './entities/upload-part.entity';
import {
  type UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import type { Video } from './entities/video.entity';
import {
  InvalidPartNumberException,
  UploadFileMismatchException,
  UploadSessionExpiredException,
  UploadSessionNotActiveException,
  UploadVerificationIncompleteException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { UploadPartsRepository } from './upload-parts.repository';
import {
  type RecalculatedPartChecksum,
  UploadPartsService,
} from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';

const PART_SIZE = 5_242_880;
const USER_ID = 'b6f1c2a4-3d5e-4f60-8a7b-9c0d1e2f3a4b';
const PUBLIC_ID = 'AbCdEfGhIjK';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const CHECKSUM_A = 'A'.repeat(43) + '=';
const CHECKSUM_B = 'B'.repeat(43) + '=';
const CHECKSUM_C = 'C'.repeat(43) + '=';
const CHECKSUM_X = 'X'.repeat(43) + '=';

function session(overrides: Partial<UploadSession> = {}): UploadSession {
  return {
    id: SESSION_ID,
    video_id: 'video-1',
    object_key: `originals/video-1/${SESSION_ID}`,
    upload_id: 'upload-1',
    status: UploadSessionStatus.ACTIVE,
    // Three parts: two of PART_SIZE and a last one of 1,000 bytes.
    size_bytes: 2 * PART_SIZE + 1_000,
    part_size: PART_SIZE,
    part_count: 3,
    file_mismatch_at: null,
    ...overrides,
  } as UploadSession;
}

function sizeOf(partNumber: number): number {
  return partNumber === 3 ? 1_000 : PART_SIZE;
}

/** A row of the registry: signed with `checksum`, with the ETag of its PUT when given. */
function registered(
  partNumber: number,
  checksum: string,
  etag: string | null,
): UploadPart {
  return {
    part_number: partNumber,
    expected_size: sizeOf(partNumber),
    checksum_sha256: checksum,
    etag,
  } as UploadPart;
}

/** A part as the storage lists it. */
function listed(
  partNumber: number,
  checksum: string,
  etag: string,
): StoragePart {
  return {
    partNumber,
    etag,
    size: sizeOf(partNumber),
    checksumSha256: checksum,
  };
}

describe('UploadPartsService.verifyFile', () => {
  let service: UploadPartsService;
  let owned: { video: Video; session: UploadSession; expired: boolean };
  let access: { getOwnedSession: jest.Mock };
  let sessionsRepository: { markFileMismatch: jest.Mock };
  let partsRepository: { findBySession: jest.Mock };
  let storage: { listParts: jest.Mock };

  beforeEach(async () => {
    owned = {
      video: { current_upload_session_id: SESSION_ID } as Video,
      session: session(),
      expired: false,
    };
    access = { getOwnedSession: jest.fn(() => Promise.resolve(owned)) };
    sessionsRepository = { markFileMismatch: jest.fn() };
    partsRepository = { findBySession: jest.fn().mockResolvedValue([]) };
    storage = {
      listParts: jest.fn().mockResolvedValue({ status: 'found', parts: [] }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadPartsService,
        { provide: UploadSessionAccessService, useValue: access },
        { provide: UploadSessionsRepository, useValue: sessionsRepository },
        { provide: UploadPartsRepository, useValue: partsRepository },
        { provide: StorageService, useValue: storage },
        { provide: videoConfig.KEY, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(UploadPartsService);
  });

  function verify(parts: RecalculatedPartChecksum[]) {
    return service.verifyFile(USER_ID, PUBLIC_ID, SESSION_ID, parts);
  }

  /**
   * Part 1 `confirmed` (A), part 2 `unregistered` (B) and part 3 `missing`, signed with C or not
   * signed at all.
   */
  function resumedUpload(options: { part3Signed: boolean }): void {
    partsRepository.findBySession.mockResolvedValue([
      registered(1, CHECKSUM_A, '"e1"'),
      registered(2, CHECKSUM_B, null),
      ...(options.part3Signed ? [registered(3, CHECKSUM_C, null)] : []),
    ]);
    storage.listParts.mockResolvedValue({
      status: 'found',
      parts: [listed(1, CHECKSUM_A, '"e1"'), listed(2, CHECKSUM_B, '"e2"')],
    });
  }

  function expectNothingRecorded(): void {
    expect(sessionsRepository.markFileMismatch).not.toHaveBeenCalled();
  }

  describe('coverage of the parts already received (Q-10)', () => {
    it('should accept an empty list when no part was received', async () => {
      partsRepository.findBySession.mockResolvedValue([
        registered(1, CHECKSUM_A, null),
      ]);

      await expect(verify([])).resolves.toEqual({
        result: 'match',
        verifiedParts: 0,
      });
      expectNothingRecorded();
    });

    it('should match when every confirmed and unregistered part has its registered checksum', async () => {
      resumedUpload({ part3Signed: false });

      await expect(
        verify([
          { partNumber: 1, checksumSha256: CHECKSUM_A },
          { partNumber: 2, checksumSha256: CHECKSUM_B },
        ]),
      ).resolves.toEqual({ result: 'match', verifiedParts: 2 });
      expectNothingRecorded();
    });

    it.each([
      ['a confirmed part', 2, CHECKSUM_B],
      ['an unregistered part', 1, CHECKSUM_A],
    ])(
      'should answer UPLOAD_VERIFICATION_INCOMPLETE when %s is left out, recording nothing',
      async (_, partNumber, checksumSha256) => {
        resumedUpload({ part3Signed: false });

        await expect(
          verify([{ partNumber, checksumSha256 }]),
        ).rejects.toBeInstanceOf(UploadVerificationIncompleteException);
        expectNothingRecorded();
      },
    );

    it('should refuse an empty list when parts were received', async () => {
      resumedUpload({ part3Signed: false });

      await expect(verify([])).rejects.toBeInstanceOf(
        UploadVerificationIncompleteException,
      );
    });

    it('should check a missing part with a registered checksum and count it', async () => {
      resumedUpload({ part3Signed: true });

      await expect(
        verify([
          { partNumber: 1, checksumSha256: CHECKSUM_A },
          { partNumber: 2, checksumSha256: CHECKSUM_B },
          { partNumber: 3, checksumSha256: CHECKSUM_C },
        ]),
      ).resolves.toEqual({ result: 'match', verifiedParts: 3 });
    });

    it('should block the session when the missing part included has another checksum', async () => {
      resumedUpload({ part3Signed: true });

      await expect(
        verify([
          { partNumber: 1, checksumSha256: CHECKSUM_A },
          { partNumber: 2, checksumSha256: CHECKSUM_B },
          { partNumber: 3, checksumSha256: CHECKSUM_X },
        ]),
      ).rejects.toBeInstanceOf(UploadFileMismatchException);
      expect(sessionsRepository.markFileMismatch).toHaveBeenCalledWith(
        SESSION_ID,
      );
    });

    it('should check a divergent part with a registered checksum', async () => {
      partsRepository.findBySession.mockResolvedValue([
        registered(1, CHECKSUM_A, '"e1"'),
      ]);
      storage.listParts.mockResolvedValue({
        status: 'found',
        parts: [listed(1, CHECKSUM_X, '"other"')],
      });

      await expect(
        verify([{ partNumber: 1, checksumSha256: CHECKSUM_A }]),
      ).resolves.toEqual({ result: 'match', verifiedParts: 1 });
    });
  });

  describe('parts that cannot be verified (INVALID_PART_NUMBER)', () => {
    it('should refuse a part never signed, recording nothing', async () => {
      resumedUpload({ part3Signed: false });

      await expect(
        verify([
          { partNumber: 1, checksumSha256: CHECKSUM_A },
          { partNumber: 2, checksumSha256: CHECKSUM_B },
          { partNumber: 3, checksumSha256: CHECKSUM_C },
        ]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expectNothingRecorded();
    });

    it('should refuse a part above partCount before listing the storage', async () => {
      await expect(
        verify([{ partNumber: 4, checksumSha256: CHECKSUM_A }]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should refuse a part present in the storage without a registered checksum', async () => {
      storage.listParts.mockResolvedValue({
        status: 'found',
        parts: [listed(1, CHECKSUM_A, '"e1"')],
      });

      await expect(
        verify([{ partNumber: 1, checksumSha256: CHECKSUM_A }]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
    });
  });

  describe('order of the checks: nothing is recorded for a request refused with 400', () => {
    it('should answer INVALID_PART_NUMBER before UPLOAD_VERIFICATION_INCOMPLETE', async () => {
      resumedUpload({ part3Signed: false });

      await expect(
        verify([{ partNumber: 3, checksumSha256: CHECKSUM_C }]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
    });

    it('should answer UPLOAD_VERIFICATION_INCOMPLETE before comparing, without blocking the session', async () => {
      resumedUpload({ part3Signed: false });

      await expect(
        verify([{ partNumber: 1, checksumSha256: CHECKSUM_X }]),
      ).rejects.toBeInstanceOf(UploadVerificationIncompleteException);
      expectNothingRecorded();
    });
  });

  describe('file mismatch (F-11, G-11)', () => {
    it('should record file_mismatch_at before answering UPLOAD_FILE_MISMATCH, writing no part', async () => {
      resumedUpload({ part3Signed: false });

      await expect(
        verify([
          { partNumber: 1, checksumSha256: CHECKSUM_X },
          { partNumber: 2, checksumSha256: CHECKSUM_B },
        ]),
      ).rejects.toBeInstanceOf(UploadFileMismatchException);
      expect(sessionsRepository.markFileMismatch).toHaveBeenCalledTimes(1);
      expect(sessionsRepository.markFileMismatch).toHaveBeenCalledWith(
        SESSION_ID,
      );
    });

    it('should keep a blocked session blocked even with the registered checksums, without listing', async () => {
      owned.session = session({ file_mismatch_at: new Date() });
      resumedUpload({ part3Signed: false });

      await expect(
        verify([
          { partNumber: 1, checksumSha256: CHECKSUM_A },
          { partNumber: 2, checksumSha256: CHECKSUM_B },
        ]),
      ).rejects.toBeInstanceOf(UploadFileMismatchException);
      expect(storage.listParts).not.toHaveBeenCalled();
      expectNothingRecorded();
    });
  });

  describe('session state', () => {
    it('should let the 404 of the ownership lookup through', async () => {
      access.getOwnedSession.mockRejectedValue(new VideoNotFoundException());

      await expect(verify([])).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should answer UPLOAD_SESSION_NOT_ACTIVE for a session that is not the current one', async () => {
      owned.video = { current_upload_session_id: 'another' } as Video;

      await expect(verify([])).rejects.toBeInstanceOf(
        UploadSessionNotActiveException,
      );
      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it.each([
      UploadSessionStatus.INITIATING,
      UploadSessionStatus.COMPLETING,
      UploadSessionStatus.COMPLETED,
      UploadSessionStatus.ABORTING,
      UploadSessionStatus.ABORTED,
    ])(
      'should answer UPLOAD_SESSION_NOT_ACTIVE for a session in %s',
      async (status) => {
        owned.session = session({ status });

        await expect(verify([])).rejects.toBeInstanceOf(
          UploadSessionNotActiveException,
        );
      },
    );

    it('should answer UPLOAD_SESSION_EXPIRED for an expired session, without listing', async () => {
      owned.expired = true;

      await expect(verify([])).rejects.toBeInstanceOf(
        UploadSessionExpiredException,
      );
      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should answer UPLOAD_SESSION_EXPIRED when the storage no longer knows the upload (F-10), recording nothing', async () => {
      storage.listParts.mockResolvedValue({ status: 'no-such-upload' });

      await expect(verify([])).rejects.toBeInstanceOf(
        UploadSessionExpiredException,
      );
      expectNothingRecorded();
    });

    it('should answer STORAGE_UNAVAILABLE for a transient failure of ListParts, recording nothing', async () => {
      storage.listParts.mockRejectedValue(
        new StorageUnavailableException('ListParts'),
      );

      await expect(verify([])).rejects.toBeInstanceOf(
        StorageUnavailableException,
      );
      expectNothingRecorded();
    });
  });
});
