/** Reconciles cache metadata and safely sweeps stale job parts (`P5-MON-05`, F13).
 *
 * @module modules/system/storage-reconciliation
 */

import { sql, type Kysely } from 'kysely';

import type { Database } from '../../db/schema';
import { cacheCountryAdvisoryLockKey } from '../../db/repositories/cache';
import { withTransaction } from '../../db/transaction';
import { StoragePathError, type CacheStorage } from '../storage/storage';

/** Logger contract used by periodic cache reconciliation. */
export interface StorageReconciliationLog {
  readonly info: (context: object, message: string) => void;
  readonly warn: (context: object, message: string) => void;
}

/** Delete a job part only after a full day without modification and no queued/running owner. */
export const STALE_PART_RETENTION_MS = 24 * 60 * 60 * 1_000;

const UUID_PART_PATH = /^\.partial\/([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\.part$/iu;

/**
 * Marks ready versions failed when their files are missing or cannot be safely opened.
 *
 * It takes the same non-blocking exclusive country lock as cache mutations. This prevents racing downloads and active
 * transfers; a busy country is retried on the next housekeeping pass. Database summary/publication fields are updated
 * in the same transaction as the version status.
 *
 * @param database - Application database.
 * @param storage - Cache storage boundary.
 * @param log - Housekeeping logger.
 * @returns Number of ready-version rows marked failed.
 */
export async function reconcileMissingReadyVersions(
  database: Kysely<Database>,
  storage: CacheStorage,
  log: StorageReconciliationLog,
): Promise<number> {
  const candidates = await database
    .selectFrom('map_versions')
    .select('country_id')
    .where('status', '=', 'ready')
    .execute();
  const countryIds = [...new Set(candidates.map(({ country_id }) => country_id))].sort();
  let reconciledVersions = 0;

  for (const countryId of countryIds) {
    try {
      reconciledVersions += await database.connection().execute(async (connection) => {
        const lockKey = cacheCountryAdvisoryLockKey(countryId);
        const lock = await sql<{ locked: boolean }>`
          select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as locked
        `.execute(connection);
        if (lock.rows[0]?.locked !== true) return 0;

        try {
          return await withTransaction(
            connection,
            async (trx) => {
              const country = await trx
                .selectFrom('countries')
                .select('id')
                .where('id', '=', countryId)
                .forUpdate()
                .executeTakeFirst();
              if (country === undefined) return 0;

              const readyVersions = await trx
                .selectFrom('map_versions')
                .select(['id', 'storage_path'])
                .where('country_id', '=', countryId)
                .where('status', '=', 'ready')
                .forUpdate()
                .execute();
              const missingIds: string[] = [];
              for (const version of readyVersions) {
                try {
                  if ((await storage.versionFileAt(version.storage_path).size()) === 0n) {
                    missingIds.push(version.id);
                  }
                } catch (error) {
                  if (error instanceof StoragePathError) {
                    missingIds.push(version.id);
                  } else {
                    throw error;
                  }
                }
              }
              if (missingIds.length === 0) return 0;

              await trx
                .updateTable('map_versions')
                .set({ status: 'failed', failure_reason: 'VERSION_FILE_MISSING', ready_at: null })
                .where('country_id', '=', countryId)
                .where('id', 'in', missingIds)
                .where('status', '=', 'ready')
                .execute();

              const remaining = await trx
                .selectFrom('map_versions')
                .select([
                  sql<string>`count(*) filter (where status = 'ready')::text`.as('ready_count'),
                  sql<string>`coalesce(sum(file_size_bytes) filter (where status = 'ready'), 0)::text`.as(
                    'total_size_bytes',
                  ),
                ])
                .where('country_id', '=', countryId)
                .executeTakeFirstOrThrow();
              const readyCount = parseSafeCount(remaining.ready_count);
              const totalSizeBytes = parseNonNegativeBigint(remaining.total_size_bytes);
              const cache = await trx
                .selectFrom('country_cache')
                .select(['is_public', 'public_since'])
                .where('country_id', '=', countryId)
                .forUpdate()
                .executeTakeFirst();
              if (cache !== undefined) {
                await trx
                  .updateTable('country_cache')
                  .set({
                    is_public: cache.is_public && readyCount > 0,
                    public_since: cache.is_public && readyCount > 0 ? cache.public_since : null,
                    versions_ready_count: readyCount,
                    total_size_bytes: totalSizeBytes,
                    update_state: 'unknown',
                    available_version: null,
                    available_size_bytes: null,
                    available_at: null,
                    updated_at: new Date(),
                  })
                  .where('country_id', '=', countryId)
                  .execute();
              }
              return missingIds.length;
            },
            { statementTimeoutMs: 5_000 },
          );
        } finally {
          try {
            const released = await sql<{ unlocked: boolean }>`
              select pg_advisory_unlock(hashtextextended(${lockKey}, 0)) as unlocked
            `.execute(connection);
            if (released.rows[0]?.unlocked !== true) {
              log.warn({ countryId }, 'cache reconciliation advisory lock was not held at release');
            }
          } catch (error) {
            log.warn({ err: error, countryId }, 'could not release cache reconciliation lock');
          }
        }
      });
    } catch (error) {
      log.warn(
        { err: error, countryId },
        'could not reconcile ready cache files; will retry later',
      );
    }
  }

  if (reconciledVersions > 0) {
    log.info(
      { reconciled: reconciledVersions },
      'ready cache versions with missing files marked failed',
    );
  }
  return reconciledVersions;
}

/**
 * Removes stale UUID-named part files that have no queued or running job owner.
 *
 * Only direct regular files under `.partial` are eligible. Directories, symlinks, malformed names, fresh files, and
 * files belonging to active jobs are left untouched. The path is reconstructed through the validated storage API.
 *
 * @param database - Application database.
 * @param storage - Cache storage boundary.
 * @param log - Housekeeping logger.
 * @param now - Injectable clock for deterministic retention checks.
 * @returns Number of part files safely removed.
 */
export async function sweepStalePartFiles(
  database: Kysely<Database>,
  storage: CacheStorage,
  log: StorageReconciliationLog,
  now = new Date(),
): Promise<number> {
  const cutoff = now.getTime() - STALE_PART_RETENTION_MS;
  const [jobs, entries] = await Promise.all([
    database.selectFrom('jobs').select('id').where('status', 'in', ['queued', 'running']).execute(),
    storage.listEntries(),
  ]);
  const activeJobIds = new Set(jobs.map(({ id }) => id));
  let removed = 0;

  for (const entry of entries) {
    const modifiedAt = entry.modifiedAt.getTime();
    if (entry.kind !== 'file' || !Number.isFinite(modifiedAt) || modifiedAt >= cutoff) continue;
    const match = UUID_PART_PATH.exec(entry.relativePath);
    const jobId = match?.[1];
    if (jobId === undefined || activeJobIds.has(jobId)) continue;

    try {
      const didRemove = await storage.partFile(jobId).remove();
      if (didRemove) removed += 1;
      else log.warn({ jobId }, 'stale cache part could not be removed safely');
    } catch (error) {
      log.warn({ err: error, jobId }, 'stale cache part could not be removed; will retry later');
    }
  }

  if (removed > 0) log.info({ removed }, 'stale cache part files removed');
  return removed;
}

function parseSafeCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new RangeError('ready version count is invalid');
  const parsed = BigInt(value);
  if (parsed > 2_147_483_647n)
    throw new RangeError('ready version count exceeds PostgreSQL integer range');
  return Number(parsed);
}

function parseNonNegativeBigint(value: string): string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new RangeError('ready version size is invalid');
  return value;
}
