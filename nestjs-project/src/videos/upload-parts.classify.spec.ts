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
import { UploadPartState } from './upload-part-classification';
import { UploadPartsRepository } from './upload-parts.repository';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionAccessService } from './upload-session-access.service';
import { UploadSessionsRepository } from './upload-sessions.repository';

const PART_SIZE = 5_242_880;
/** Three parts: two of PART_SIZE and a last one of 1,000 bytes. */
const SIZE_BYTES = 2 * PART_SIZE + 1_000;
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const OBJECT_KEY = `originals/video-1/${SESSION_ID}`;
const CHECKSUM_A = 'A'.repeat(43) + '=';
const CHECKSUM_B = 'B'.repeat(43) + '=';
const CHECKSUM_C = 'C'.repeat(43) + '=';

function session(overrides: Partial<UploadSession> = {}): UploadSession {
  return {
    id: SESSION_ID,
    video_id: 'video-1',
    object_key: OBJECT_KEY,
    upload_id: 'upload-1',
    status: UploadSessionStatus.ACTIVE,
    size_bytes: SIZE_BYTES,
    part_size: PART_SIZE,
    part_count: 3,
    ...overrides,
  } as UploadSession;
}

function registered(
  partNumber: number,
  checksum: string,
  etag: string | null,
  expectedSize = partNumber === 3 ? 1_000 : PART_SIZE,
): UploadPart {
  return {
    part_number: partNumber,
    expected_size: expectedSize,
    checksum_sha256: checksum,
    etag,
  } as UploadPart;
}

function listed(
  partNumber: number,
  checksum: string | undefined,
  etag: string,
  size = partNumber === 3 ? 1_000 : PART_SIZE,
): StoragePart {
  return { partNumber, etag, size, checksumSha256: checksum };
}

