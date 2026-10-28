/**
 * SQL access to cached-country summaries (`03-data-model.md` §2.4, task `P2-DB-02`).
 *
 * The cache list reuses the catalog projection and filtering so both screens see the same country/cache facts; this
 * module adds the cached-only boundary and detail lookup rather than making every caller repeat a join.
 *
 * @module db/repositories/cache
 */

import { sql } from 'kysely';

import type { CountryCacheRow, JobType } from '../schema';
import {
  findCatalogCountryById,
  listCatalogCountries,
  type CatalogCountryRow,
  type CatalogListOptions,
} from './catalog';
import type { RepositoryExecutor } from './executor';

/** Cache-list options; a cache query is always restricted to countries with a cache row. */
export type CacheListOptions = Omit<CatalogListOptions, 'cache'>;

/** Lists cached countries with SQL filtering, ordering, count and pagination. */
export async function listCachedCountries(
  executor: RepositoryExecutor,
  options: CacheListOptions = {},
) {
  return listCatalogCountries(executor, { ...options, cache: 'cached' });
}

/** Loads the cache summary, or `null` for a country without a cache row. */
export async function findCountryCache(
  executor: RepositoryExecutor,
  countryId: string,
): Promise<CountryCacheRow | null> {
  const row = await executor
    .selectFrom('country_cache')
    .selectAll()
    .where('country_id', '=', countryId)
    .executeTakeFirst();
  return row ?? null;
}

/** Loads one country and its cache summary, or `null` if it is not cached. */
export async function findCachedCountry(
  executor: RepositoryExecutor,
  countryId: string,
): Promise<CatalogCountryRow | null> {
  const row = await findCatalogCountryById(executor, countryId);
  return row?.cache_country_id === null ? null : row;
}

/** One active job associated with the country whose progress is safe for the admin detail view. */
export interface ActiveCountryJobRow {
  readonly id: string;
  readonly type: JobType;
  readonly status: 'queued' | 'running';
  readonly progress_bytes: string;
  readonly total_bytes: string | null;
}

/** Finds queued/running jobs whose payload names this country, including work without a map-version row yet. */
export async function listActiveCountryJobs(
  executor: RepositoryExecutor,
  countryId: string,
): Promise<ActiveCountryJobRow[]> {
  const rows = await executor
    .selectFrom('jobs')
    .select(['id', 'type', 'status', 'progress_bytes', 'total_bytes'])
    .where(sql<boolean>`payload->>'countryId' = ${countryId}`)
    .where('status', 'in', ['queued', 'running'])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const activeRows: ActiveCountryJobRow[] = [];
  for (const row of rows) {
    if (row.status === 'queued' || row.status === 'running') {
      activeRows.push({ ...row, status: row.status });
    }
  }
  return activeRows;
}

/** Latest successful Geofabrik download-install time for each requested cached country. */
export async function findMostRecentDownloads(
  executor: RepositoryExecutor,
  countryIds: readonly string[],
): Promise<Map<string, Date>> {
  if (countryIds.length === 0) return new Map();

  const rows = await executor
    .selectFrom('map_versions')
    .select(['country_id', sql<Date | null>`max(ready_at)`.as('most_recent_download_at')])
    .where('country_id', 'in', [...countryIds])
    .where('origin', 'in', ['geofabrik_snapshot', 'geofabrik_latest'])
    .where('status', '=', 'ready')
    .where('ready_at', 'is not', null)
    .groupBy('country_id')
    .execute();

  return new Map(
    rows.flatMap((row) =>
      row.most_recent_download_at === null
        ? []
        : [[row.country_id, row.most_recent_download_at] as const],
    ),
  );
}
