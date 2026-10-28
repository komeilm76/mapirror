/** Shared request and response contracts for starting a Geofabrik cache download. */

import { z } from 'zod';

/** A Geofabrik moving-latest or dated-snapshot download request. */
export const CacheDownloadRequestSchema = z
  .object({
    countryId: z.string().uuid(),
    version: z
      .string()
      .trim()
      .regex(/^(?:latest|\d{6})$/u),
  })
  .strict();

/** A download accepted into the durable job queue. */
export const CacheDownloadResponseSchema = z
  .object({
    jobId: z.string().uuid(),
    resolvedVersion: z
      .string()
      .regex(/^\d{6}$/u)
      .nullable(),
  })
  .strict();

/** Input accepted by {@link CacheDownloadRequestSchema}. */
export type CacheDownloadRequest = z.infer<typeof CacheDownloadRequestSchema>;

/** Response returned by {@link CacheDownloadResponseSchema}. */
export type CacheDownloadResponse = z.infer<typeof CacheDownloadResponseSchema>;
