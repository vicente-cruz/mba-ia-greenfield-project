/** A wait on an external system that did not answer within its limit. */
export class OperationTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs} ms`);
    this.name = 'OperationTimeoutError';
  }
}

/**
 * Bounds a wait (SI-03.16): with Redis unreachable, BullMQ waits for the connection instead of
 * failing. The bounded call keeps running; whoever bounds it must stay correct if it completes
 * later (an `add` by jobId is idempotent, and a late job of an old generation is inert, P3).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation = 'operation',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OperationTimeoutError(operation, timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
