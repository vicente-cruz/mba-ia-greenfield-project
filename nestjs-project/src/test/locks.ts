import type { DataSource } from 'typeorm';

/** A promise resolved from outside, to hold a transaction open at a known point. */
export function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/**
 * Waits until a backend of this database is blocked by another one on the lock of a video, the
 * `SELECT … FOR UPDATE` of `VideoLockService`. `pg_stat_activity.query` is truncated at 1024
 * bytes, which cuts the `FOR UPDATE` of the TypeORM SELECT, so the wait is detected by
 * `pg_blocking_pids` and by the start of the query.
 */
export async function waitForBlockedVideoLock(
  dataSource: DataSource,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ blocked }] = await dataSource.query<{ blocked: number }[]>(
      `SELECT count(*)::int AS blocked FROM pg_stat_activity
       WHERE datname = current_database()
         AND cardinality(pg_blocking_pids(pid)) > 0
         AND query LIKE 'SELECT "Video"."id"%'`,
    );
    if (blocked > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('No transaction was blocked on the video lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
