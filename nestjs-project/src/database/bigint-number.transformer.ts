import type { ValueTransformer } from 'typeorm';

/**
 * Reads a Postgres `bigint` as a JavaScript number. The `pg` driver returns `bigint` as a string
 * to avoid precision loss; every bigint of this project stays below 2^53 (the largest declared
 * size is 10,000,000,000 bytes), so the conversion is exact. A value outside the safe integer
 * range throws instead of being silently rounded.
 */
export const bigintNumberTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | number | null): number | null => {
    if (value === null) {
      return null;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new RangeError(
        `bigint value ${String(value)} is outside the safe integer range`,
      );
    }
    return parsed;
  },
} satisfies ValueTransformer;
