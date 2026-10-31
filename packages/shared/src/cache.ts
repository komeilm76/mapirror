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

/** Params accepted by `GET`, `DELETE` and `POST /_admin/api/cache/:countryId/*`. */
export const CacheCountryParamsSchema = z.object({ countryId: z.uuid() }).strict();

/** Body accepted by `POST /_admin/api/cache/:countryId/check-update`. */
export const CacheUpdateCheckRequestSchema = z.object({}).strict();

/** One source identity included in a single-country update-check response. */
export const CacheUpdateCheckIdentitySchema = z
  .object({
    version: z.string().min(1).nullable(),
    dataTimestamp: z.iso.datetime().nullable(),
    sizeBytes: JsonIntegerSchema.nullable(),
  })
  .strict();

/** Result of an inline check; an unavailable source is represented as `unknown`, never as current. */
export const CacheUpdateCheckResponseSchema = z
  .object({
    state: z.enum(UPDATE_STATES),
    cached: CacheUpdateCheckIdentitySchema,
    source: CacheUpdateCheckIdentitySchema.nullable(),
    checkedAt: z.iso.datetime(),
    reason: z.string().min(1).nullable(),
  })
  .strict();

/** Body accepted by `POST /_admin/api/cache/check-updates`. */
export const CacheBulkUpdateCheckRequestSchema = z
  .object({
    countryIds: z
      .array(z.uuid())
      .min(1)
      .max(10_000)
      .refine((ids) => new Set(ids).size === ids.length, 'Country ids must be unique')
      .optional(),
  })
  .strict();

/** Successful asynchronous bulk update-check response. */
export const CacheBulkUpdateCheckResponseSchema = z.object({ jobId: z.uuid() }).strict();

export type CacheUpdateCheckRequest = z.infer<typeof CacheUpdateCheckRequestSchema>;
export type CacheUpdateCheckResponse = z.infer<typeof CacheUpdateCheckResponseSchema>;
export type CacheBulkUpdateCheckRequest = z.infer<typeof CacheBulkUpdateCheckRequestSchema>;
export type CacheBulkUpdateCheckResponse = z.infer<typeof CacheBulkUpdateCheckResponseSchema>;

/** Body accepted by `POST /_admin/api/cache/:countryId/public`. */
export const CachePublicToggleBodySchema = z.object({ isPublic: z.boolean() }).strict();

/** Successful `POST /_admin/api/cache/:countryId/public` response. */
export const CachePublicToggleResponseSchema = z
  .object({
    isPublic: z.boolean(),
    publicSince: z.iso.datetime().nullable(),
  })
  .strict();

/** Request body for toggling one cached country's public visibility. */
export type CachePublicToggleBody = z.infer<typeof CachePublicToggleBodySchema>;

/** Successful public-visibility toggle response. */
export type CachePublicToggleResponse = z.infer<typeof CachePublicToggleResponseSchema>;

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
