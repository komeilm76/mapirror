/** Shared contracts for public catalog reads (`P3-API-03`).
 *
 * @module public-catalog
 */

import { z } from 'zod';

import { JsonIntegerSchema } from './catalog';

/** Query accepted by `GET /_public/api/countries`; page and limit are normalized by shared pagination rules. */
export const PublicCountriesQuerySchema = z
  .object({
    /** Trimmed partial match against names and ISO codes. */
    q: z.string().trim().max(128).optional(),
    /** Exact source parent id, such as `europe`. */
    continent: z.string().trim().min(1).max(255).optional(),
    /** Decimal pagination values are clamped by `parsePagination`. */
    page: z.unknown().optional(),
    limit: z.unknown().optional(),
    /** Fixed public sort vocabulary; direction is defined by the endpoint contract. */
    sort: z.enum(['name', 'size', 'updated']).optional(),
  })
  .strict();

/** One country in the public catalog. Internal identifiers and storage details are intentionally absent. */
export const PublicCountryListItemSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    name: z.string().min(1),
    continent: z.string().nullable(),
    iso: z.array(z.string().min(1)),
    newestVersion: z.string().min(1),
    sizeBytes: JsonIntegerSchema,
    updatedAt: z.iso.datetime().nullable(),
    downloadUrl: z.string().min(1),
  })
  .strict();

/** ODbL list attribution returned by public list endpoints. */
export const PublicListLicenseSchema = z
  .object({
    name: z.string().min(1),
    attribution: z.string().min(1),
    url: z.url(),
  })
  .strict();

/** Successful `GET /_public/api/countries` response. */
export const PublicCountriesResponseSchema = z
  .object({
    data: z.array(PublicCountryListItemSchema),
    meta: z
      .object({
        page: z.int().min(1),
        limit: z.int().min(1).max(100),
        total: z.int().nonnegative(),
        totalPages: z.int().nonnegative(),
      })
      .strict(),
    license: PublicListLicenseSchema,
  })
  .strict();

/** Public-catalog request query type. */
export type PublicCountriesQuery = z.infer<typeof PublicCountriesQuerySchema>;

/** One public catalog item. */
export type PublicCountryListItem = z.infer<typeof PublicCountryListItemSchema>;

/** Successful public-catalog response. */
export type PublicCountriesResponse = z.infer<typeof PublicCountriesResponseSchema>;
