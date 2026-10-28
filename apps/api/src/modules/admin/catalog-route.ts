/**
 * Admin catalog listing (`P2-API-01`).
 *
 * @module modules/admin/catalog-route
 */

import {
  buildPageMeta,
  CatalogQuerySchema,
  parsePagination,
  type CatalogListItem,
  type CatalogListResponse,
} from '@mapirror/shared';
import type { FastifyRequest } from 'fastify';

import {
  findCatalogSyncedAt,
  listCatalogCountries,
  type CatalogListOptions,
  type CatalogSort,
} from '../../db/repositories/catalog';

/** The maximum catalog page size, also enforced by the shared pagination parser. */
const MAX_CATALOG_PAGE_SIZE = 100;
/** Catalog's documented default is larger than the generic list default. */
const DEFAULT_CATALOG_PAGE_SIZE = 50;
const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Handles `GET /_admin/api/catalog` with one repeatable-read snapshot for rows and freshness metadata.
 *
 * @param request - Fastify request carrying query parameters.
 * @returns A bounded, validated catalog page.
 */
export async function getCatalog(request: FastifyRequest): Promise<CatalogListResponse> {
  const parsed = CatalogQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;

  const query = parsed.data;
  const pagination = parsePagination(query, {
    defaultLimit: DEFAULT_CATALOG_PAGE_SIZE,
    maxLimit: MAX_CATALOG_PAGE_SIZE,
  });
  const options: CatalogListOptions = {
    search: query.q,
    continent: query.continent,
    cache: query.cache === 'all' ? undefined : query.cache,
    updateAvailable: query.update === 'available',
    page: pagination.page,
    limit: pagination.limit,
    sort: catalogSort(query.sort ?? 'name'),
    order: query.order ?? 'asc',
  };

  // Three reads (marker, count and page) must describe one committed catalog version if a sync overlaps this request.
  const snapshot = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const catalogSyncedAt = await findCatalogSyncedAt(trx);
      const page = await listCatalogCountries(trx, options);
      return { catalogSyncedAt, page };
    });

  const total = safeCount(snapshot.page.total);
  return {
    data: snapshot.page.rows.map(toCatalogListItem),
    meta: buildPageMeta(pagination.page, pagination.limit, total),
    catalogSyncedAt: snapshot.catalogSyncedAt?.toISOString() ?? null,
  };
}

/** Maps the public sort vocabulary to fixed database columns. */
function catalogSort(sort: 'name' | 'size' | 'updated' | 'created'): CatalogSort {
  switch (sort) {
    case 'name':
      return 'name';
    case 'size':
      return 'sourceSizeHintBytes';
    case 'updated':
      return 'lastSyncedAt';
    case 'created':
      return 'createdAt';
  }
}

/** Projects database names and int8 strings into the explicit, JSON-safe public response. */
function toCatalogListItem(
  row: Awaited<ReturnType<typeof listCatalogCountries>>['rows'][number],
): CatalogListItem {
  return {
    countryId: row.id,
    sourceId: row.source_id,
    name: row.name,
    slug: row.slug,
    continent: row.parent_id,
    iso: [...new Set([...row.iso_alpha2, ...row.iso_other])],
    sourceSizeHintBytes: jsonIntegerOrNull(row.source_size_hint_bytes),
    cache: {
      cached: row.cache_country_id !== null,
      versionsReady: row.versions_ready_count ?? 0,
      totalSizeBytes: jsonInteger(row.total_size_bytes ?? '0'),
      isPublic: row.is_public ?? false,
      updateState: row.update_state ?? 'unknown',
      availableVersion: row.available_version,
      availableSizeBytes: jsonIntegerOrNull(row.available_size_bytes),
    },
    lastSyncedAt: row.catalog_synced_at.toISOString(),
  };
}

/** Converts a non-negative database int8 to a JSON number when safe, otherwise preserves its decimal text. */
function jsonInteger(value: string): number | string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('catalog byte count is not a non-negative decimal integer');
  }
  const exact = BigInt(value);
  return exact <= MAX_SAFE_JSON_INTEGER ? Number(exact) : exact.toString();
}

/** Converts a nullable database int8 without confusing an unknown size with zero. */
function jsonIntegerOrNull(value: string | null): number | string | null {
  return value === null ? null : jsonInteger(value);
}

/** Converts PostgreSQL's count text to the contract's safe JSON integer. */
function safeCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('catalog row count is not a non-negative decimal integer');
  }
  const count = BigInt(value);
  if (count > MAX_SAFE_JSON_INTEGER) {
    throw new RangeError('catalog row count exceeds the JSON safe integer range');
  }
  return Number(count);
}
