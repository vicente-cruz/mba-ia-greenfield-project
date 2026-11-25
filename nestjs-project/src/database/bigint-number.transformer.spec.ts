import { bigintNumberTransformer } from './bigint-number.transformer';

describe('bigintNumberTransformer', () => {
  it('should read the string returned by the driver as an exact integer', () => {
    expect(bigintNumberTransformer.from('10000000000')).toBe(10_000_000_000);
    expect(bigintNumberTransformer.from(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('should keep null', () => {
    expect(bigintNumberTransformer.from(null)).toBeNull();
  });

  it('should throw instead of rounding a value above 2^53 - 1', () => {
    expect(() => bigintNumberTransformer.from('9007199254740993')).toThrow(
      RangeError,
    );
  });

  it('should write the number unchanged', () => {
    expect(bigintNumberTransformer.to(10_000_000_000)).toBe(10_000_000_000);
    expect(bigintNumberTransformer.to(null)).toBeNull();
  });
});
