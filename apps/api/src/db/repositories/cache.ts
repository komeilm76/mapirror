/**
 * SQL access to cached-country summaries (`03-data-model.md` §2.4, task `P2-DB-02`).
 *
 * The cache list reuses the catalog projection and filtering so both screens see the same country/cache facts; this
 * module adds the cached-only boundary and detail lookup rather than making every caller repeat a join.
 *
 * @module db/repositories/cache
 */

import type { CountryCacheRow } from '../schema';
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
