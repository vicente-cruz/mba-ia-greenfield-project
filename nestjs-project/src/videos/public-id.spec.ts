import { QueryFailedError, type EntityManager } from 'typeorm';
import {
  PUBLIC_ID,
  PUBLIC_ID_UNIQUE_CONSTRAINT,
  generatePublicId,
  isPublicIdCollision,
  withPublicIdRetry,
} from './public-id';

function uniqueViolation(constraint: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT INTO "videos" ...',
    [],
    Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint,
    }),
  );
}

describe('generatePublicId', () => {
  it('should produce 11 base64url characters from 8 random bytes', () => {
    const ids = Array.from({ length: 200 }, () => generatePublicId());

    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(Buffer.from(id, 'base64url')).toHaveLength(PUBLIC_ID.BYTES);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isPublicIdCollision', () => {
  it('should accept only a unique violation on videos.public_id', () => {
    expect(
      isPublicIdCollision(uniqueViolation(PUBLIC_ID_UNIQUE_CONSTRAINT)),
    ).toBe(true);
    expect(
      isPublicIdCollision(
        uniqueViolation('UQ_upload_sessions_video_id_active'),
      ),
    ).toBe(false);
    expect(isPublicIdCollision(new Error('duplicate key'))).toBe(false);
  });
});

describe('withPublicIdRetry', () => {
  it('should retry with a new publicId after a forced collision, without an error for the caller', async () => {
    const generate = jest
      .fn<string, []>()
      .mockReturnValueOnce('collision01')
      .mockReturnValueOnce('freshid0002');
    const attempt = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(uniqueViolation(PUBLIC_ID_UNIQUE_CONSTRAINT))
      .mockImplementation((publicId) => Promise.resolve(`saved:${publicId}`));

    await expect(withPublicIdRetry(attempt, { generate })).resolves.toBe(
      'saved:freshid0002',
    );
    expect(attempt.mock.calls).toEqual([['collision01'], ['freshid0002']]);
  });

  it('should not retry an error other than a publicId collision', async () => {
    const otherViolation = uniqueViolation('UQ_7c9ec3c51813238ec19daa0b294');
    const attempt = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValue(otherViolation);

    await expect(withPublicIdRetry(attempt)).rejects.toBe(otherViolation);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('should throw the collision after the last attempt', async () => {
    const collision = uniqueViolation(PUBLIC_ID_UNIQUE_CONSTRAINT);
    const attempt = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValue(collision);

    await expect(withPublicIdRetry(attempt, { maxAttempts: 3 })).rejects.toBe(
      collision,
    );
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('should isolate each attempt in a savepoint inside a transaction', async () => {
    const statements: string[] = [];
    const manager = {
      queryRunner: { isTransactionActive: true },
      query: jest.fn((sql: string) => {
        statements.push(sql);
        return Promise.resolve([]);
      }),
    } as unknown as EntityManager;
    const attempt = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(uniqueViolation(PUBLIC_ID_UNIQUE_CONSTRAINT))
      .mockResolvedValue('saved');

    await withPublicIdRetry(attempt, { manager });

    expect(statements).toEqual([
      'SAVEPOINT public_id_attempt_1',
      'ROLLBACK TO SAVEPOINT public_id_attempt_1',
      'SAVEPOINT public_id_attempt_2',
      'RELEASE SAVEPOINT public_id_attempt_2',
    ]);
  });

  it('should not use savepoints outside a transaction', async () => {
    const query = jest.fn();
    const manager = {
      queryRunner: undefined,
      query,
    } as unknown as EntityManager;

    await withPublicIdRetry(() => Promise.resolve('saved'), { manager });

    expect(query).not.toHaveBeenCalled();
  });
});
