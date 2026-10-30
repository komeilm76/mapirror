/** Shared upload request and response contracts for administrator map imports. */

import { z } from 'zod';

import { JsonIntegerSchema } from './catalog';
import { JobErrorSchema } from './jobs';

/** Version labels accepted for user-supplied imports. */
export const ImportVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u);

/** Multipart text fields. Multipart booleans arrive as their literal strings, not JSON booleans. */
export const ImportMultipartFieldsSchema = z
  .object({
    countryId: z.uuid(),
    version: ImportVersionSchema,
    replace: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

/** A validated upload accepted into the durable job queue. */
export const ImportResponseSchema = z
  .object({
    uploadId: z.uuid(),
    jobId: z.uuid(),
    version: ImportVersionSchema,
  })
  .strict();

/** Path contract for `GET /_admin/api/imports/:uploadId`. */
export const ImportStatusParamsSchema = z.object({ uploadId: z.uuid() }).strict();

/** Safe status projection for a staged import and its durable job. */
export const ImportStatusResponseSchema = z
  .object({
    status: z.enum(['received', 'installing', 'installed', 'failed', 'expired']),
    sizeBytes: JsonIntegerSchema,
    checksumMd5: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .nullable(),
    jobId: z.uuid(),
    error: JobErrorSchema.nullable(),
  })
  .strict();

/** Multipart metadata after validation. */
export type ImportMultipartFields = z.infer<typeof ImportMultipartFieldsSchema>;
/** Response returned by a successfully accepted import. */
export type ImportResponse = z.infer<typeof ImportResponseSchema>;
/** Status returned by the protected import-session detail route. */
export type ImportStatusResponse = z.infer<typeof ImportStatusResponseSchema>;
