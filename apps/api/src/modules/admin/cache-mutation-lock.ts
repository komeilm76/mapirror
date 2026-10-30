/** Exclusive per-country lock held across a cache mutation and its post-commit file cleanup (`P2-API-06`, `P2-API-08`).
 *
 * @module modules/admin/cache-mutation-lock
 */

import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/schema';
import { cacheCountryAdvisoryLockKey } from '../../db/repositories/cache';
import { AppError } from '../../lib/errors';

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 50;

/** Minimal logging contract for API routes and background workers sharing the cache mutation lock. */
export interface CacheMutationLockLogger {
  readonly warn: (context: object, message: string) => void;
}

/** Runs a country-cache mutation while excluding admissions and streams until its cleanup callback has finished. */
export async function withCacheCountryMutationLock<T>(
  connection: Kysely<Database>,
  countryId: string,
  logger: CacheMutationLockLogger,
  mutateAndClean: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lockKey = cacheCountryAdvisoryLockKey(countryId);
  await acquireExclusiveLock(connection, lockKey, signal);
  try {
    return await mutateAndClean();
  } finally {
    await releaseExclusiveLock(connection, lockKey, logger);
  }
}

/** Waits up to five seconds for a stream/admission to release its shared or transaction-scoped lock. */
async function acquireExclusiveLock(
  connection: Kysely<Database>,
  lockKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error('Cache mutation canceled.');
    const result = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as locked
    `.execute(connection);
    if (result.rows[0]?.locked === true) return;
    await delay(LOCK_POLL_INTERVAL_MS);
  }
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('Cache mutation canceled.');
  throw new AppError(
    'JOB_ALREADY_RUNNING',
    'Another cache operation is still in progress. Try again shortly.',
  );
}

/** Releases the session lock after file cleanup; connection teardown remains the fallback on an unlock failure. */
async function releaseExclusiveLock(
  connection: Kysely<Database>,
  lockKey: string,
  logger: CacheMutationLockLogger,
): Promise<void> {
  try {
    const result = await sql<{ unlocked: boolean }>`
      select pg_advisory_unlock(hashtextextended(${lockKey}, 0)) as unlocked
    `.execute(connection);
    if (result.rows[0]?.unlocked !== true) {
      logger.warn({ countryLock: lockKey }, 'cache mutation advisory lock was not held at release');
    }
  } catch (error) {
    logger.warn(
      { err: error, countryLock: lockKey },
      'could not explicitly release cache-mutation advisory lock; connection teardown will release it',
    );
  }
}

/** Timer shared by bounded advisory-lock polling. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
