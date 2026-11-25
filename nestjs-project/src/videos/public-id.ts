import { randomBytes } from 'node:crypto';
import {
  DefaultNamingStrategy,
  QueryFailedError,
  type EntityManager,
} from 'typeorm';

/** Public address of a video (TD-05): 8 random bytes of `node:crypto` in base64url. */
export const PUBLIC_ID = {
  BYTES: 8,
  LENGTH: 11,
  PATTERN: /^[A-Za-z0-9_-]{11}$/,
  MAX_ATTEMPTS: 5,
} as const;

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Name of the unique constraint of `videos.public_id`, as TypeORM names it in the migration
 * (`unique: true` on the column, default naming strategy).
 */
export const PUBLIC_ID_UNIQUE_CONSTRAINT =
  new DefaultNamingStrategy().uniqueConstraintName('videos', ['public_id']);

export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID.BYTES).toString('base64url');
}

/** True only for a unique violation on `videos.public_id`; any other error is not a collision. */
export function isPublicIdCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as unknown as Record<string, unknown>;
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    driverError.constraint === PUBLIC_ID_UNIQUE_CONSTRAINT
  );
}

export interface PublicIdRetryOptions {
  /**
   * Manager of the caller's transaction. Postgres aborts a transaction after a failed statement,
   * so inside one each attempt runs in its own SAVEPOINT and only the failed attempt is undone.
   */
  manager?: EntityManager;
  maxAttempts?: number;
  generate?: () => string;
}

/**
 * Runs `attempt` with a new publicId until it does not collide with an existing one. A collision
 * on `videos.public_id` leads to a new attempt without an error for the caller; any other error,
 * or a collision on the last attempt, is thrown unchanged.
 */
export async function withPublicIdRetry<T>(
  attempt: (publicId: string) => Promise<T>,
  options: PublicIdRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? PUBLIC_ID.MAX_ATTEMPTS;
  const generate = options.generate ?? generatePublicId;
  const transaction = options.manager?.queryRunner?.isTransactionActive
    ? options.manager
    : undefined;

  for (let attemptNumber = 1; ; attemptNumber++) {
    const savepoint = `public_id_attempt_${attemptNumber}`;
    await transaction?.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await attempt(generate());
      await transaction?.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await transaction?.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (!isPublicIdCollision(error) || attemptNumber >= maxAttempts) {
        throw error;
      }
    }
  }
}
