import { Test } from '@nestjs/testing';
import videoConfig from '../../config/video.config';
import { StorageService } from '../../storage/storage.service';
import { UploadSessionStatus } from '../../videos/entities/upload-session.entity';
import { VideoStatus } from '../../videos/entities/video.entity';
import {
  parseOriginalObjectKey,
  parseThumbnailObjectKey,
} from '../../videos/storage-keys';
import { UploadSessionsService } from '../../videos/upload-sessions.service';
import {
  decideOriginalKey,
  decideThumbnail,
  type OriginalKeyFacts,
  pastGrace,
  type ThumbnailVideoFacts,
} from './storage-cleaner.decisions';
import { StorageCleanerService } from './storage-cleaner.service';
import { StorageCleanupRepository } from './storage-cleanup.repository';

const VIDEO_ID = '0b5c3f0e-4a59-4c5b-9a43-6b2f6f1d8e21';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const ATTEMPT_ID = 'a6f1b2c3-d4e5-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_ATTEMPT = 'b7e2c3d4-e5f6-4a71-9b8c-0d1e2f3a4b5c';
const ORIGINAL = `originals/${VIDEO_ID}/${SESSION_ID}`;
const thumbnail = (attemptId: string) =>
  `thumbnails/${VIDEO_ID}/${attemptId}.jpg`;

function original(
  status: UploadSessionStatus | null,
  claimExpired = false,
  referenced = false,
): OriginalKeyFacts {
  return {
    session: status
      ? { sessionId: SESSION_ID, videoId: VIDEO_ID, status, claimExpired }
      : null,
    referenced,
  };
}

