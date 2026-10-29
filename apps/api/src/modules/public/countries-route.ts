/** Public country catalog (`P3-API-03`).
 *
 * @module modules/public/countries-route
 */

import {
  buildPageMeta,
  listLicense,
  parsePagination,
  PublicCountriesQuerySchema,
  PublicCountriesResponseSchema,
  type PublicCountriesResponse,
} from '@mapirror/shared';
import type { FastifyRequest } from 'fastify';

import { listPublicCountries } from '../../db/repositories/public-catalog';

const MAX_PUBLIC_PAGE_SIZE = 100;
const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** Handles anonymous `GET /_public/api/countries` from one repeatable-read snapshot. */
export async function getPublicCountries(
  request: FastifyRequest,
): Promise<PublicCountriesResponse> {
  const parsed = PublicCountriesQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;

  const query = parsed.data;
  const pagination = parsePagination(query, {
    maxLimit: MAX_PUBLIC_PAGE_SIZE,
  });
  const page = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute((trx) =>
      listPublicCountries(trx, {
        search: query.q,
        continent: query.continent,
        sort: query.sort ?? 'name',
        limit: pagination.limit,
        offset: pagination.offset,
      }),
    );
  const total = safeCount(page.total);

  return PublicCountriesResponseSchema.parse({
    data: page.rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      continent: row.continent,
      iso: [...new Set([...row.iso_alpha2, ...row.iso_other])],
      newestVersion: row.newest_version,
      sizeBytes: jsonInteger(row.newest_size_bytes),
      updatedAt: row.newest_data_timestamp?.toISOString() ?? null,
      downloadUrl: `/_public/api/countries/${row.slug}/download?version=latest`,
    })),
    meta: buildPageMeta(pagination.page, pagination.limit, total),
    license: listLicense(),
  });
}

/** Converts an exact non-negative database int8 without risking JSON precision loss. */
function jsonInteger(value: string): number | string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('public catalog byte count is not a non-negative decimal integer');
  }
  const exact = BigInt(value);
  return exact <= MAX_SAFE_JSON_INTEGER ? Number(exact) : exact.toString();
}

/** Converts PostgreSQL's count text to the response's safe JSON integer. */
function safeCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('public catalog row count is not a non-negative decimal integer');
  }
  const count = BigInt(value);
  if (count > MAX_SAFE_JSON_INTEGER) {
    throw new RangeError('public catalog row count exceeds the JSON safe integer range');
  }
  return Number(count);
}
