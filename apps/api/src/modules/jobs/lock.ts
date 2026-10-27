/**
 * Session-level advisory-lock operations shared by job workers and the stale-job reaper.
 *
 * These queries must run through a Kysely instance bound to one PostgreSQL session (`db.connection().execute`). A 64-bit
 * hash keeps all job types on the same ownership protocol while making accidental key collisions negligible.
 *
 * @module modules/jobs/lock
 */

import { sql, type Kysely } from 'kysely';

import type { Database } from '../../db/schema';

/**
 * Attempts to take the session-level lock for one job.
 *
 * @param session - Kysely bound to the connection that will retain the lock.
 * @param jobId - Durable job UUID.
 * @returns `true` only when this session acquired the lock.
 */
export async function tryAcquireJobLock(
  session: Kysely<Database>,
  jobId: string,
): Promise<boolean> {
  const result = await sql<{ acquired: boolean }>`
    select pg_try_advisory_lock(hashtextextended(${jobId}, 0)) as acquired
  `.execute(session);
  return result.rows[0]?.acquired === true;
}

/**
 * Releases this session's job lock. On an unlock-query error, unlocks every advisory lock owned by this dedicated
 * worker/reaper session as a defensive fallback before allowing the connection callback to finish.
 *
 * @param session - Kysely bound to the connection that acquired the lock.
 * @param jobId - Durable job UUID.
 */
export async function releaseJobLock(session: Kysely<Database>, jobId: string): Promise<void> {
  try {
    await sql`select pg_advisory_unlock(hashtextextended(${jobId}, 0))`.execute(session);
  } catch (error) {
    try {
      await sql`select pg_advisory_unlock_all()`.execute(session);
    } catch {
      // A failed PostgreSQL session is discarded by pg-pool; there is no surviving session lock to release.
    }
    throw error;
  }
}
