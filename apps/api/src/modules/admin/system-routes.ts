/** Admin system status and metrics reads (`P5-MON-02`).
 *
 * @module modules/admin/system-routes
 */

import {
  SystemMetricsQuerySchema,
  SystemMetricsResponseSchema,
  SystemStatusQuerySchema,
  SystemStatusResponseSchema,
  type SystemMetricsResponse,
  type SystemStatusResponse,
} from '@mapirror/shared';
import { sql } from 'kysely';
import type { FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/env';
import { CATALOG_SYNCED_AT_SETTING } from '../../db/repositories/catalog';
import { readDiskSpace, type DiskSpaceReader } from '../system/disk';

const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const WINDOW_SECONDS = {
  '5m': 5 * 60,
  '1h': 60 * 60,
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
} as const;
const STEP_SECONDS = {
  '5m': 10,
  '1h': 30,
  '24h': 5 * 60,
  '7d': 30 * 60,
} as const;

interface MetricRow {
  readonly t: Date;
  readonly cpu_percent: number | null;
  readonly load1: number | null;
  readonly load5: number | null;
  readonly load15: number | null;
  readonly mem_used_bytes: string | null;
  readonly mem_total_bytes: string | null;
  readonly disk_used_bytes: string | null;
  readonly disk_total_bytes: string | null;
  readonly cache_size_bytes: string | null;
}

interface StatusCountRow {
  readonly countries: string;
  readonly cached_countries: string;
  readonly public_countries: string;
  readonly versions: string;
  readonly updates_available: string;
  readonly jobs_running: string;
  readonly jobs_queued: string;
}

/** Injectable operating-system facts for deterministic status handler tests. */
export interface SystemStatusRuntime {
  /** Process uptime source. */
  readonly uptimeSeconds?: () => number;
  /** Filesystem reader for the configured cache directory. */
  readonly readDiskSpace?: DiskSpaceReader;
}

/**
 * Handles `GET /_admin/api/system/metrics`, downsampling in PostgreSQL before rows cross the API boundary.
 *
 * @param request - Fastify request; the shared query schema rejects unsupported windows and unknown keys.
 * @param now - Clock used to construct the requested time range.
 * @returns A strict, byte-safe metrics response.
 */
export async function getSystemMetrics(
  request: FastifyRequest,
  now: () => Date = () => new Date(),
): Promise<SystemMetricsResponse> {
  const parsed = SystemMetricsQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;

  const { window } = parsed.data;
  const nowAt = now();
  if (!Number.isFinite(nowAt.getTime()))
    throw new TypeError('system metrics clock returned an invalid date');
  const from = new Date(nowAt.getTime() - WINDOW_SECONDS[window] * 1_000);
  const stepSeconds = STEP_SECONDS[window];
  const database = request.server.db.db;
  const result = await sql<MetricRow>`
    select date_bin(${stepSeconds} * interval '1 second', sampled_at, timestamptz 'epoch') as t,
           avg(cpu_percent)::double precision as cpu_percent,
           avg(load1)::double precision as load1,
           avg(load5)::double precision as load5,
           avg(load15)::double precision as load15,
           round(avg(mem_used_bytes))::text as mem_used_bytes,
           round(avg(mem_total_bytes))::text as mem_total_bytes,
           round(avg(disk_used_bytes))::text as disk_used_bytes,
           round(avg(disk_total_bytes))::text as disk_total_bytes,
           round(avg(cache_size_bytes))::text as cache_size_bytes
      from metrics_samples
     where sampled_at >= ${from}
       and sampled_at <= ${nowAt}
     group by 1
     order by 1 asc
  `.execute(database);

  return SystemMetricsResponseSchema.parse({
    window,
    stepSeconds,
    samples: result.rows.map((row) => ({
      t: requiredDate(row.t).toISOString(),
      cpuPercent: row.cpu_percent,
      load1: row.load1,
      load5: row.load5,
      load15: row.load15,
      memUsedBytes: jsonBytesOrNull(row.mem_used_bytes),
      memTotalBytes: jsonBytesOrNull(row.mem_total_bytes),
      diskUsedBytes: jsonBytesOrNull(row.disk_used_bytes),
      diskTotalBytes: jsonBytesOrNull(row.disk_total_bytes),
      cacheSizeBytes: jsonBytesOrNull(row.cache_size_bytes),
    })),
    scope: 'container',
  });
}

/**
 * Handles `GET /_admin/api/system/status` from a consistent database snapshot plus current filesystem facts.
 *
 * `source.reachable` is the last completed source-sync outcome (or the durable successful-sync marker when job history
 * is unavailable); this endpoint does not perform a new upstream request. Orphan reporting is reserved for P5-MON-05
 * and is `null` until that read-only scan is available.
 *
 * @param request - Fastify request; status accepts no query parameters.
 * @param config - Validated process configuration.
 * @param runtime - Optional clock, uptime and filesystem seams for tests.
 * @returns A strict status response with large byte counts represented without precision loss.
 */
export async function getSystemStatus(
  request: FastifyRequest,
  config: AppConfig,
  runtime: SystemStatusRuntime = {},
): Promise<SystemStatusResponse> {
  const parsed = SystemStatusQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;

  const database = request.server.db.db;
  const snapshot = await database
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const [countResult, settings, lastCatalogJob] = await Promise.all([
        sql<StatusCountRow>`
          select (select count(*)::text from countries) as countries,
                 (select count(*)::text from country_cache) as cached_countries,
                 (select count(*)::text from country_cache where is_public) as public_countries,
                 (select count(*)::text from map_versions where status = 'ready') as versions,
                 (select count(*)::text from country_cache where update_state = 'update_available') as updates_available,
                 (select count(*)::text from jobs where status = 'running') as jobs_running,
                 (select count(*)::text from jobs where status = 'queued') as jobs_queued
        `.execute(trx),
        trx
          .selectFrom('settings')
          .select(['key', 'value'])
          .where('key', 'in', [CATALOG_SYNCED_AT_SETTING, 'branding.displayName'])
          .execute(),
        trx
          .selectFrom('jobs')
          .select('status')
          .where('type', '=', 'catalog_sync')
          .where('status', 'in', ['succeeded', 'failed'])
          .orderBy(sql`finished_at desc nulls last`)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst(),
      ]);
      const counts = countResult.rows[0];
      if (counts === undefined) throw new Error('system status counts query returned no row');
      const settingValues = new Map(settings.map(({ key, value }) => [key, value]));
      return {
        counts,
        lastSyncValue: settingValues.get(CATALOG_SYNCED_AT_SETTING),
        displayNameValue: settingValues.get('branding.displayName'),
        lastCatalogJob,
      };
    });

  const lastSyncAt = parseIsoTimestamp(snapshot.lastSyncValue);
  const disk = await (runtime.readDiskSpace ?? readDiskSpace)(config.cacheDir);
  if (
    typeof disk.freeBytes !== 'bigint' ||
    typeof disk.totalBytes !== 'bigint' ||
    disk.totalBytes < 0n ||
    disk.freeBytes < 0n ||
    disk.freeBytes > disk.totalBytes
  ) {
    throw new RangeError('cache filesystem returned invalid capacity values');
  }

  const usedBytes = disk.totalBytes - disk.freeBytes;
  const reserveBytes = BigInt(config.diskReserveBytes);
  const state = disk.freeBytes === 0n ? 'full' : disk.freeBytes <= reserveBytes ? 'low' : 'ok';
  const reachable =
    snapshot.lastCatalogJob === undefined
      ? lastSyncAt !== null
      : snapshot.lastCatalogJob.status === 'succeeded';
  const displayName =
    typeof snapshot.displayNameValue === 'string' && snapshot.displayNameValue.trim().length > 0
      ? snapshot.displayNameValue.trim()
      : config.brandingDisplayName;

  return SystemStatusResponseSchema.parse({
    version: config.appVersion,
    uptimeSeconds: Math.floor((runtime.uptimeSeconds ?? process.uptime)()),
    worker: {
      enabled: config.workerEnabled,
      concurrency: config.workerConcurrency,
      running: safeCount(snapshot.counts.jobs_running),
    },
    storage: {
      cacheDir: config.cacheDir,
      usedBytes: jsonBytes(usedBytes),
      freeBytes: jsonBytes(disk.freeBytes),
      reserveBytes: jsonBytes(reserveBytes),
      state,
      orphans: null,
    },
    counts: {
      countries: safeCount(snapshot.counts.countries),
      cachedCountries: safeCount(snapshot.counts.cached_countries),
      publicCountries: safeCount(snapshot.counts.public_countries),
      versions: safeCount(snapshot.counts.versions),
      updatesAvailable: safeCount(snapshot.counts.updates_available),
      jobsRunning: safeCount(snapshot.counts.jobs_running),
      jobsQueued: safeCount(snapshot.counts.jobs_queued),
    },
    source: {
      id: 'geofabrik',
      lastSyncAt: lastSyncAt?.toISOString() ?? null,
      reachable,
    },
    branding: { displayName },
  });
}

