/** Shared contracts for catalog region details and source snapshots (`P2-API-03`).
 *
 * @module catalog-region
 */

import { z } from 'zod';

import { JsonIntegerSchema } from './catalog';

/** URL-safe local catalog identity accepted by region routes. */
export const CatalogRegionParamsSchema = z
  .object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u) })
  .strict();

/** One cached, ready map version. */
export const CachedRegionVersionSchema = z
  .object({
    id: z.uuid(),
    version: z.string().min(1),
    origin: z.enum(['geofabrik_snapshot', 'geofabrik_latest', 'upload']),
    dataTimestamp: z.iso.datetime().nullable(),
    sizeBytes: JsonIntegerSchema,
    checksumMd5: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

/** Region identity used to construct a breadcrumb and choose a source extract. */
export const CatalogRegionIdentitySchema = z
  .object({
    countryId: z.uuid(),
    sourceId: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    name: z.string().min(1),
    parentChain: z.array(
      z
        .object({
          sourceId: z.string().min(1),
          slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
          name: z.string().min(1),
        })
        .strict(),
    ),
    iso: z.array(z.string().min(1)),
    pbfUrl: z.url({ protocol: /^https?$/ }).nullable(),
    sizeHintBytes: JsonIntegerSchema.nullable(),
  })
  .strict();

/** Latest source facts that can be read from the region page. */
export const CatalogRegionSourceSchema = z
  .object({
    version: z.string().min(1).nullable(),
    sizeBytes: JsonIntegerSchema.nullable(),
    dataTimestamp: z.iso.datetime().nullable(),
  })
  .strict();

/** Successful `GET /_admin/api/catalog/regions/:slug` response. */
export const CatalogRegionDetailResponseSchema = z
  .object({
    country: CatalogRegionIdentitySchema,
    source: CatalogRegionSourceSchema,
    sourceReachable: z.boolean(),
    cachedVersions: z.array(CachedRegionVersionSchema),
  })
  .strict();

/** Successful `GET /_admin/api/catalog/regions/:slug/snapshots` row. */
export const CatalogRegionSnapshotSchema = z
  .object({
    version: z.string().min(1),
    dataTimestamp: z.iso.datetime().nullable(),
    sizeBytes: JsonIntegerSchema.nullable(),
    checksumMd5: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .nullable(),
    cached: z.boolean(),
  })
  .strict();

/** Summary of the newest currently offered source snapshot. */
export const CatalogRegionLatestSnapshotSchema = z
  .object({ version: z.string().min(1), sizeBytes: JsonIntegerSchema.nullable() })
  .strict();

/** Successful `GET /_admin/api/catalog/regions/:slug/snapshots` response. */
export const CatalogRegionSnapshotsResponseSchema = z
  .object({
    data: z.array(CatalogRegionSnapshotSchema),
    latest: CatalogRegionLatestSnapshotSchema.nullable(),
    fetchedAt: z.iso.datetime(),
    sourceReachable: z.boolean(),
  })
  .strict();

export type CatalogRegionDetailResponse = z.infer<typeof CatalogRegionDetailResponseSchema>;
export type CatalogRegionSnapshotsResponse = z.infer<typeof CatalogRegionSnapshotsResponseSchema>;
