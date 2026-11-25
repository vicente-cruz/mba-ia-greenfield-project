import { OperationTimeoutError, withTimeout } from './with-timeout';

describe('withTimeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('should resolve with the value of a call that answers within the limit', async () => {
    await expect(
      withTimeout(Promise.resolve('job'), 1_000, 'add'),
    ).resolves.toBe('job');
  });

  it('should reject with OperationTimeoutError when the call does not answer within the limit', async () => {
    jest.useFakeTimers();
    const waiting = withTimeout(new Promise(() => undefined), 5_000, 'add');
    const assertion = expect(waiting).rejects.toEqual(
      new OperationTimeoutError('add', 5_000),
    );

    await jest.advanceTimersByTimeAsync(5_000);

    await assertion;
  });

  it('should pass on the failure of the call', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('refused')), 1_000),
    ).rejects.toThrow('refused');
  });
});
