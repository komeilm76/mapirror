/** Strict query contract for the public cached-file download (`P3-API-05`).
 *
 * @module public-download
 */

import { z } from 'zod';

/** Query accepted by `GET /_public/api/countries/:slug/download`. */
export const PublicCountryDownloadQuerySchema = z
  .object({
    version: z
      .string()
      .regex(/^(?:latest|[A-Za-z0-9][A-Za-z0-9._@+-]{0,63})$/u)
      .optional(),
  })
  .strict();

/** Validated query for the public country download route. */
export type PublicCountryDownloadQuery = z.infer<typeof PublicCountryDownloadQuerySchema>;
