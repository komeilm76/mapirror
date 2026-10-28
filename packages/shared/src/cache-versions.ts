/** Contracts for cached map-version listing and pinned Geofabrik downloads (`P2-API-07`).
 *
 * @module cache-versions
 */

import { z } from 'zod';

import { JsonIntegerSchema } from './catalog';

/** Query contract for `GET /_admin/api/cache/:countryId/versions`. */
export const CacheVersionListQuerySchema = z
  .object({
    /** Shared pagination parser applies the decimal-only and clamping rules. */
    page: z.unknown().optional(),
    /** Shared pagination parser applies the decimal-only and clamping rules. */
    limit: z.unknown().optional(),
  })
  .strict();

/** Query contract for the admin map-version list. */
export type CacheVersionListQuery = z.infer<typeof CacheVersionListQuerySchema>;

/** One stored snapshot version in the paginated version list. */
export const CacheVersionListItemSchema = z
  .object({
    id: z.uuid(),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/u),
    origin: z.enum(['geofabrik_snapshot', 'geofabrik_latest', 'upload']),
    dataTimestamp: z.iso.datetime().nullable(),
    sizeBytes: JsonIntegerSchema,
    checksumMd5: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .nullable(),
    status: z.enum(['pending', 'ready', 'failed']),
    createdAt: z.iso.datetime(),
  })
  .strict();

/** One stored snapshot version in the paginated version list. */
export type CacheVersionListItem = z.infer<typeof CacheVersionListItemSchema>;

/** Successful paginated `GET /_admin/api/cache/:countryId/versions` response. */
export const CacheVersionListResponseSchema = z
  .object({
    data: z.array(CacheVersionListItemSchema),
    meta: z
      .object({
        page: z.int().min(1),
        limit: z.int().min(1).max(100),
        total: z.int().nonnegative(),
        totalPages: z.int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/** Successful paginated admin version-list response. */
export type CacheVersionListResponse = z.infer<typeof CacheVersionListResponseSchema>;

/** Request contract for a single offered, dated Geofabrik snapshot. `latest` is deliberately invalid here. */
export const CacheSpecificVersionRequestSchema = z
  .object({
    version: z
      .string()
      .trim()
      .regex(/^\d{6}$/u),
  })
  .strict();

/** Request contract for a pinned Geofabrik snapshot download. */
export type CacheSpecificVersionRequest = z.infer<typeof CacheSpecificVersionRequestSchema>;

/** Accepted pinned-version download response. */
export const CacheSpecificVersionResponseSchema = z.object({ jobId: z.uuid() }).strict();

/** Accepted pinned-version download response. */
export type CacheSpecificVersionResponse = z.infer<typeof CacheSpecificVersionResponseSchema>;

/** Path contract for `DELETE /_admin/api/cache/:countryId/versions/:versionId`. */
export const CacheVersionDeleteParamsSchema = z
  .object({ countryId: z.uuid(), versionId: z.uuid() })
  .strict();

/** Path contract for a specific cached-version delete. */
export type CacheVersionDeleteParams = z.infer<typeof CacheVersionDeleteParamsSchema>;

/** Query contract for explicit version-delete confirmation. */
export const CacheVersionDeleteQuerySchema = z
  .object({ confirm: z.enum(['true', 'false']).optional() })
  .strict();

/** Query contract for explicit version-delete confirmation. */
export type CacheVersionDeleteQuery = z.infer<typeof CacheVersionDeleteQuerySchema>;

/** Optional JSON-body form of the explicit version-delete confirmation. */
export const CacheVersionDeleteBodySchema = z.object({ confirm: z.boolean().optional() }).strict();

/** Optional JSON-body form of explicit version-delete confirmation. */
export type CacheVersionDeleteBody = z.infer<typeof CacheVersionDeleteBodySchema>;