describe('StorageCleanerService', () => {
  describe('table of originals and multiparts of P4', () => {
    it.each<[string, OriginalKeyFacts, string]>([
      ['a key without a session row', original(null), 'remove'],
      ['an aborted session', original(UploadSessionStatus.ABORTED), 'remove'],
      [
        'an aborted session whose key some video references',
        original(UploadSessionStatus.ABORTED, false, true),
        'keep',
      ],
      [
        'a key without a row that some video references',
        original(null, false, true),
        'keep',
      ],
      [
        'a completed session referenced by original_key',
        original(UploadSessionStatus.COMPLETED, false, true),
        'keep',
      ],
      [
        'a completed session, even unreferenced',
        original(UploadSessionStatus.COMPLETED),
        'keep',
      ],
      ['an active session', original(UploadSessionStatus.ACTIVE), 'keep'],
      [
        'a completing session, even with an expired claim',
        original(UploadSessionStatus.COMPLETING, true),
        'keep',
      ],
      [
        'an initiating session with an expired claim',
        original(UploadSessionStatus.INITIATING, true),
        'claim-and-abort',
      ],
      [
        'an aborting session with an expired claim',
        original(UploadSessionStatus.ABORTING, true),
        'claim-and-abort',
      ],
      [
        'an initiating session within its claim',
        original(UploadSessionStatus.INITIATING),
        'keep',
      ],
      [
        'an aborting session within its claim',
        original(UploadSessionStatus.ABORTING),
        'keep',
      ],
    ])('%s → %s', (_, facts, conduct) => {
      expect(decideOriginalKey(facts)).toBe(conduct);
    });
  });

  describe('table of derivatives of P4', () => {
    const video = (
      status: VideoStatus,
      overrides: Partial<ThumbnailVideoFacts> = {},
    ): ThumbnailVideoFacts => ({
      status,
      thumbnailKey: null,
      currentAttemptId: null,
      ...overrides,
    });

    it.each<[string, string, ThumbnailVideoFacts | null, string]>([
      [
        'ready, the published key',
        ATTEMPT_ID,
        video(VideoStatus.READY, { thumbnailKey: thumbnail(ATTEMPT_ID) }),
        'keep',
      ],
      [
        'ready, another attempt',
        OTHER_ATTEMPT,
        video(VideoStatus.READY, { thumbnailKey: thumbnail(ATTEMPT_ID) }),
        'remove',
      ],
      [
        'error, even the residual current attempt',
        ATTEMPT_ID,
        video(VideoStatus.ERROR, { currentAttemptId: ATTEMPT_ID }),
        'remove',
      ],
      [
        'processing, the current attempt',
        ATTEMPT_ID,
        video(VideoStatus.PROCESSING, { currentAttemptId: ATTEMPT_ID }),
        'keep',
      ],
      [
        'processing, another attempt',
        OTHER_ATTEMPT,
        video(VideoStatus.PROCESSING, { currentAttemptId: ATTEMPT_ID }),
        'remove',
      ],
      [
        'processing without a current attempt',
        OTHER_ATTEMPT,
        video(VideoStatus.PROCESSING),
        'keep',
      ],
      ['draft', ATTEMPT_ID, video(VideoStatus.DRAFT), 'keep'],
      ['no video row', ATTEMPT_ID, null, 'keep'],
    ])('%s → %s', (_, attemptId, facts, conduct) => {
      expect(decideThumbnail(thumbnail(attemptId), attemptId, facts)).toBe(
        conduct,
      );
    });
  });

  describe('keys and grace', () => {
    it('should read only the keys of the layout of the phase', () => {
      expect(parseOriginalObjectKey(ORIGINAL)).toEqual({
        videoId: VIDEO_ID,
        sessionId: SESSION_ID,
      });
      expect(parseThumbnailObjectKey(thumbnail(ATTEMPT_ID))).toEqual({
        videoId: VIDEO_ID,
        attemptId: ATTEMPT_ID,
      });
      for (const key of [
        `originals/${VIDEO_ID}/`,
        `originals/${VIDEO_ID}/${SESSION_ID}/extra`,
        `originals/not-a-uuid/${SESSION_ID}`,
        `tests/originals/${VIDEO_ID}/${SESSION_ID}`,
      ]) {
        expect(parseOriginalObjectKey(key)).toBeNull();
      }
      for (const key of [
        `thumbnails/${VIDEO_ID}/${ATTEMPT_ID}.png`,
        `thumbnails/${VIDEO_ID}/latest.jpg`,
      ]) {
        expect(parseThumbnailObjectKey(key)).toBeNull();
      }
    });

    it.each<[number | null, boolean]>([
      [3_600_000, true],
      [3_599_999, false],
      [0, false],
      [null, false],
    ])('an object of age %s ms is past the grace of 1 h: %s', (age, past) => {
      const now = 1_800_000_000_000;
      expect(
        pastGrace(
          age === null ? undefined : new Date(now - age),
          now,
          3_600_000,
        ),
      ).toBe(past);
    });
  });

  describe('passes with doubles', () => {
    let service: StorageCleanerService;
    let storage: {
      listObjects: jest.Mock;
      listMultipartUploads: jest.Mock;
      deleteObject: jest.Mock;
      abortMultipartUpload: jest.Mock;
      listParts: jest.Mock;
    };
    let facts: { originalKeyFacts: jest.Mock; thumbnailVideoFacts: jest.Mock };
    let sessions: { sweepAbort: jest.Mock };
    const old = new Date(Date.now() - 2 * 3_600_000);

    beforeEach(async () => {
      storage = {
        listObjects: jest.fn().mockResolvedValue({ objects: [] }),
        listMultipartUploads: jest.fn().mockResolvedValue([]),
        deleteObject: jest.fn().mockResolvedValue(undefined),
        abortMultipartUpload: jest
          .fn()
          .mockResolvedValue({ status: 'aborted' }),
        listParts: jest.fn().mockResolvedValue({ status: 'no-such-upload' }),
      };
      facts = {
        originalKeyFacts: jest.fn((keys: string[]) =>
          Promise.resolve(new Map(keys.map((key) => [key, original(null)]))),
        ),
        thumbnailVideoFacts: jest.fn().mockResolvedValue(new Map()),
      };
      sessions = { sweepAbort: jest.fn().mockResolvedValue('aborted') };
      const moduleRef = await Test.createTestingModule({
        providers: [
          StorageCleanerService,
          { provide: StorageService, useValue: storage },
          { provide: StorageCleanupRepository, useValue: facts },
          { provide: UploadSessionsService, useValue: sessions },
          {
            provide: videoConfig.KEY,
            useValue: { storageCleanupGraceMs: 3_600_000 },
          },
        ],
      }).compile();
      service = moduleRef.get(StorageCleanerService);
    });

    function originalsPage(keys: string[], next?: string) {
      return {
        objects: keys.map((key) => ({
          key,
          size: 1,
          etag: 'e',
          lastModified: old,
        })),
        nextContinuationToken: next,
      };
    }

    it('should not remove a key whose facts changed at the re-read right before the removal', async () => {
      storage.listObjects.mockImplementation((prefix: string) =>
        Promise.resolve(
          prefix === 'originals/' ? originalsPage([ORIGINAL]) : { objects: [] },
        ),
      );
      facts.originalKeyFacts
        .mockResolvedValueOnce(new Map([[ORIGINAL, original(null)]]))
        // A session row appears for the key before the removal.
        .mockResolvedValueOnce(
          new Map([[ORIGINAL, original(UploadSessionStatus.ACTIVE)]]),
        );

      await expect(service.run({ batchSize: 10 })).resolves.toMatchObject({
        removed: 0,
        kept: 1,
      });

      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('should keep an eligible object younger than the grace', async () => {
      storage.listObjects.mockImplementation((prefix: string) =>
        Promise.resolve(
          prefix === 'originals/'
            ? {
                objects: [
                  {
                    key: ORIGINAL,
                    size: 1,
                    etag: 'e',
                    lastModified: new Date(),
                  },
                ],
              }
            : { objects: [] },
        ),
      );

      await expect(service.run({ batchSize: 10 })).resolves.toMatchObject({
        removed: 0,
        withinGrace: 1,
      });
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('should take the ownership of an expired initiating session through the sweep, never abort it directly', async () => {
      storage.listMultipartUploads.mockResolvedValue([
        { key: ORIGINAL, uploadId: 'u1', initiated: old },
        { key: ORIGINAL, uploadId: 'u2', initiated: old },
      ]);
      facts.originalKeyFacts.mockResolvedValue(
        new Map([[ORIGINAL, original(UploadSessionStatus.INITIATING, true)]]),
      );

      await expect(service.run({ batchSize: 10 })).resolves.toMatchObject({
        claimed: 1,
        aborted: 0,
      });

      expect(sessions.sweepAbort).toHaveBeenCalledTimes(1);
      expect(sessions.sweepAbort).toHaveBeenCalledWith(VIDEO_ID, SESSION_ID);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should move the object listings on between runs and start again at their end', async () => {
      storage.listObjects.mockImplementation(
        (prefix: string, options: { continuationToken?: string }) =>
          Promise.resolve(
            prefix !== 'originals/'
              ? { objects: [] }
              : options.continuationToken === 't1'
                ? originalsPage([`${ORIGINAL}-second`])
                : originalsPage([`${ORIGINAL}-first`], 't1'),
          ),
      );

      await service.run({ batchSize: 1 });
      await service.run({ batchSize: 1 });
      await service.run({ batchSize: 1 });

      const tokens = storage.listObjects.mock.calls
        .filter(([prefix]) => prefix === 'originals/')
        .map(
          ([, options]) =>
            (options as { continuationToken?: string }).continuationToken,
        );
      expect(tokens).toEqual([undefined, 't1', undefined]);
    });

    it('should take the multipart batch after the last upload handled, wrapping at the end', async () => {
      const uploads = ['a', 'b', 'c'].map((suffix) => ({
        key: `originals/${VIDEO_ID}/${SESSION_ID.slice(0, -1)}${suffix}`,
        uploadId: suffix,
        initiated: old,
      }));
      storage.listMultipartUploads.mockResolvedValue([...uploads].reverse());
      const aborted: string[] = [];
      storage.abortMultipartUpload.mockImplementation(
        (_key: string, uploadId: string) => {
          aborted.push(uploadId);
          return Promise.resolve({ status: 'aborted' });
        },
      );

      for (let run = 0; run < 4; run++) {
        await service.run({ batchSize: 2 });
      }

      // Each run takes at most 2, after the last one handled; the end starts again.
      expect(aborted).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    });

    it('should finish the other passes when one fails, and then fail the run', async () => {
      storage.listMultipartUploads.mockRejectedValue(new Error('storage down'));
      storage.listObjects.mockImplementation((prefix: string) =>
        Promise.resolve(
          prefix === 'originals/' ? originalsPage([ORIGINAL]) : { objects: [] },
        ),
      );

      await expect(service.run({ batchSize: 10 })).rejects.toThrow(
        'cleanup of the storage: 1 of 3 passes failed',
      );
      expect(storage.deleteObject).toHaveBeenCalledWith(ORIGINAL);
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'should refuse a batchSize of %s',
      async (batchSize) => {
        await expect(service.run({ batchSize })).rejects.toThrow(
          'invalid batchSize',
        );
      },
    );
  });
});
