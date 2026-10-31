/**
 * Shared contracts for the admin jobs list, detail and cancellation endpoints (`P2-API-10`).
 *
 * @module jobs
 */

import { z } from 'zod';

import { JOB_PHASES, JOB_STATUSES, JOB_TYPES } from './constants';
import { JsonIntegerSchema } from './catalog';

/** List filters for `GET /_admin/api/jobs`; pagination values are normalized separately. */
export const JobListQuerySchema = z
  .object({
    status: z.enum(JOB_STATUSES).optional(),
    type: z.enum(JOB_TYPES).optional(),
    page: z.unknown().optional(),
    limit: z.unknown().optional(),
  })
  .strict();

/** Path parameter for job detail and cancellation. */
export const JobParamsSchema = z.object({ jobId: z.uuid() }).strict();

/** Safe known payload fields returned to admin clients; unrecognized keys are stripped by the route projection. */
export const DownloadJobPayloadSchema = z
  .object({
    countryId: z.uuid(),
    version: z.string().min(1).max(64),
    origin: z.enum(['geofabrik_snapshot', 'geofabrik_latest']).optional(),
    onlyIfChanged: z.boolean().optional(),
    keepVersions: z.int().min(1).max(10).optional(),
  })
  .strict();

export const CatalogSyncJobPayloadSchema = z.object({ source: z.string().min(1).max(64) }).strict();

export const ImportJobPayloadSchema = z
  .object({
    uploadId: z.uuid(),
    countryId: z.uuid(),
    version: z.string().min(1).max(32),
    replace: z.boolean(),
  })
  .strict();

export const UpdateCheckJobPayloadSchema = z
  .object({
    countryIds: z
      .array(z.uuid())
      .max(10_000)
      .refine((ids) => new Set(ids).size === ids.length, 'Country ids must be unique')
      .optional(),
  })
  .strict();

/** Safe aggregate persisted as the result of a bulk update-check job. */
export const UpdateCheckJobResultSchema = z
  .object({
    total: z.int().nonnegative(),
    checked: z.int().nonnegative(),
    updateAvailable: z.int().nonnegative(),
    upToDate: z.int().nonnegative(),
    unknown: z.int().nonnegative(),
    skipped: z.int().nonnegative(),
  })
  .strict()
  .refine(
    (result) =>
      result.checked === result.updateAvailable + result.upToDate + result.unknown &&
      result.total === result.checked + result.skipped,
    'Update-check aggregate counts must add up',
  );

export const PruneJobPayloadSchema = z
  .object({ countryId: z.uuid().optional(), keep: z.int().min(1).max(10_000).optional() })
  .strict();

/** A type-specific, allow-listed payload; `null` means a stored payload did not match its known safe shape. */
export const JobPayloadSchema = z.union([
  DownloadJobPayloadSchema,
  CatalogSyncJobPayloadSchema,
  ImportJobPayloadSchema,
  UpdateCheckJobPayloadSchema,
  PruneJobPayloadSchema,
]);

/** Safe error details persisted by the worker; arbitrary exception text is never returned. */
export const JobErrorSchema = z
  .object({
    code: z.enum(['JOB_HANDLER_FAILED', 'WORKER_LOST']),
    message: z.string().min(1),
  })
  .strict();

/** Job projection used by both list and detail endpoints. */
export const JobViewSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(JOB_TYPES),
    status: z.enum(JOB_STATUSES),
    phase: z.enum(JOB_PHASES).nullable(),
    progressBytes: JsonIntegerSchema,
    totalBytes: JsonIntegerSchema.nullable(),
    speedBps: JsonIntegerSchema.nullable(),
    etaSeconds: z
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60)
      .nullable(),
    payload: JobPayloadSchema.nullable(),
    updateCheckResult: UpdateCheckJobResultSchema.nullable(),
    cancelRequested: z.boolean(),
    attempts: z.int().nonnegative(),
    maxAttempts: z.int().min(1),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    error: JobErrorSchema.nullable(),
  })
  .strict();

/** Successful `GET /_admin/api/jobs` response. */
export const JobListResponseSchema = z
  .object({
    data: z.array(JobViewSchema),
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

/** Successful `GET /_admin/api/jobs/:jobId` response. */
export const JobDetailResponseSchema = JobViewSchema;

/** `POST /_admin/api/jobs/:jobId/cancel` accepts no fields. */
export const JobCancelRequestSchema = z.object({}).strict();

/** `202` cancellation acknowledgement, or `200` when a terminal job is already non-cancelable. */
export const JobCancelResponseSchema = z
  .object({
    jobId: z.uuid(),
    status: z.enum(JOB_STATUSES),
    accepted: z.boolean(),
    cancelRequested: z.boolean(),
  })
  .strict();

export type JobListQuery = z.infer<typeof JobListQuerySchema>;
export type JobPayload = z.infer<typeof JobPayloadSchema>;
export type UpdateCheckJobResult = z.infer<typeof UpdateCheckJobResultSchema>;
export type JobView = z.infer<typeof JobViewSchema>;
export type JobListResponse = z.infer<typeof JobListResponseSchema>;
export type JobDetailResponse = z.infer<typeof JobDetailResponseSchema>;
export type JobCancelResponse = z.infer<typeof JobCancelResponseSchema>;
