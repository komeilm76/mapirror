/**
 * SQL access to the local source catalog (`03-data-model.md` §2.3, task `P2-DB-02`).
 *
 * Filtering, search, sort, count and page slicing all happen in PostgreSQL. Name search is an `ILIKE '%…%'` pattern
 * backed by `countries_name_trgm`; when the optional `unaccent` extension is installed, an additional predicate makes
 * it accent-insensitive. If that contrib extension is absent, the query retries with case-insensitive search. ISO codes
 * are searched in the stored array. The caller gets only one page plus a count, never the whole catalog in memory.
 *
 * @module db/repositories/catalog
 */

import { parsePagination } from '@mapirror/shared';
import { sql, type Expression, type SelectQueryBuilder, type SqlBool } from 'kysely';

import type { Country, Database } from '../schema';
import type { RepositoryExecutor } from './executor';

/** Stable order keys exposed to callers; SQL identifiers are never accepted from request data. */
export type CatalogSort = 'name' | 'sourceSizeHintBytes' | 'lastSyncedAt' | 'totalSizeBytes';
/** Direction for a whitelisted catalog sort. */
export type SortOrder = 'asc' | 'desc';

/** Filters used by the catalog and cache tables. */
export interface CatalogFilters {
  /** Partial country name or ISO code; trimmed, and SQL LIKE metacharacters are treated literally. */
  readonly search?: string;
  /** Source parent id such as `europe`. */
  readonly continent?: string;
  /** `cached` and `uncached` filter by the presence of a `country_cache` row. */
  readonly cache?: 'all' | 'cached' | 'uncached';
  /** When true, only countries with a source update available are returned. */
  readonly updateAvailable?: boolean;
}

/** Pagination and ordering accepted by a catalog list query. */
export interface CatalogListOptions extends CatalogFilters {
  /** 1-based page. The shared parser clamps malformed and excessive values. */
  readonly page?: number;
  /** Page length, clamped to the shared maximum of 100. */
  readonly limit?: number;
  readonly sort?: CatalogSort;
  readonly order?: SortOrder;
}

/** One country joined to its optional cache summary, in database naming. */
export interface CatalogCountryRow {
  readonly id: string;
  readonly source: string;
  readonly source_id: string;
  readonly parent_id: string | null;
  readonly slug: string;
  readonly name: string;
  readonly iso_alpha2: string[];
  readonly iso_other: string[];
  readonly source_pbf_url: string | null;
  readonly source_size_hint_bytes: string | null;
  readonly catalog_synced_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly cache_country_id: string | null;
  readonly is_public: boolean | null;
  readonly public_since: Date | null;
  readonly update_state: 'unknown' | 'up_to_date' | 'update_available' | null;
  readonly available_version: string | null;
  readonly available_size_bytes: string | null;
  readonly available_at: Date | null;
  readonly update_checked_at: Date | null;
  readonly versions_ready_count: number | null;
  readonly total_size_bytes: string | null;
  readonly cache_created_at: Date | null;
  readonly cache_updated_at: Date | null;
}

/** A page of joined catalog rows and the count before pagination. */
export interface CatalogPage {
  readonly rows: CatalogCountryRow[];
  /** PostgreSQL `count(*)` as decimal text, matching the driver's int8 representation. */
  readonly total: string;
}

/** Source facts supplied by the catalog sync service. Existing slugs are preserved on conflict. */
export interface CatalogCountryInput {
  readonly source: string;
  readonly sourceId: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly isoAlpha2: readonly string[];
  readonly isoOther: readonly string[];
  readonly sourcePbfUrl: string | null;
  readonly sourceSizeHintBytes: string | number | bigint | null;
}

/**
 * Inserts or refreshes one source-catalog row.
 *
 * A conflict on `(source, source_id)` refreshes upstream facts but deliberately leaves the existing slug alone:
 * collision resolution must never rewrite a URL or cache path after one has been assigned.
 *
 * @param executor - Kysely database or transaction.
 * @param country - Parsed upstream facts and the candidate slug for a new source row.
 * @param syncedAt - The sync instant shared by every row in a catalog run.
 * @returns The row as stored (including its stable slug).
 */