describe('UploadPartsService.classifyParts', () => {
  let service: UploadPartsService;
  let storage: { listParts: jest.Mock };
  let partsRepository: { findBySession: jest.Mock };

  beforeEach(async () => {
    storage = { listParts: jest.fn() };
    partsRepository = { findBySession: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadPartsService,
        { provide: UploadSessionAccessService, useValue: {} },
        { provide: UploadSessionsRepository, useValue: {} },
        { provide: UploadPartsRepository, useValue: partsRepository },
        { provide: StorageService, useValue: storage },
        { provide: videoConfig.KEY, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(UploadPartsService);
  });

  function storageHas(parts: StoragePart[]): void {
    storage.listParts.mockResolvedValue({ status: 'found', parts });
  }

  function registryHas(parts: UploadPart[]): void {
    partsRepository.findBySession.mockResolvedValue(parts);
  }

  it('should list the upload of the session in pages of 1,000 parts, then read its registry', async () => {
    storageHas([]);

    await service.classifyParts(session());

    expect(storage.listParts).toHaveBeenCalledWith(OBJECT_KEY, 'upload-1', {
      pageSize: 1_000,
    });
    expect(partsRepository.findBySession).toHaveBeenCalledWith(SESSION_ID);
    expect(storage.listParts.mock.invocationCallOrder[0]).toBeLessThan(
      partsRepository.findBySession.mock.invocationCallOrder[0],
    );
  });

  it('should pass a smaller page size through to the listing', async () => {
    storageHas([]);

    await service.classifyParts(session(), { pageSize: 2 });

    expect(storage.listParts).toHaveBeenCalledWith(OBJECT_KEY, 'upload-1', {
      pageSize: 2,
    });
  });

  it('should give every part as missing, with null checksum and ETag, when nothing was signed or sent', async () => {
    storageHas([]);

    await expect(service.classifyParts(session())).resolves.toEqual({
      status: 'found',
      parts: [1, 2, 3].map((partNumber) => ({
        partNumber,
        state: UploadPartState.MISSING,
        checksumSha256: null,
        etag: null,
      })),
      extraPartNumbers: [],
    });
  });

  it('should classify the four classes, one entry per part of the plan with the registered checksum and ETag', async () => {
    const fourParts = session({
      size_bytes: 3 * PART_SIZE + 1_000,
      part_count: 4,
    });
    registryHas([
      registered(1, CHECKSUM_A, '"e1"'),
      registered(2, CHECKSUM_B, null),
      registered(3, CHECKSUM_C, '"e3"', PART_SIZE),
      registered(4, CHECKSUM_A, null, 1_000),
    ]);
    storageHas([
      listed(1, CHECKSUM_A, '"e1"'),
      listed(2, CHECKSUM_B, '"e2"'),
      listed(3, CHECKSUM_B, '"e3-new"', PART_SIZE),
    ]);

    const result = await service.classifyParts(fourParts);

    expect(result).toEqual({
      status: 'found',
      parts: [
        {
          partNumber: 1,
          state: UploadPartState.CONFIRMED,
          checksumSha256: CHECKSUM_A,
          etag: '"e1"',
        },
        {
          partNumber: 2,
          state: UploadPartState.UNREGISTERED,
          checksumSha256: CHECKSUM_B,
          etag: null,
        },
        {
          partNumber: 3,
          state: UploadPartState.DIVERGENT,
          checksumSha256: CHECKSUM_C,
          etag: '"e3"',
        },
        {
          // Signed but never received: missing, with the registered checksum.
          partNumber: 4,
          state: UploadPartState.MISSING,
          checksumSha256: CHECKSUM_A,
          etag: null,
        },
      ],
      extraPartNumbers: [],
    });
  });

  it('should give a part present in the storage but never signed as unregistered, with null checksum', async () => {
    storageHas([listed(2, CHECKSUM_B, '"e2"')]);

    const result = await service.classifyParts(session());

    expect(result).toMatchObject({
      status: 'found',
      parts: [
        { partNumber: 1, state: UploadPartState.MISSING },
        {
          partNumber: 2,
          state: UploadPartState.UNREGISTERED,
          checksumSha256: null,
          etag: null,
        },
        { partNumber: 3, state: UploadPartState.MISSING },
      ],
    });
  });

  describe('divergent: present, but different from the registry', () => {
    beforeEach(() => registryHas([registered(3, CHECKSUM_C, '"e3"')]));

    it.each([
      ['another ETag', listed(3, CHECKSUM_C, '"other"')],
      ['another checksum', listed(3, CHECKSUM_A, '"e3"')],
      ['no checksum in the listing', listed(3, undefined, '"e3"')],
      ['another size', listed(3, CHECKSUM_C, '"e3"', 999)],
      ['the ETag without its quotes', listed(3, CHECKSUM_C, 'e3')],
    ])('should give %s as divergent', async (_, part) => {
      storageHas([part]);

      const result = await service.classifyParts(session());

      expect(result).toMatchObject({
        status: 'found',
        parts: [
          { partNumber: 1, state: UploadPartState.MISSING },
          { partNumber: 2, state: UploadPartState.MISSING },
          { partNumber: 3, state: UploadPartState.DIVERGENT },
        ],
      });
    });

    it('should confirm the last part with its own expected size', async () => {
      storageHas([listed(3, CHECKSUM_C, '"e3"', 1_000)]);

      const result = await service.classifyParts(session());

      expect(result).toMatchObject({
        parts: [{}, {}, { partNumber: 3, state: UploadPartState.CONFIRMED }],
      });
    });
  });

  it('should give no entry to parts listed beyond the plan and report them apart, in order', async () => {
    storageHas([
      listed(6, CHECKSUM_A, '"e6"'),
      listed(1, CHECKSUM_A, '"e1"'),
      listed(4, CHECKSUM_A, '"e4"'),
    ]);

    const result = await service.classifyParts(session());

    // An array in toMatchObject must have the same length: no entry for parts 4 and 6.
    expect(result).toMatchObject({
      status: 'found',
      parts: [
        { partNumber: 1, state: UploadPartState.UNREGISTERED },
        { partNumber: 2, state: UploadPartState.MISSING },
        { partNumber: 3, state: UploadPartState.MISSING },
      ],
      extraPartNumbers: [4, 6],
    });
  });

  it('should report a vanished upload with the listed uploadId, without reading the registry', async () => {
    storage.listParts.mockResolvedValue({ status: 'no-such-upload' });

    await expect(service.classifyParts(session())).resolves.toEqual({
      status: 'no-such-upload',
      uploadId: 'upload-1',
    });
    expect(partsRepository.findBySession).not.toHaveBeenCalled();
  });

  it('should let a transient storage failure through as STORAGE_UNAVAILABLE, never as a vanished upload', async () => {
    storage.listParts.mockRejectedValue(
      new StorageUnavailableException('ListParts'),
    );

    await expect(service.classifyParts(session())).rejects.toBeInstanceOf(
      StorageUnavailableException,
    );
    expect(partsRepository.findBySession).not.toHaveBeenCalled();
  });

  it('should refuse a session without upload_id, listing nothing', async () => {
    await expect(
      service.classifyParts(session({ upload_id: null })),
    ).rejects.toThrow(`Session ${SESSION_ID} has no upload_id to list`);
    expect(storage.listParts).not.toHaveBeenCalled();
  });
});
