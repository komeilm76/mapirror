/** Paginated admin list of stored cache versions (`P2-API-07`).
 *
 * @module modules/admin/cache-versions-route
 */

import {
  buildPageMeta,
  CacheCountryParamsSchema,
  CacheVersionListQuerySchema,
  CacheVersionListResponseSchema,
  parsePagination,
  type CacheVersionListResponse,
} from '@mapirror/shared';
import type { FastifyRequest } from 'fastify';

import { findCachedCountry } from '../../db/repositories/cache';
import { listMapVersionsPage } from '../../db/repositories/map-versions';
import { AppError } from '../../lib/errors';

const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_VERSION_PAGE_SIZE = 25;
const MAX_VERSION_PAGE_SIZE = 100;

/** Returns a cached country's versions and metadata from one repeatable-read database snapshot. */
export async function getCacheVersions(
  request: FastifyRequest<{ Params: { countryId: string } }>,
): Promise<CacheVersionListResponse> {
  const params = CacheCountryParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;
  const parsedQuery = CacheVersionListQuerySchema.safeParse(request.query);
  if (!parsedQuery.success) throw parsedQuery.error;
  const pagination = parsePagination(parsedQuery.data, {
    defaultLimit: DEFAULT_VERSION_PAGE_SIZE,
    maxLimit: MAX_VERSION_PAGE_SIZE,
  });

  const page = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const country = await findCachedCountry(trx, params.data.countryId);
      if (country === null) {
        throw new AppError('NOT_FOUND', 'The requested cached country does not exist.');
      }
      return listMapVersionsPage(trx, country.id, pagination.limit, pagination.offset);
    });

  const total = safeCount(page.total);
  return CacheVersionListResponseSchema.parse({
    data: page.rows.map((row) => ({
      id: row.id,
      version: row.version,
      origin: row.origin,
      dataTimestamp: row.data_timestamp?.toISOString() ?? null,
      sizeBytes: jsonInteger(row.file_size_bytes),
      checksumMd5: md5OrNull(row.checksum_md5),
      status: row.status,
      createdAt: row.created_at.toISOString(),
    })),
    meta: buildPageMeta(pagination.page, pagination.limit, total),
  });
}

/** Converts a non-negative database int8 without losing precision in JSON. */
function jsonInteger(value: string): number | string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('map version byte count is not a non-negative decimal integer');
  }
  const exact = BigInt(value);
  return exact <= MAX_SAFE_JSON_INTEGER ? Number(exact) : exact.toString();
}

/** Converts PostgreSQL count text to a JSON integer. */
function safeCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('map version count is not a non-negative decimal integer');
  }
  const count = BigInt(value);
  if (count > MAX_SAFE_JSON_INTEGER) {
    throw new RangeError('map version count exceeds the JSON safe integer range');
  }
  return Number(count);
}

/** Invalid or non-MD5 stored checksums are never presented as MD5 values. */
function md5OrNull(value: string | null): string | null {
  return value !== null && /^[a-f0-9]{32}$/u.test(value) ? value : null;
}
