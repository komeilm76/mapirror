/**
 * Shared contracts for the admin cache list and detail endpoints (`P2-API-05`).
 *
 * @module cache
 */

import { z } from 'zod';

import { CatalogListItemSchema, CatalogQuerySchema, JsonIntegerSchema } from './catalog';
import { UPDATE_STATES } from './constants';

/** Cache listing uses catalog filters and pagination, but cache presence is always `cached`. */
export const CacheQuerySchema = CatalogQuerySchema.omit({ cache: true });

/** Cached catalog row with cache-specific timestamps. */
export const CacheListItemSchema = CatalogListItemSchema.extend({
  lastCheckedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  mostRecentDownloadAt: z.iso.datetime().nullable(),
}).strict();

/** Successful `GET /_admin/api/cache` response. */
export const CacheListResponseSchema = z
  .object({
    data: z.array(CacheListItemSchema),
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

/** Cache country identity returned by the detail endpoint. */
export const CacheCountryIdentitySchema = z
  .object({
    countryId: z.uuid(),
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    sourceId: z.string().min(1),
    iso: z.array(z.string().min(1)),
  })
  .strict();

/** Cache summary and latest upstream update state. */
export const CacheSummarySchema = z
  .object({
    isPublic: z.boolean(),
    publicSince: z.iso.datetime().nullable(),
    totalSizeBytes: JsonIntegerSchema,
    versionsReady: z.int().nonnegative(),
    updateState: z.enum(UPDATE_STATES),
    availableVersion: z.string().nullable(),
    availableSizeBytes: JsonIntegerSchema.nullable(),
    updateCheckedAt: z.iso.datetime().nullable(),
  })
  .strict();

/** A ready version in a cache-country detail response. */
export const CacheDetailVersionSchema = z
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
    status: z.literal('ready'),
    createdAt: z.iso.datetime(),
  })
  .strict();

/** One queued or running job associated with a cached country. */
export const CacheActiveJobSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(['download', 'import', 'update_check', 'catalog_sync', 'prune']),
    status: z.enum(['queued', 'running']),
    progressBytes: JsonIntegerSchema,
    totalBytes: JsonIntegerSchema.nullable(),
  })
  .strict();

/** Params accepted by `GET` and `DELETE /_admin/api/cache/:countryId`. */
export const CacheCountryParamsSchema = z.object({ countryId: z.uuid() }).strict();

/** Query accepted by `DELETE /_admin/api/cache/:countryId`. */
export const CacheCountryDeleteQuerySchema = z
  .object({
    confirm: z.string().max(64).optional(),
    cancelJobs: z.enum(['true', 'false']).optional(),
  })
  .strict();

/** Optional JSON-body confirmation for `DELETE /_admin/api/cache/:countryId`. */
export const CacheCountryDeleteBodySchema = z
  .object({ confirm: z.string().max(64).optional() })
  .strict();

/** Successful `GET /_admin/api/cache/:countryId` response. */
export const CacheDetailResponseSchema = z
  .object({
    country: CacheCountryIdentitySchema,
    cache: CacheSummarySchema,
    versions: z.array(CacheDetailVersionSchema),
    activeJobs: z.array(CacheActiveJobSchema),
  })
  .strict();

export type CacheQuery = z.infer<typeof CacheQuerySchema>;
export type CacheListItem = z.infer<typeof CacheListItemSchema>;
export type CacheListResponse = z.infer<typeof CacheListResponseSchema>;
export type CacheDetailResponse = z.infer<typeof CacheDetailResponseSchema>;
export type CacheCountryDeleteQuery = z.infer<typeof CacheCountryDeleteQuerySchema>;
export type CacheCountryDeleteBody = z.infer<typeof CacheCountryDeleteBodySchema>;
