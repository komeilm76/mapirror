/** Admin catalog region detail and source snapshot endpoints (`P2-API-03`).
 *
 * @module modules/admin/catalog-region-route
 */

import {
  CatalogRegionDetailResponseSchema,
  CatalogRegionParamsSchema,
  CatalogRegionSnapshotsResponseSchema,
  type CatalogRegionDetailResponse,
  type CatalogRegionSnapshotsResponse,
} from '@mapirror/shared';
import type { FastifyRequest } from 'fastify';

import {
  findCountryBySlug,
  findCountryParentChain,
  listCachedRegionVersions,
} from '../../db/repositories/catalog';
import { AppError } from '../../lib/errors';
import type { MapSource, SourceRegionDetail, SourceSnapshot } from '../geofabrik/source';

const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** Binds the source client to both catalog region handlers. */
export function createCatalogRegionHandlers(
  source: Pick<MapSource, 'getRegionDetail' | 'listSnapshots'>,
) {
  return {
    /** GET /catalog/regions/:slug: read local identity/cache, then enrich it from the current source page. */
    getRegion: async (
      request: FastifyRequest<{ Params: { slug: string } }>,
    ): Promise<CatalogRegionDetailResponse> => {
      const { slug } = parseSlug(request.params);
      const database = request.server.db.db;
      const local = await database
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          const country = await findCountryBySlug(trx, slug);
          if (country === null) throw regionNotFound();
          const [parentChain, versions] = await Promise.all([
            findCountryParentChain(trx, country.id),
            listCachedRegionVersions(trx, country.id),
          ]);
          return { country, parentChain, versions };
        });

      let details: SourceRegionDetail | null = null;
      try {
        details = await source.getRegionDetail(local.country.source_id);
      } catch (error) {
        request.log.warn({ err: error, slug }, 'Geofabrik region page is unavailable');
      }

      return CatalogRegionDetailResponseSchema.parse({
        country: {
          countryId: local.country.id,
          sourceId: local.country.source_id,
          slug: local.country.slug,
          name: local.country.name,
          parentChain: local.parentChain.map(({ source_id, slug: parentSlug, name }) => ({
            sourceId: source_id,
            slug: parentSlug,
            name,
          })),
          iso: [...new Set([...local.country.iso_alpha2, ...local.country.iso_other])],
          pbfUrl: local.country.source_pbf_url,
          sizeHintBytes: jsonIntegerOrNull(local.country.source_size_hint_bytes),
        },
        source: toSourceDetail(details),
        sourceReachable: details !== null,
        cachedVersions: local.versions.map(toCachedVersion),
      });
    },

    /** GET /catalog/regions/:slug/snapshots: current source offers, with ready local source versions as outage fallback. */
    getSnapshots: async (
      request: FastifyRequest<{ Params: { slug: string } }>,
    ): Promise<CatalogRegionSnapshotsResponse> => {
      const { slug } = parseSlug(request.params);
      const local = await request.server.db.db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          const country = await findCountryBySlug(trx, slug);
          if (country === null) throw regionNotFound();
          return {
            country,
            versions: await listCachedRegionVersions(trx, country.id),
          };
        });

      let snapshots: SourceSnapshot[] | null = null;
      try {
        snapshots = await source.listSnapshots(local.country.source_id);
      } catch (error) {
        request.log.warn({ err: error, slug }, 'Geofabrik snapshots are unavailable');
      }

      const sourceReachable = snapshots !== null;
      const data =
        snapshots === null
          ? local.versions
              .filter((version) => version.origin !== 'upload')
              .map((version) => ({
                version: version.version,
                dataTimestamp: version.data_timestamp?.toISOString() ?? null,
                sizeBytes: jsonInteger(version.file_size_bytes),
                checksumMd5: md5OrNull(version.checksum_md5),
                cached: true,
              }))
          : snapshots.map((snapshot) => {
              const cachedVersion = local.versions.find(
                (version) => version.origin !== 'upload' && version.version === snapshot.version,
              );
              return {
                version: snapshot.version,
                dataTimestamp: snapshot.dataTimestamp?.toISOString() ?? null,
                sizeBytes: snapshot.sizeBytes,
                checksumMd5:
                  md5OrNull(snapshot.checksumMd5) ?? md5OrNull(cachedVersion?.checksum_md5 ?? null),
                cached: cachedVersion !== undefined,
              };
            });
      const latest =
        snapshots === null || snapshots[0] === undefined
          ? null
          : {
              version: snapshots[0].version,
              sizeBytes: snapshots[0].sizeBytes,
            };

      return CatalogRegionSnapshotsResponseSchema.parse({
        data,
        latest,
        fetchedAt: new Date().toISOString(),
        sourceReachable,
      });
    },
  };
}

/** Parses the path identity explicitly so malformed parameters use the shared validation envelope. */
function parseSlug(params: unknown): { slug: string } {
  const result = CatalogRegionParamsSchema.safeParse(params);
  if (!result.success) throw result.error;
  return result.data;
}

/** Converts a source detail's dates for the JSON contract, or returns the unavailable shape. */
function toSourceDetail(details: SourceRegionDetail | null) {
  return {
    version: details?.version ?? null,
    sizeBytes: details?.sizeBytes ?? null,
    dataTimestamp: details?.dataTimestamp?.toISOString() ?? null,
  };
}

/** Projects a ready persisted version into the shared API shape. */
function toCachedVersion(version: Awaited<ReturnType<typeof listCachedRegionVersions>>[number]) {
  return {
    id: version.id,
    version: version.version,
    origin: version.origin,
    dataTimestamp: version.data_timestamp?.toISOString() ?? null,
    sizeBytes: jsonInteger(version.file_size_bytes),
    checksumMd5: md5OrNull(version.checksum_md5),
    createdAt: version.created_at.toISOString(),
  };
}

/** Normalizes a valid MD5 digest and drops malformed persisted/upstream values rather than breaking the whole response. */
function md5OrNull(value: string | null): string | null {
  return value !== null && /^[a-f\d]{32}$/iu.test(value) ? value.toLowerCase() : null;
}

/** Converts PostgreSQL's non-negative int8 text without losing precision in JSON. */
function jsonInteger(value: string): number | string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('catalog byte count is not a non-negative decimal integer');
  }
  const exact = BigInt(value);
  return exact <= MAX_SAFE_JSON_INTEGER ? Number(exact) : exact.toString();
}

/** Converts a nullable int8 without confusing an unknown size with zero. */
function jsonIntegerOrNull(value: string | null): number | string | null {
  return value === null ? null : jsonInteger(value);
}

/** The missing region is a client-visible 404, not an upstream outage. */
function regionNotFound(): AppError {
  return new AppError('NOT_FOUND', 'The requested catalog region does not exist.');
}
