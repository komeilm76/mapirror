/**
 * Public catalog read model. Every query here applies the publication and ready-version guard (L8).
 *
 * Public routes must use these projections instead of querying `countries`, `country_cache`, or `map_versions`
 * directly. The projections deliberately omit cache internals, job data, storage paths and row ids that have no public
 * meaning. Callers that combine page data and counts in one response should pass a repeatable-read transaction.
 *
 * @module db/repositories/public-catalog
 */

import { sql, type Expression, type SqlBool } from 'kysely';

import type { RepositoryExecutor } from './executor';

/** Smallest supported public page; callers still apply the API's shared pagination parser. */
const MIN_PAGE_SIZE = 1;
/** Largest public page, matching the shared API pagination ceiling. */
const MAX_PAGE_SIZE = 100;

/** A country projection safe for mapping into public catalog responses. */
export interface PublicCountryRow {
  /** Internal join key for follow-up guarded version queries; never serialize this field. */
  readonly country_id: string;
  readonly slug: string;
  readonly name: string;
  readonly continent: string | null;
  readonly iso_alpha2: string[];
  readonly iso_other: string[];
  readonly newest_version: string;
  readonly newest_data_timestamp: Date | null;
  readonly newest_ready_at: Date | null;
  readonly newest_size_bytes: string;
}

/** Public-safe version fields; no storage path, job id or internal row id. */
export interface PublicVersionRow {
  readonly version: string;
  readonly data_timestamp: Date | null;
  readonly file_size_bytes: string;
  readonly checksum_md5: string | null;
  readonly ready_at: Date | null;
}

/** A bounded page and the full matching count, both represented without bigint precision loss. */
export interface PublicReadPage<Row> {
  readonly rows: Row[];
  readonly total: string;
}

/** Required page length and optional zero-based offset for public read-model queries. */
export interface PublicReadPageOptions {
  readonly limit: number;
  readonly offset?: number;
}

/** Public list sort keys; names are always ascending, while size and update recency are descending. */
export type PublicCountrySort = 'name' | 'size' | 'updated';

/** Filters, sort and pagination for the public country list. */
export interface PublicCountryListOptions extends PublicReadPageOptions {
  readonly search?: string;
  readonly continent?: string;
  readonly sort?: PublicCountrySort;
}

/**
 * Lists published countries with their newest ready version.
 *
 * A country appears only when its cache row is explicitly public and at least one ready version exists. The `EXISTS`
 * check protects against inconsistent rows where a cache is marked public but has no ready version. Ordering is stable
 * so adjacent pages do not reorder equal country names.
 */
export async function listPublicCountries(
  executor: RepositoryExecutor,
  options: PublicCountryListOptions,
): Promise<PublicReadPage<PublicCountryRow>> {
  const { limit, offset } = checkedPage(options);
  const accentInsensitive = options.search?.trim() ? await supportsUnaccent(executor) : false;
  const visible = publicCountryBase(executor, publicCountryFilters(options, accentInsensitive));
  const count = await visible
    .select(sql<string>`count(*)::text`.as('total'))
    .executeTakeFirstOrThrow();
  const rows = await orderPublicCountries(newestReadyCountryQuery(visible), options.sort ?? 'name')
    .limit(limit)
    .offset(offset)
    .execute();

  return { rows, total: count.total };
}

