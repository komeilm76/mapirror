/**
 * Shared contracts for the admin catalog endpoint (`P2-API-01`).
 *
 * @module catalog
 */

import { z } from 'zod';

import { SORT_FIELDS, SORT_ORDERS, UPDATE_STATES } from './constants';

/** A PostgreSQL bigint encoded without losing precision in JSON. */
export const JsonIntegerSchema = z.union([
  z.int().nonnegative(),
  z.string().regex(/^(?:0|[1-9]\d*)$/u),
]);

/** Query values accepted by `GET /_admin/api/catalog`. Pagination values are normalized and clamped separately. */
export const CatalogQuerySchema = z
  .object({
    /** Case-insensitive partial match against region names and ISO codes. */
    q: z.string().trim().max(128).optional(),
    /** Upstream parent id, e.g. `europe`. */
    continent: z.string().trim().min(1).max(255).optional(),
    /** Cache-row presence filter. */
    cache: z.enum(['all', 'uncached', 'cached']).optional(),
    /** Whether to restrict results to a known upstream update. */
    update: z.enum(['any', 'available']).optional(),
    /** Shared pagination parser applies the decimal-only and clamping rules. */
    page: z.unknown().optional(),
    /** Shared pagination parser applies the decimal-only and clamping rules. */
    limit: z.unknown().optional(),
    /** Public sort key, mapped to a fixed database column by the route. */
    sort: z.enum(SORT_FIELDS).optional(),
    /** Sort direction. */
    order: z.enum(SORT_ORDERS).optional(),
  })
  .strict();

/** Query contract for `GET /_admin/api/catalog`. */
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;

/** One catalog row in the admin-list response. */
export const CatalogListItemSchema = z
  .object({
    countryId: z.uuid(),
    sourceId: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    continent: z.string().nullable(),
    iso: z.array(z.string().min(1)),
    sourceSizeHintBytes: JsonIntegerSchema.nullable(),
    cache: z
      .object({
        cached: z.boolean(),
        versionsReady: z.int().nonnegative(),
        totalSizeBytes: JsonIntegerSchema,
        isPublic: z.boolean(),
        updateState: z.enum(UPDATE_STATES),
        availableVersion: z.string().nullable(),
        availableSizeBytes: JsonIntegerSchema.nullable(),
      })
      .strict(),
    lastSyncedAt: z.iso.datetime(),
  })
  .strict();

/** One catalog row in the admin-list response. */
export type CatalogListItem = z.infer<typeof CatalogListItemSchema>;

/** Successful `GET /_admin/api/catalog` response. */
export const CatalogListResponseSchema = z
  .object({
    data: z.array(CatalogListItemSchema),
    meta: z
      .object({
        page: z.int().min(1),
        limit: z.int().min(1).max(100),
        total: z.int().nonnegative(),
        totalPages: z.int().nonnegative(),
      })
      .strict(),
    catalogSyncedAt: z.iso.datetime().nullable(),
  })
  .strict();

/** Successful `GET /_admin/api/catalog` response. */
export type CatalogListResponse = z.infer<typeof CatalogListResponseSchema>;
