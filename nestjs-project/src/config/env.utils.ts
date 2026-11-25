const DURATION_UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;

type DurationUnit = keyof typeof DURATION_UNIT_SECONDS;

/** Positive integer followed by a unit: `90s`, `15m`, `24h` or `2d`. */
export const DURATION_PATTERN = /^([1-9]\d*)(s|m|h|d)$/;

export function parseDurationSeconds(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid duration "${value}"`);
  }
  return Number(match[1]) * DURATION_UNIT_SECONDS[match[2] as DurationUnit];
}

/**
 * Reads an integer from the environment, falling back when the key is unset or empty. The value
 * itself is checked by envValidationSchema when the application starts.
 */
export function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  return raw ? Number(raw) : fallback;
}
