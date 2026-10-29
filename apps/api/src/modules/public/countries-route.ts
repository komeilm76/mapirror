/** Public country catalog, detail, and version history (`P3-API-03` and `P3-API-04`).
 *
 * @module modules/public/countries-route
 */

import {
  buildPageMeta,
  detailLicense,
  listLicense,
  parsePagination,
  PublicCountriesQuerySchema,
  PublicCountriesResponseSchema,
  PublicCountryDetailResponseSchema,
  PublicCountryParamsSchema,
  PublicCountryVersionsQuerySchema,
  PublicCountryVersionsResponseSchema,
  type PublicCountriesResponse,
  type PublicCountryDetailResponse,
  type PublicCountryVersionsResponse,
} from '@mapirror/shared';
import type { FastifyRequest } from 'fastify';

import {
  findPublicCountryBySlug,
  listPublicCountries,
  listPublicCountryVersions,
  type PublicVersionRow,
} from '../../db/repositories/public-catalog';
import { AppError } from '../../lib/errors';

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

/** Handles anonymous `GET /_public/api/countries/:slug` from one repeatable-read snapshot. */
export async function getPublicCountry(
  request: FastifyRequest<{ Params: { slug: string } }>,
): Promise<PublicCountryDetailResponse> {
  const slug = publicCountrySlug(request.params);
  const result = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const country = await findPublicCountryBySlug(trx, slug);
      if (country === null) throw publicCountryNotFound();
      const versions = await listPublicCountryVersions(trx, country.country_id, {
        limit: MAX_PUBLIC_PAGE_SIZE,
      });
      return { country, versions: versions.rows };
    });

  return PublicCountryDetailResponseSchema.parse({
    slug: result.country.slug,
    name: result.country.name,
    iso: [...new Set([...result.country.iso_alpha2, ...result.country.iso_other])],
    versions: result.versions.map((version) =>
      publicVersion(version, result.country.slug, result.country.newest_version),
    ),
    latest: result.country.newest_version,
    updatedAt: result.country.newest_data_timestamp?.toISOString() ?? null,
    license: detailLicense(),
  });
}

/** Handles paginated ready-version history for a published country. */
export async function getPublicCountryVersions(
  request: FastifyRequest<{ Params: { slug: string } }>,
): Promise<PublicCountryVersionsResponse> {
  const slug = publicCountrySlug(request.params);
  const parsed = PublicCountryVersionsQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;
  const pagination = parsePagination(parsed.data, { maxLimit: MAX_PUBLIC_PAGE_SIZE });
  const result = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const country = await findPublicCountryBySlug(trx, slug);
      if (country === null) throw publicCountryNotFound();
      const page = await listPublicCountryVersions(trx, country.country_id, {
        limit: pagination.limit,
        offset: pagination.offset,
      });
      return { country, page };
    });
  const total = safeCount(result.page.total);

  return PublicCountryVersionsResponseSchema.parse({
    data: result.page.rows.map((version) =>
      publicVersion(version, result.country.slug, result.country.newest_version),
    ),
    meta: buildPageMeta(pagination.page, pagination.limit, total),
    license: detailLicense(),
  });
}

/** Rejects malformed slugs as the same 404 as unknown or unpublished countries. */
function publicCountrySlug(params: unknown): string {
  const parsed = PublicCountryParamsSchema.safeParse(params);
  if (!parsed.success) throw publicCountryNotFound();
  return parsed.data.slug;
}

/** Keeps unknown and unpublished country responses indistinguishable. */
function publicCountryNotFound(): AppError {
  return new AppError('NOT_FOUND', 'The requested public country does not exist.');
}

/** Maps only documented public version fields and an encoded route to the exact version. */
function publicVersion(version: PublicVersionRow, slug: string, latest: string) {
  return {
    version: version.version,
    dataTimestamp: version.data_timestamp?.toISOString() ?? null,
    sizeBytes: jsonInteger(version.file_size_bytes),
    checksumMd5: md5OrNull(version.checksum_md5),
    downloadUrl: `/_public/api/countries/${slug}/download?version=${encodeURIComponent(version.version)}`,
    isLatest: version.version === latest,
  };
}

/** Converts an exact non-negative database int8 without risking JSON precision loss. */
function jsonInteger(value: string): number | string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('public catalog byte count is not a non-negative decimal integer');
  }
  const exact = BigInt(value);
  return exact <= MAX_SAFE_JSON_INTEGER ? Number(exact) : exact.toString();
}

/** Invalid or non-MD5 stored checksums are never presented as MD5 values. */
function md5OrNull(value: string | null): string | null {
  return value !== null && /^[a-f0-9]{32}$/u.test(value) ? value : null;
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
