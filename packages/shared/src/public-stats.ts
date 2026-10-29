/** Strict contract for anonymous public catalogue statistics (`P3-API-06`).
 *
 * @module public-stats
 */

import { z } from 'zod';

import { JsonIntegerSchema } from './catalog';

/** The stats endpoint has no supported query parameters. */
export const PublicStatsQuerySchema = z.object({}).strict();

/** Successful `GET /_public/api/stats` response; it intentionally carries no event or client identifiers. */
export const PublicStatsResponseSchema = z
  .object({
    countries: JsonIntegerSchema,
    totalSizeBytes: JsonIntegerSchema,
    downloads30d: JsonIntegerSchema,
    totalDownloads: JsonIntegerSchema,
    lastPublishedAt: z.iso.datetime().nullable(),
  })
  .strict();

/** Public aggregate statistics response. */
export type PublicStatsResponse = z.infer<typeof PublicStatsResponseSchema>;
