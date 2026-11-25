import { expectedPartSize, planUpload } from './upload-plan';

const PART_SIZE = 67_108_864;

describe('planUpload', () => {
  it.each([
    [1, 1],
    [PART_SIZE, 1],
    [PART_SIZE + 1, 2],
    [134_217_728, 2],
    [10_000_000_000, 150],
  ])('should plan %i bytes in %i part(s)', (sizeBytes, partCount) => {
    expect(planUpload(sizeBytes, PART_SIZE)).toEqual({
      partSize: PART_SIZE,
      partCount,
    });
  });

  it.each([0, -1, 1.5])('should refuse sizeBytes = %s', (sizeBytes) => {
    expect(() => planUpload(sizeBytes, PART_SIZE)).toThrow(RangeError);
  });
});

describe('expectedPartSize', () => {
  it('should give full parts and a last part with the remaining bytes', () => {
    expect(expectedPartSize(10_000_000_000, PART_SIZE, 1)).toBe(PART_SIZE);
    expect(expectedPartSize(10_000_000_000, PART_SIZE, 149)).toBe(PART_SIZE);
    expect(expectedPartSize(10_000_000_000, PART_SIZE, 150)).toBe(779_264);
  });

  it('should end an exact multiple of the part size in a full part, never an empty one', () => {
    expect(expectedPartSize(134_217_728, PART_SIZE, 1)).toBe(PART_SIZE);
    expect(expectedPartSize(134_217_728, PART_SIZE, 2)).toBe(PART_SIZE);
  });

  it('should give the whole file to the single part of a small upload', () => {
    expect(expectedPartSize(3_072, PART_SIZE, 1)).toBe(3_072);
  });

  it.each([0, 3, 1.5])(
    'should refuse part %s of a plan of 2 parts',
    (partNumber) => {
      expect(() =>
        expectedPartSize(134_217_728, PART_SIZE, partNumber),
      ).toThrow(RangeError);
    },
  );
});
