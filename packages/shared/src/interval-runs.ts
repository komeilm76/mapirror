/** Shared API contracts for manual interval runs, history, and country-level outcomes (`P4-INT-05`).
 *
 * @module interval-runs
 */

import { z } from 'zod';

import { JsonIntegerSchema } from './catalog';

/** Path parameters for interval run operations. */
export const IntervalRunParamsSchema = z.object({ id: z.uuid() }).strict();

/** Path parameter for a durable run detail. */
export const IntervalRunDetailParamsSchema = z.object({ runId: z.uuid() }).strict();

/** Run history query; pagination values are normalized according to the shared pagination contract. */
export const IntervalRunListQuerySchema = z
  .object({ page: z.unknown().optional(), limit: z.unknown().optional() })
  .strict();

/** Manual run accepts an empty body only. */
export const IntervalRunNowBodySchema = z.object({}).strict();

/** Acknowledgement returned after a manual run and all country jobs are enqueued atomically. */
export const IntervalRunNowResponseSchema = z
  .object({ runId: z.uuid(), jobIds: z.array(z.uuid()) })
  .strict();

/** Durable run summary included in history and run detail. */
export const IntervalRunViewSchema = z
  .object({
    id: z.uuid(),
    intervalId: z.uuid(),
    intervalName: z.string().min(1),
    triggeredBy: z.enum(['schedule', 'manual']),
    status: z.enum(['running', 'succeeded', 'partial', 'failed']),
    countriesTotal: z.int().nonnegative(),
    countriesOk: z.int().nonnegative(),
    countriesFailed: z.int().nonnegative(),
    countriesSkipped: z.int().nonnegative(),
    bytesDownloaded: JsonIntegerSchema,
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    durationMs: z.int().nonnegative(),
    errorMessage: z.string().nullable(),
  })
  .strict();

/** Snapshot of one country's outcome within a durable run. */
export const IntervalRunItemViewSchema = z
  .object({
    id: z.uuid(),
    countryId: z.uuid().nullable(),
    countrySlug: z.string().min(1),
    countryName: z.string().min(1),
    jobId: z.uuid().nullable(),
    status: z.enum(['queued', 'skipped', 'downloaded', 'failed']),
    version: z.string().nullable(),
    bytes: JsonIntegerSchema,
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .strict();

/** Successful paginated run history response. */
export const IntervalRunListResponseSchema = z
  .object({
    data: z.array(IntervalRunViewSchema),
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

/** Successful run detail response, including the country snapshots. */
export const IntervalRunDetailResponseSchema = z
  .object({ run: IntervalRunViewSchema, items: z.array(IntervalRunItemViewSchema) })
  .strict();

/** Serialized interval run summary. */
export type IntervalRunView = z.infer<typeof IntervalRunViewSchema>;
/** Serialized country-level run item. */
export type IntervalRunItemView = z.infer<typeof IntervalRunItemViewSchema>;
