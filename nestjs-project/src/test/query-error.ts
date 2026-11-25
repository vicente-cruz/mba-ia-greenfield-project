import { QueryFailedError } from 'typeorm';

/** Fields of the Postgres error behind a failed query (`code` is the SQLSTATE, e.g. 23505). */
export interface PostgresErrorFields {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
}

const FIELDS = ['code', 'constraint', 'detail', 'table', 'column'] as const;

/**
 * Awaits an operation that must fail in the database and returns the fields of the Postgres
 * error, so a test can assert which constraint refused the write. Any other error is rethrown.
 */
export async function captureQueryError(
  operation: Promise<unknown>,
): Promise<PostgresErrorFields> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof QueryFailedError)) {
      throw error;
    }
    const driverError = error.driverError as unknown as Record<string, unknown>;
    const fields: PostgresErrorFields = {};
    for (const field of FIELDS) {
      const value = driverError[field];
      if (typeof value === 'string') {
        fields[field] = value;
      }
    }
    return fields;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}
