/**
 * Admin system status and persisted metrics contracts (`P5-MON-02`).
 *
 * @module system
 */

import { z } from 'zod';

import { STORAGE_STATES } from './constants';

/** Time windows available to the admin metrics endpoint. */
export const SYSTEM_METRIC_WINDOWS = ['5m', '1h', '24h', '7d'] as const;

/** Output representation for PostgreSQL byte counts without rounding beyond JavaScript's safe integer range. */
export const JsonByteCountSchema = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/u),
]);

/** Query shape for `GET /_admin/api/system/metrics`. */
export const SystemMetricsQuerySchema = z
  .object({ window: z.enum(SYSTEM_METRIC_WINDOWS).default('1h') })
  .strict();

/** One downsampled metrics point. */
export const SystemMetricSampleSchema = z
  .object({
    t: z.iso.datetime(),
    cpuPercent: z.number().min(0).max(100).nullable(),
    load1: z.number().nonnegative().nullable(),
    load5: z.number().nonnegative().nullable(),
    load15: z.number().nonnegative().nullable(),
    memUsedBytes: JsonByteCountSchema.nullable(),
    memTotalBytes: JsonByteCountSchema.nullable(),
    diskUsedBytes: JsonByteCountSchema.nullable(),
    diskTotalBytes: JsonByteCountSchema.nullable(),
    cacheSizeBytes: JsonByteCountSchema.nullable(),
  })
  .strict();

/** Response from `GET /_admin/api/system/metrics`. */
export const SystemMetricsResponseSchema = z
  .object({
    window: z.enum(SYSTEM_METRIC_WINDOWS),
    stepSeconds: z.number().int().positive(),
    samples: z.array(SystemMetricSampleSchema),
    scope: z.literal('container'),
  })
  .strict();

/** Empty query shape for `GET /_admin/api/system/status`; unknown keys are rejected. */
export const SystemStatusQuerySchema = z.object({}).strict();

/** Counts used on the status dashboard. */
export const SystemStatusCountsSchema = z
  .object({
    countries: z.number().int().nonnegative().safe(),
    cachedCountries: z.number().int().nonnegative().safe(),
    publicCountries: z.number().int().nonnegative().safe(),
    versions: z.number().int().nonnegative().safe(),
    updatesAvailable: z.number().int().nonnegative().safe(),
    jobsRunning: z.number().int().nonnegative().safe(),
    jobsQueued: z.number().int().nonnegative().safe(),
  })
  .strict();

/** Response from `GET /_admin/api/system/status`. */
export const SystemStatusResponseSchema = z
  .object({
    version: z.string(),
    uptimeSeconds: z.number().int().nonnegative().safe(),
    worker: z
      .object({
        enabled: z.boolean(),
        concurrency: z.number().int().positive().safe(),
        running: z.number().int().nonnegative().safe(),
      })
      .strict(),
    storage: z
      .object({
        cacheDir: z.string(),
        usedBytes: JsonByteCountSchema,
        freeBytes: JsonByteCountSchema,
        reserveBytes: JsonByteCountSchema,
        state: z.enum(STORAGE_STATES),
        /** Populated with the read-only orphan report in P5-MON-05. */
        orphans: z
          .object({ count: z.number().int().nonnegative().safe(), bytes: JsonByteCountSchema })
          .strict()
          .nullable(),
      })
      .strict(),
    counts: SystemStatusCountsSchema,
    source: z
      .object({
        id: z.string(),
        lastSyncAt: z.iso.datetime().nullable(),
        reachable: z.boolean(),
      })
      .strict(),
    branding: z.object({ displayName: z.string() }).strict(),
  })
  .strict();

/** Type inferred from {@link SystemMetricsQuerySchema}. */
export type SystemMetricsQuery = z.infer<typeof SystemMetricsQuerySchema>;
/** Type inferred from {@link SystemMetricsResponseSchema}. */
export type SystemMetricsResponse = z.infer<typeof SystemMetricsResponseSchema>;
/** Type inferred from {@link SystemStatusResponseSchema}. */
export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>;