/** Converts a PostgreSQL byte count to a JSON-safe integer or decimal string. */
function jsonBytes(value: bigint): number | string {
  if (value < 0n) throw new RangeError('byte count must not be negative');
  return value <= MAX_SAFE_JSON_INTEGER ? Number(value) : value.toString();
}

/** Converts a nullable PostgreSQL byte aggregate to its JSON-safe representation. */
function jsonBytesOrNull(value: string | null): number | string | null {
  return value === null ? null : jsonBytes(parseNonNegativeInteger(value, 'byte count'));
}

/** Converts a PostgreSQL count to a safe JavaScript integer. */
function safeCount(value: string): number {
  const count = parseNonNegativeInteger(value, 'row count');
  if (count > MAX_SAFE_JSON_INTEGER)
    throw new RangeError('system status count exceeds the JSON safe integer range');
  return Number(count);
}

/** Parses PostgreSQL's decimal integer output without accepting signs, fractions, or unsafe coercions. */
function parseNonNegativeInteger(value: string, description: string): bigint {
  if (!/^\d+$/u.test(value)) throw new TypeError(`system query returned an invalid ${description}`);
  return BigInt(value);
}

/** Returns a valid database timestamp marker, ignoring missing, malformed or non-canonical settings. */
function parseIsoTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
    ? timestamp
    : null;
}

/** Rejects a non-Date timestamp returned by the database before formatting the response. */
function requiredDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('metrics query returned an invalid bucket timestamp');
  }
  return value;
}
