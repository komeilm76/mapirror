/**
 * Idempotent enqueueing for the Geofabrik catalog synchronization job (`P2-API-02`).
 *
 * A transaction-scoped advisory lock serializes requesters across API processes. Under that lock, an existing queued or
 * running job is returned; otherwise one new job is inserted. The API endpoint and CLI call this same function, so
 * neither can bypass the durable queue or race each other into duplicate active work.
 *
 * @module modules/jobs/enqueue-catalog-sync
 */

import { sql, type Kysely } from 'kysely';

import type { Database } from '../../db/schema';
import { withTransaction } from '../../db/transaction';

/** Stable key shared by every API and CLI catalog-sync enqueuer. */
export const CATALOG_SYNC_ENQUEUE_LOCK = 'mapirror.catalog_sync.enqueue:geofabrik';

/** Values associated with a manually requested catalog sync. */
export interface EnqueueCatalogSyncOptions {
  /** Administrator requesting the job; omitted for an operator CLI invocation. */
  readonly createdBy?: string;
}

/**
 * Returns the active catalog-sync job id, creating a queued job only when none exists.
 *
 * The transaction lock is held only while checking and inserting the small database row; network work always belongs to
 * the worker after commit. Repeated and simultaneous requests share the same queued/running id.
 *
 * @param database - Pool-level database handle.
 * @param options - Optional administrator attribution.
 * @returns The id of the existing active job or the newly inserted job.
 */
export async function enqueueCatalogSyncJob(
  database: Kysely<Database>,
  options: EnqueueCatalogSyncOptions = {},
): Promise<string> {
  return withTransaction(database, async (trx) => {
    await sql`
      select pg_advisory_xact_lock(hashtextextended(${CATALOG_SYNC_ENQUEUE_LOCK}, 0))
    `.execute(trx);

    const active = await trx
      .selectFrom('jobs')
      .select('id')
      .where('type', '=', 'catalog_sync')
      .where('status', 'in', ['queued', 'running'])
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .executeTakeFirst();
    if (active !== undefined) return active.id;

    const job = await trx
      .insertInto('jobs')
      .values({
        type: 'catalog_sync',
        payload: { source: 'geofabrik' },
        created_by: options.createdBy ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return job.id;
  });
}
