/** Shared contracts for public country detail and version history (`P3-API-04`).
 *
 * @module public-country
 */

import { z } from 'zod';

import { JsonIntegerSchema } from './catalog';

/** Country slugs accepted by the public detail and version-history paths. */
export const PublicCountryParamsSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  })
  .strict();

/** Query accepted by `GET /_public/api/countries/:slug/versions`; pagination is clamped separately. */
export const PublicCountryVersionsQuerySchema = z
  .object({
    page: z.unknown().optional(),
    limit: z.unknown().optional(),
  })
  .strict();

/** Public-safe ready-version metadata. */
export const PublicCountryVersionSchema = z
  .object({
    version: z.string().min(1),
    dataTimestamp: z.iso.datetime().nullable(),
    sizeBytes: JsonIntegerSchema,
    checksumMd5: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .nullable(),
    downloadUrl: z.string().min(1),
    isLatest: z.boolean(),
  })
  .strict();

/** Detail attribution, including the Geofabrik source. */
export const PublicDetailLicenseSchema = z
  .object({
    name: z.string().min(1),
    attribution: z.string().min(1),
    url: z.url(),
    source: z.string().min(1),
    sourceUrl: z.url(),
  })
  .strict();

/** Successful `GET /_public/api/countries/:slug` response. */
export const PublicCountryDetailResponseSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    name: z.string().min(1),
    iso: z.array(z.string().min(1)),
    versions: z.array(PublicCountryVersionSchema).max(100),
    latest: z.string().min(1),
    updatedAt: z.iso.datetime().nullable(),
    license: PublicDetailLicenseSchema,
  })
  .strict();

/** Successful paginated `GET /_public/api/countries/:slug/versions` response. */
export const PublicCountryVersionsResponseSchema = z
  .object({
    data: z.array(PublicCountryVersionSchema),
    meta: z
      .object({
        page: z.int().min(1),
        limit: z.int().min(1).max(100),
        total: z.int().nonnegative(),
        totalPages: z.int().nonnegative(),
      })
      .strict(),
    license: PublicDetailLicenseSchema,
  })
  .strict();

/** Successful public country detail response. */
export type PublicCountryDetailResponse = z.infer<typeof PublicCountryDetailResponseSchema>;

/** Successful public country version-history response. */
export type PublicCountryVersionsResponse = z.infer<typeof PublicCountryVersionsResponseSchema>;