export async function upsertCatalogCountry(
  executor: RepositoryExecutor,
  country: CatalogCountryInput,
  syncedAt: Date = new Date(),
): Promise<Country> {
  return executor
    .insertInto('countries')
    .values({
      source: country.source,
      source_id: country.sourceId,
      parent_id: country.parentId,
      slug: country.slug,
      name: country.name,
      iso_alpha2: [...country.isoAlpha2],
      iso_other: [...country.isoOther],
      source_pbf_url: country.sourcePbfUrl,
      source_size_hint_bytes: country.sourceSizeHintBytes,
      catalog_synced_at: syncedAt,
      created_at: syncedAt,
      updated_at: syncedAt,
    })
    .onConflict((conflict) =>
      conflict.columns(['source', 'source_id']).doUpdateSet({
        parent_id: country.parentId,
        name: country.name,
        iso_alpha2: [...country.isoAlpha2],
        iso_other: [...country.isoOther],
        source_pbf_url: country.sourcePbfUrl,
        source_size_hint_bytes: country.sourceSizeHintBytes,
        catalog_synced_at: syncedAt,
        updated_at: syncedAt,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Loads a country by its local, URL-safe slug. */
export async function findCountryBySlug(
  executor: RepositoryExecutor,
  slug: string,
): Promise<Country | null> {
  const row = await executor
    .selectFrom('countries')
    .selectAll()
    .where('slug', '=', slug)
    .executeTakeFirst();
  return row ?? null;
}

/** Loads a country by its local UUID. */
export async function findCountryById(
  executor: RepositoryExecutor,
  countryId: string,
): Promise<Country | null> {
  const row = await executor
    .selectFrom('countries')
    .selectAll()
    .where('id', '=', countryId)
    .executeTakeFirst();
  return row ?? null;
}

/** Loads one catalog row with its optional cache summary. */
export async function findCatalogCountryById(
  executor: RepositoryExecutor,
  countryId: string,
): Promise<CatalogCountryRow | null> {
  const row = await executor
    .selectFrom('countries')
    .leftJoin('country_cache', 'country_cache.country_id', 'countries.id')
    .select(catalogColumns)
    .where('countries.id', '=', countryId)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Lists catalog countries, with the cache summary joined and all filters applied before count and page slicing.
 *
 * @param executor - Kysely database or transaction.
 * @param options - Filters, page and whitelisted order fields.
 * @returns The selected rows and the complete filtered count.
 */
export async function listCatalogCountries(
  executor: RepositoryExecutor,
  options: CatalogListOptions = {},
): Promise<CatalogPage> {
  if (!options.search?.trim()) return listCatalogCountriesWithSearchMode(executor, options, false);

  try {
    return await listCatalogCountriesWithSearchMode(executor, options, true);
  } catch (error) {
    // `unaccent` is optional at migration time. PostgreSQL reports SQLSTATE 42883 only when that function is absent;
    // keep name/ISO search useful on minimal servers without hiding any other database error.
    if (!isUndefinedFunction(error)) throw error;
    return listCatalogCountriesWithSearchMode(executor, options, false);
  }
}

/** Runs the count and page query with the same optional accent-folding predicate. */
async function listCatalogCountriesWithSearchMode(
  executor: RepositoryExecutor,
  options: CatalogListOptions,
  accentInsensitive: boolean,
): Promise<CatalogPage> {
  const { offset, limit } = parsePage(options.page, options.limit);
  const filters = catalogConditions(options, accentInsensitive);
  const base = executor
    .selectFrom('countries')
    .leftJoin('country_cache', 'country_cache.country_id', 'countries.id');

  let countQuery = base.select(sql<string>`count(*)::text`.as('total'));
  countQuery = applyConditions(countQuery, filters);
  const count = await countQuery.executeTakeFirstOrThrow();

  let rowsQuery = applyConditions(base.select(catalogColumns), filters);
  rowsQuery = orderCatalogRows(rowsQuery, options.sort ?? 'name', options.order ?? 'asc');
  const rows = await rowsQuery.limit(limit).offset(offset).execute();

  return { rows, total: count.total };
}

/** Shared SQL expressions for page counts and row selection. */
function catalogConditions(
  options: CatalogFilters,
  accentInsensitive: boolean,
): Expression<SqlBool>[] {
  const conditions: Expression<SqlBool>[] = [];
  const search = options.search?.trim();
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    const escape = '\\';
    const nameMatch = accentInsensitive
      ? sql<SqlBool>`(
          unaccent(countries.name) ILIKE unaccent(${pattern}) ESCAPE ${escape}
          OR countries.name ILIKE ${pattern} ESCAPE ${escape}
        )`
      : sql<SqlBool>`countries.name ILIKE ${pattern} ESCAPE ${escape}`;
    conditions.push(sql<SqlBool>`(
      ${nameMatch}
      OR countries.iso_alpha2 @> ARRAY[upper(${search})]::text[]
      OR EXISTS (
        SELECT 1 FROM unnest(countries.iso_alpha2) AS iso(code)
        WHERE iso.code ILIKE ${pattern} ESCAPE ${escape}
      )
    )`);
  }
  if (options.continent) {
    conditions.push(sql<SqlBool>`countries.parent_id = ${options.continent}`);
  }
  if (options.cache === 'cached') {
    conditions.push(sql<SqlBool>`country_cache.country_id IS NOT NULL`);
  } else if (options.cache === 'uncached') {
    conditions.push(sql<SqlBool>`country_cache.country_id IS NULL`);
  }
  if (options.updateAvailable === true) {
    conditions.push(sql<SqlBool>`country_cache.update_state = 'update_available'`);
  }
  return conditions;
}

/** Identical filter application is used for the list and count, preventing count/page drift. */
function applyConditions<O>(
  query: SelectQueryBuilder<Database, 'countries' | 'country_cache', O>,
  conditions: readonly Expression<SqlBool>[],
): SelectQueryBuilder<Database, 'countries' | 'country_cache', O> {
  let filtered = query;
  for (const condition of conditions) filtered = filtered.where(condition);
  return filtered;
}

/** Safe sort values compiled to SQL identifiers; no request string is interpolated as SQL. */
function orderCatalogRows<O>(
  query: SelectQueryBuilder<Database, 'countries' | 'country_cache', O>,
  sort: CatalogSort,
  order: SortOrder,
): SelectQueryBuilder<Database, 'countries' | 'country_cache', O> {
  switch (sort) {
    case 'sourceSizeHintBytes':
      return query
        .orderBy('countries.source_size_hint_bytes', (builder) =>
          (order === 'asc' ? builder.asc() : builder.desc()).nullsLast(),
        )
        .orderBy('countries.name', 'asc')
        .orderBy('countries.id', 'asc');
    case 'lastSyncedAt':
      return query
        .orderBy('countries.catalog_synced_at', order)
        .orderBy('countries.name', 'asc')
        .orderBy('countries.id', 'asc');
    case 'totalSizeBytes':
      return query
        .orderBy('country_cache.total_size_bytes', (builder) =>
          (order === 'asc' ? builder.asc() : builder.desc()).nullsLast(),
        )
        .orderBy('countries.name', 'asc')
        .orderBy('countries.id', 'asc');
    case 'name':
      return query.orderBy('countries.name', order).orderBy('countries.id', 'asc');
  }
}

/** Columns shared by catalog and cache list results. */
const catalogColumns = [
  'countries.id',
  'countries.source',
  'countries.source_id',
  'countries.parent_id',
  'countries.slug',
  'countries.name',
  'countries.iso_alpha2',
  'countries.iso_other',
  'countries.source_pbf_url',
  'countries.source_size_hint_bytes',
  'countries.catalog_synced_at',
  'countries.created_at',
  'countries.updated_at',
  'country_cache.country_id as cache_country_id',
  'country_cache.is_public',
  'country_cache.public_since',
  'country_cache.update_state',
  'country_cache.available_version',
  'country_cache.available_size_bytes',
  'country_cache.available_at',
  'country_cache.update_checked_at',
  'country_cache.versions_ready_count',
  'country_cache.total_size_bytes',
  'country_cache.created_at as cache_created_at',
  'country_cache.updated_at as cache_updated_at',
] as const;

/** Recognises only PostgreSQL's missing-`unaccent` error; unrelated undefined-function failures still surface. */
function isUndefinedFunction(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '42883' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('unaccent')
  );
}

/** Enforce the shared page, limit and safe-offset rules even when a caller bypasses request parsing. */
function parsePage(
  page: number | undefined,
  limit: number | undefined,
): { offset: number; limit: number } {
  return parsePagination({ page, limit });
}

/** Escape LIKE metacharacters so a search string is literal and stays a useful indexed pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}