/** Returns one published country or `null` for both unknown and unpublished slugs. */
export async function findPublicCountryBySlug(
  executor: RepositoryExecutor,
  slug: string,
): Promise<PublicCountryRow | null> {
  const row = await newestReadyCountryQuery(publicCountryBase(executor))
    .where('c.slug', '=', slug)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Lists only ready versions for a country, and repeats the public guard rather than trusting a caller-supplied id.
 *
 * @param executor - Database or transaction.
 * @param countryId - Internal id obtained from a public country projection.
 * @param options - Bounded page length and optional zero-based offset.
 */
export async function listPublicCountryVersions(
  executor: RepositoryExecutor,
  countryId: string,
  options: PublicReadPageOptions,
): Promise<PublicReadPage<PublicVersionRow>> {
  const { limit, offset } = checkedPage(options);
  const visible = publicCountryBase(executor).where('c.id', '=', countryId);
  const count = await visible
    .innerJoin('map_versions as mv', (join) =>
      join.onRef('mv.country_id', '=', 'c.id').on('mv.status', '=', 'ready'),
    )
    .select(sql<string>`count(*)::text`.as('total'))
    .executeTakeFirstOrThrow();
  const rows = await publicCountryBase(executor)
    .innerJoin('map_versions as mv', (join) =>
      join.onRef('mv.country_id', '=', 'c.id').on('mv.status', '=', 'ready'),
    )
    .where('c.id', '=', countryId)
    .select([
      'mv.version',
      'mv.data_timestamp',
      'mv.file_size_bytes',
      'mv.checksum_md5',
      'mv.ready_at',
    ])
    .orderBy(sql`mv.data_timestamp desc nulls last`)
    .orderBy(sql`mv.ready_at desc nulls last`)
    .orderBy('mv.id', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  return { rows, total: count.total };
}

/** Checks the optional extension without causing a missing-function error inside a caller transaction. */
async function supportsUnaccent(executor: RepositoryExecutor): Promise<boolean> {
  const result = await sql<{ available: boolean }>`
    select to_regprocedure('unaccent(text)') is not null as available
  `.execute(executor);
  return result.rows[0]?.available === true;
}

/** Builds identical visibility-independent list filters for both count and row queries. */
function publicCountryFilters(
  options: PublicCountryListOptions,
  accentInsensitive: boolean,
): Expression<SqlBool>[] {
  const conditions: Expression<SqlBool>[] = [];
  const search = options.search?.trim();
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    const escape = '\\';
    const nameMatch = accentInsensitive
      ? sql<SqlBool>`(
          unaccent(c.name) ILIKE unaccent(${pattern}) ESCAPE ${escape}
          OR c.name ILIKE ${pattern} ESCAPE ${escape}
        )`
      : sql<SqlBool>`c.name ILIKE ${pattern} ESCAPE ${escape}`;
    conditions.push(sql<SqlBool>`(
      ${nameMatch}
      OR c.iso_alpha2 @> ARRAY[upper(${search})]::text[]
      OR c.iso_other @> ARRAY[upper(${search})]::text[]
      OR EXISTS (
        SELECT 1 FROM unnest(c.iso_alpha2 || c.iso_other) AS iso(code)
        WHERE iso.code ILIKE ${pattern} ESCAPE ${escape}
      )
    )`);
  }
  if (options.continent) {
    conditions.push(sql<SqlBool>`c.parent_id = ${options.continent}`);
  }
  return conditions;
}

/** Escapes LIKE metacharacters so a search remains a literal, bounded substring. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}

/** Whitelisted public sort semantics: name A–Z, largest first, or most recently updated first. */
function orderPublicCountries(
  query: ReturnType<typeof newestReadyCountryQuery>,
  sort: PublicCountrySort,
) {
  switch (sort) {
    case 'size':
      return query
        .orderBy('latest.newest_size_bytes', (builder) => builder.desc().nullsLast())
        .orderBy('c.name', 'asc')
        .orderBy('c.id', 'asc');
    case 'updated':
      return query
        .orderBy('latest.newest_data_timestamp', (builder) => builder.desc().nullsLast())
        .orderBy('latest.newest_ready_at', (builder) => builder.desc().nullsLast())
        .orderBy('c.name', 'asc')
        .orderBy('c.id', 'asc');
    case 'name':
      return query.orderBy('c.name', 'asc').orderBy('c.id', 'asc');
  }
}

/** Base query shared by every public read; keep the publication invariant here, not at individual route call sites. */
function publicCountryBase(
  executor: RepositoryExecutor,
  conditions: readonly Expression<SqlBool>[] = [],
) {
  let query = executor
    .selectFrom('countries as c')
    .innerJoin('country_cache as cc', 'cc.country_id', 'c.id')
    .where(PUBLIC_COUNTRY_GUARD);
  for (const condition of conditions) query = query.where(condition);
  return query;
}

/** Projects each visible country with its newest ready row using one lateral index-backed lookup. */
function newestReadyCountryQuery(executor: ReturnType<typeof publicCountryBase>) {
  return executor
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom('map_versions as mv')
          .select([
            'mv.version as newest_version',
            'mv.data_timestamp as newest_data_timestamp',
            'mv.ready_at as newest_ready_at',
            'mv.file_size_bytes as newest_size_bytes',
          ])
          .whereRef('mv.country_id', '=', 'c.id')
          .where('mv.status', '=', 'ready')
          .orderBy(sql`mv.data_timestamp desc nulls last`)
          .orderBy(sql`mv.ready_at desc nulls last`)
          .orderBy('mv.id', 'desc')
          .limit(1)
          .as('latest'),
      (join) => join.onTrue(),
    )
    .select([
      'c.id as country_id',
      'c.slug',
      'c.name',
      'c.parent_id as continent',
      'c.iso_alpha2',
      'c.iso_other',
      'latest.newest_version',
      'latest.newest_data_timestamp',
      'latest.newest_ready_at',
      'latest.newest_size_bytes',
    ]);
}

/** Shared visibility rule: explicit publication plus at least one ready version. */
const PUBLIC_COUNTRY_GUARD: Expression<SqlBool> = sql<SqlBool>`
  cc.is_public = true
  and exists (
    select 1
    from map_versions as public_ready
    where public_ready.country_id = c.id
      and public_ready.status = 'ready'
  )
`;

/** Rejects accidental unbounded reads and invalid offsets before issuing SQL. */
function checkedPage(options: PublicReadPageOptions): { limit: number; offset: number } {
  const offset = options.offset ?? 0;
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < MIN_PAGE_SIZE ||
    options.limit > MAX_PAGE_SIZE ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new RangeError(
      'Public catalog page must use limit 1–100 and a non-negative safe offset.',
    );
  }
  return { limit: options.limit, offset };
}
