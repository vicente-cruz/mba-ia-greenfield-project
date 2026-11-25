import { Test } from '@nestjs/testing';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type { PresignUploadPartInput } from '../storage/storage.types';
import {
  type UploadSession,
  UploadSessionStatus,
} from './entities/upload-session.entity';
import type { Video } from './entities/video.entity';
import {
  InvalidPartNumberException,
  UploadFileMismatchException,
  UploadPartNotSignedException,
  UploadSessionExpiredException,
  UploadSessionNotActiveException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import type { PartChecksum } from './upload-parts.repository';
import { UploadPartsRepository } from './upload-parts.repository';
import {
  type PartUrlsRequest,
  UploadPartsService,
} from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';

const PART_SIZE = 67_108_864;
const URL_TTL_SECONDS = 900;
const USER_ID = 'b6f1c2a4-3d5e-4f60-8a7b-9c0d1e2f3a4b';
const PUBLIC_ID = 'AbCdEfGhIjK';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const CHECKSUM_A = 'A'.repeat(43) + '=';
const CHECKSUM_B = 'B'.repeat(43) + '=';

function session(overrides: Partial<UploadSession> = {}): UploadSession {
  return {
    id: SESSION_ID,
    video_id: 'video-1',
    object_key: `originals/video-1/${SESSION_ID}`,
    upload_id: 'upload-1',
    status: UploadSessionStatus.ACTIVE,
    size_bytes: 10_000_000_000,
    part_size: PART_SIZE,
    part_count: 150,
    file_mismatch_at: null,
    ...overrides,
  } as UploadSession;
}

describe('UploadPartsService', () => {
  let service: UploadPartsService;
  let owned: { video: Video; session: UploadSession; expired: boolean };
  let sessionAccess: { getOwnedSession: jest.Mock };
  let sessionsRepository: { markFileMismatch: jest.Mock };
  let partsRepository: {
    registerChecksums: jest.Mock;
    registerEtags: jest.Mock;
  };
  let storage: { presignUploadPart: jest.Mock };

  beforeEach(async () => {
    owned = {
      video: { current_upload_session_id: SESSION_ID } as Video,
      session: session(),
      expired: false,
    };
    sessionAccess = {
      getOwnedSession: jest.fn(() => Promise.resolve(owned)),
    };
    sessionsRepository = { markFileMismatch: jest.fn() };
    partsRepository = {
      // By default, the stored checksum is the declared one (first registration).
      registerChecksums: jest.fn((_sessionId: string, parts: PartChecksum[]) =>
        Promise.resolve(
          new Map(parts.map((part) => [part.partNumber, part.checksumSha256])),
        ),
      ),
      registerEtags: jest.fn().mockResolvedValue(true),
    };
    storage = {
      presignUploadPart: jest.fn((input: PresignUploadPartInput) =>
        Promise.resolve({
          url: `https://storage.example/${input.partNumber}`,
          method: 'PUT',
          expectedSize: input.expectedSize,
          headers: { 'x-amz-checksum-sha256': input.checksumSha256 },
          expiresAt: new Date('2026-11-22T12:15:00.000Z'),
        }),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadPartsService,
        { provide: UploadSessionAccessService, useValue: sessionAccess },
        { provide: UploadSessionsRepository, useValue: sessionsRepository },
        { provide: UploadPartsRepository, useValue: partsRepository },
        { provide: StorageService, useValue: storage },
        {
          provide: videoConfig.KEY,
          useValue: { uploadPartUrlTtlSeconds: URL_TTL_SECONDS },
        },
      ],
    }).compile();
    service = moduleRef.get(UploadPartsService);
  });

  function request(body: PartUrlsRequest) {
    return service.requestPartUrls(USER_ID, PUBLIC_ID, SESSION_ID, body);
  }

  describe('expected size', () => {
    it('should give the last part of 10,000,000,000 bytes 779,264 bytes, signed with that size', async () => {
      const result = await request({
        parts: [{ partNumber: 150, checksumSha256: CHECKSUM_A }],
      });

      expect(partsRepository.registerChecksums).toHaveBeenCalledWith(
        SESSION_ID,
        [
          {
            partNumber: 150,
            checksumSha256: CHECKSUM_A,
            expectedSize: 779_264,
          },
        ],
      );
      expect(storage.presignUploadPart).toHaveBeenCalledWith({
        key: `originals/video-1/${SESSION_ID}`,
        uploadId: 'upload-1',
        partNumber: 150,
        expectedSize: 779_264,
        checksumSha256: CHECKSUM_A,
        expiresInSeconds: URL_TTL_SECONDS,
      });
      expect(result.parts).toEqual([
        {
          partNumber: 150,
          url: 'https://storage.example/150',
          method: 'PUT',
          expectedSize: 779_264,
          headers: { 'x-amz-checksum-sha256': CHECKSUM_A },
          expiresAt: new Date('2026-11-22T12:15:00.000Z'),
        },
      ]);
      expect(result.registeredParts).toEqual([]);
    });

    it('should end a file that is an exact multiple of the part size in a full part', async () => {
      owned.session = session({ size_bytes: 134_217_728, part_count: 2 });

      const result = await request({
        parts: [
          { partNumber: 1, checksumSha256: CHECKSUM_A },
          { partNumber: 2, checksumSha256: CHECKSUM_B },
        ],
      });

      expect(result.parts.map((part) => part.expectedSize)).toEqual([
        PART_SIZE,
        PART_SIZE,
      ]);
    });
  });

  describe('part numbers', () => {
    it('should refuse a part above partCount with INVALID_PART_NUMBER, writing nothing', async () => {
      await expect(
        request({ parts: [{ partNumber: 151, checksumSha256: CHECKSUM_A }] }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(partsRepository.registerChecksums).not.toHaveBeenCalled();
      expect(partsRepository.registerEtags).not.toHaveBeenCalled();
    });

    it('should refuse a part repeated in the batch', async () => {
      await expect(
        request({
          parts: [
            { partNumber: 3, checksumSha256: CHECKSUM_A },
            { partNumber: 3, checksumSha256: CHECKSUM_A },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(partsRepository.registerChecksums).not.toHaveBeenCalled();
    });

    it('should refuse completedParts above partCount before recording any ETag', async () => {
      await expect(
        request({
          parts: [{ partNumber: 1, checksumSha256: CHECKSUM_A }],
          completedParts: [{ partNumber: 151, etag: '"e"' }],
        }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(partsRepository.registerEtags).not.toHaveBeenCalled();
      expect(partsRepository.registerChecksums).not.toHaveBeenCalled();
    });
  });

  describe('checksum registered once', () => {
    it('should sign again a part declared with the same checksum', async () => {
      await expect(
        request({ parts: [{ partNumber: 3, checksumSha256: CHECKSUM_A }] }),
      ).resolves.toMatchObject({ parts: [{ partNumber: 3 }] });
      expect(sessionsRepository.markFileMismatch).not.toHaveBeenCalled();
    });

    it('should keep the original, block the session and answer UPLOAD_FILE_MISMATCH for another checksum', async () => {
      partsRepository.registerChecksums.mockResolvedValue(
        new Map([[3, CHECKSUM_A]]),
      );

      await expect(
        request({ parts: [{ partNumber: 3, checksumSha256: CHECKSUM_B }] }),
      ).rejects.toBeInstanceOf(UploadFileMismatchException);
      expect(sessionsRepository.markFileMismatch).toHaveBeenCalledWith(
        SESSION_ID,
      );
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should answer UPLOAD_FILE_MISMATCH to every later request of a blocked session, writing nothing', async () => {
      owned.session = session({ file_mismatch_at: new Date() });

      await expect(
        request({ parts: [{ partNumber: 4, checksumSha256: CHECKSUM_B }] }),
      ).rejects.toBeInstanceOf(UploadFileMismatchException);
      await expect(
        request({ completedParts: [{ partNumber: 1, etag: '"e"' }] }),
      ).rejects.toBeInstanceOf(UploadFileMismatchException);
      expect(partsRepository.registerChecksums).not.toHaveBeenCalled();
      expect(partsRepository.registerEtags).not.toHaveBeenCalled();
    });
  });

  describe('ETags', () => {
    it('should answer UPLOAD_PART_NOT_SIGNED for a part without a registered checksum, signing nothing', async () => {
      partsRepository.registerEtags.mockResolvedValue(false);

      await expect(
        request({
          parts: [{ partNumber: 2, checksumSha256: CHECKSUM_A }],
          completedParts: [{ partNumber: 10, etag: '"abc"' }],
        }),
      ).rejects.toBeInstanceOf(UploadPartNotSignedException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should record the ETags of signed parts and report them in order', async () => {
      const result = await request({
        completedParts: [
          { partNumber: 2, etag: '"b"' },
          { partNumber: 1, etag: '"a"' },
        ],
      });

      expect(partsRepository.registerEtags).toHaveBeenCalledWith(SESSION_ID, [
        { partNumber: 2, etag: '"b"' },
        { partNumber: 1, etag: '"a"' },
      ]);
      expect(result).toEqual({ parts: [], registeredParts: [1, 2] });
    });
  });

  describe('session state', () => {
    it('should answer UPLOAD_SESSION_EXPIRED for an expired active session', async () => {
      owned.expired = true;

      await expect(
        request({ parts: [{ partNumber: 1, checksumSha256: CHECKSUM_A }] }),
      ).rejects.toBeInstanceOf(UploadSessionExpiredException);
      expect(partsRepository.registerChecksums).not.toHaveBeenCalled();
    });

    it.each([
      UploadSessionStatus.INITIATING,
      UploadSessionStatus.COMPLETING,
      UploadSessionStatus.ABORTED,
    ])(
      'should answer UPLOAD_SESSION_NOT_ACTIVE for a session in %s',
      async (status) => {
        owned.session = session({ status });

        await expect(
          request({ parts: [{ partNumber: 1, checksumSha256: CHECKSUM_A }] }),
        ).rejects.toBeInstanceOf(UploadSessionNotActiveException);
      },
    );

    it('should answer UPLOAD_SESSION_NOT_ACTIVE for a session that is not the current one', async () => {
      owned.video = { current_upload_session_id: 'another' } as Video;

      await expect(
        request({ parts: [{ partNumber: 1, checksumSha256: CHECKSUM_A }] }),
      ).rejects.toBeInstanceOf(UploadSessionNotActiveException);
    });

    it('should let the 404 of the ownership lookup through', async () => {
      sessionAccess.getOwnedSession.mockRejectedValue(
        new VideoNotFoundException(),
      );

      await expect(
        request({ parts: [{ partNumber: 1, checksumSha256: CHECKSUM_A }] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(partsRepository.registerChecksums).not.toHaveBeenCalled();
    });
  });
});
