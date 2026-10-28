/** Admin cached-country listing and detail (`P2-API-05`).
 *
 * @module modules/admin/cache-route
 */

import {
  buildPageMeta,
  CacheDetailResponseSchema,
  CacheListResponseSchema,
  CacheQuerySchema,
  CacheCountryParamsSchema,
  parsePagination,
  type CacheDetailResponse,
  type CacheListResponse,
} from '@mapirror/shared';
import type { FastifyRequest } from 'fastify';

import {
  findCachedCountry,
  findMostRecentDownloads,
  listActiveCountryJobs,
  listCachedCountries,
} from '../../db/repositories/cache';
import { listCachedRegionVersions, type CatalogSort } from '../../db/repositories/catalog';
import { AppError } from '../../lib/errors';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** Handles `GET /_admin/api/cache`; rows, count and download timestamps share one DB snapshot. */
export async function getCacheList(request: FastifyRequest): Promise<CacheListResponse> {
  const parsed = CacheQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;

  const query = parsed.data;
  const pagination = parsePagination(query, {
    defaultLimit: DEFAULT_PAGE_SIZE,
    maxLimit: MAX_PAGE_SIZE,
  });
  const snapshot = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const page = await listCachedCountries(trx, {
        search: query.q,
        continent: query.continent,
        updateAvailable: query.update === 'available',
        page: pagination.page,
        limit: pagination.limit,
        sort: catalogSort(query.sort ?? 'name'),
        order: query.order ?? 'asc',
      });
      const mostRecentDownloads = await findMostRecentDownloads(
        trx,
        page.rows.map(({ id }) => id),
      );
      return { page, mostRecentDownloads };
    });

  const total = safeCount(snapshot.page.total);
  return CacheListResponseSchema.parse({
    data: snapshot.page.rows.map((row) => ({
      countryId: row.id,
      sourceId: row.source_id,
      name: row.name,
      slug: row.slug,
      continent: row.parent_id,
      iso: [...new Set([...row.iso_alpha2, ...row.iso_other])],
      sourceSizeHintBytes: jsonIntegerOrNull(row.source_size_hint_bytes),
      cache: {
        cached: true,
        versionsReady: row.versions_ready_count ?? 0,
        totalSizeBytes: jsonInteger(row.total_size_bytes ?? '0'),
        isPublic: row.is_public ?? false,
        updateState: row.update_state ?? 'unknown',
        availableVersion: row.available_version,
        availableSizeBytes: jsonIntegerOrNull(row.available_size_bytes),
      },
      lastSyncedAt: row.catalog_synced_at.toISOString(),
      lastCheckedAt: row.update_checked_at?.toISOString() ?? null,
      createdAt: requiredCacheDate(row.cache_created_at, 'created_at').toISOString(),
      mostRecentDownloadAt: snapshot.mostRecentDownloads.get(row.id)?.toISOString() ?? null,
    })),
    meta: buildPageMeta(pagination.page, pagination.limit, total),
  });
}

/** Handles `GET /_admin/api/cache/:countryId` from one repeatable-read database snapshot. */
export async function getCacheDetail(
  request: FastifyRequest<{ Params: { countryId: string } }>,
): Promise<CacheDetailResponse> {
  const params = CacheCountryParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;

  const result = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const country = await findCachedCountry(trx, params.data.countryId);
      if (country === null)
        throw new AppError('NOT_FOUND', 'The requested cached country does not exist.');
      const [versions, activeJobs] = await Promise.all([
        listCachedRegionVersions(trx, country.id),
        listActiveCountryJobs(trx, country.id),
      ]);
      return { country, versions, activeJobs };
    });

  return CacheDetailResponseSchema.parse({
    country: {
      countryId: result.country.id,
      name: result.country.name,
      slug: result.country.slug,
      sourceId: result.country.source_id,
      iso: [...new Set([...result.country.iso_alpha2, ...result.country.iso_other])],
    },
    cache: {
      isPublic: result.country.is_public ?? false,
      publicSince: result.country.public_since?.toISOString() ?? null,
      totalSizeBytes: jsonInteger(result.country.total_size_bytes ?? '0'),
      versionsReady: result.country.versions_ready_count ?? 0,
      updateState: result.country.update_state ?? 'unknown',
      availableVersion: result.country.available_version,
      availableSizeBytes: jsonIntegerOrNull(result.country.available_size_bytes),
      updateCheckedAt: result.country.update_checked_at?.toISOString() ?? null,
    },
    versions: result.versions.map((version) => ({
      id: version.id,
      version: version.version,
      origin: version.origin,
      dataTimestamp: version.data_timestamp?.toISOString() ?? null,
      sizeBytes: jsonInteger(version.file_size_bytes),
      checksumMd5: md5OrNull(version.checksum_md5),
      status: 'ready',
      createdAt: version.created_at.toISOString(),
    })),
    activeJobs: result.activeJobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      progressBytes: jsonInteger(job.progress_bytes),
      totalBytes: jsonIntegerOrNull(job.total_bytes),
    })),
  });
}

/** Maps public cache-list sort vocabulary to the shared repository's fixed sort keys. */
function catalogSort(sort: 'name' | 'size' | 'updated' | 'created'): CatalogSort {
  switch (sort) {
    case 'name':
      return 'name';
    case 'size':
      // In the cached-only table, size means the bytes stored locally, not the source extract hint used by the catalog.
      return 'totalSizeBytes';
    case 'updated':
      return 'lastSyncedAt';
    case 'created':
      return 'createdAt';
  }
}

/** Converts a non-negative database int8 without losing precision in JSON. */
function jsonInteger(value: string): number | string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('cache byte count is not a non-negative decimal integer');
  }
  const exact = BigInt(value);
  return exact <= MAX_SAFE_JSON_INTEGER ? Number(exact) : exact.toString();
}

/** Converts a nullable database int8 without confusing an unknown size with zero. */
function jsonIntegerOrNull(value: string | null): number | string | null {
  return value === null ? null : jsonInteger(value);
}

/** Converts PostgreSQL count text to a JSON integer. */
function safeCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('cache row count is not a non-negative decimal integer');
  }
  const count = BigInt(value);
  if (count > MAX_SAFE_JSON_INTEGER) {
    throw new RangeError('cache row count exceeds the JSON safe integer range');
  }
  return Number(count);
}

/** Rejects a broken cache/country invariant rather than fabricating a timestamp. */
function requiredCacheDate(value: Date | null, column: string): Date {
  if (value === null) throw new Error(`cached country is missing ${column}`);
  return value;
}

/** Invalid or non-MD5 stored checksums are never presented as MD5 values. */
function md5OrNull(value: string | null): string | null {
  return value !== null && /^[a-f0-9]{32}$/u.test(value) ? value : null;
}
