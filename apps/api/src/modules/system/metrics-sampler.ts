/**
 * Periodic process/container metrics collection (`P5-MON-01`).
 *
 * The sampler writes at a fixed ten-second cadence, deduplicates restarts in the same second, and treats a failed
 * measurement or write as a warning rather than a server-fatal error. The database stores samples; query windows,
 * retention and orphan reporting are separate monitoring tasks.
 *
 * @module modules/system/metrics-sampler
 */

import { cpus, freemem, loadavg, totalmem } from 'node:os';

import { sql, type Kysely } from 'kysely';

import type { Database } from '../../db/schema';
import type { DiskSpace } from './disk';
import { readDiskSpace } from './disk';

/** Required sampling cadence from `03-data-model.md` §2.9. */
export const METRICS_SAMPLER_INTERVAL_MS = 10_000;

/** Fields captured in each snapshot; unavailable source readings are represented as `null`. */
export interface MetricsSnapshot {
  readonly cpuPercent: number | null;
  readonly load1: number | null;
  readonly load5: number | null;
  readonly load15: number | null;
  readonly memUsedBytes: bigint | null;
  readonly memTotalBytes: bigint | null;
  readonly diskUsedBytes: bigint | null;
  readonly diskTotalBytes: bigint | null;
  readonly cacheSizeBytes: bigint | null;
}

/** Aggregate CPU counters used to compare two operating-system readings. */
export interface CpuCounters {
  readonly total: number;
  readonly idle: number;
  readonly cores: number;
}

/** Methods used by the sampler; injectable so failures and resource readings are deterministic in tests. */
export interface MetricsReaders {
  readonly readCpuCounters: () => CpuCounters;
  readonly readLoadAverage: () => readonly number[];
  readonly readMemory: () => { readonly totalBytes: number; readonly freeBytes: number };
  readonly readDiskSpace: (directory: string) => Promise<DiskSpace>;
  readonly readCacheSize: () => Promise<bigint>;
}

/** Logger contract; the Fastify application logger satisfies it. */
export interface MetricsSamplerLog {
  readonly warn: (context: object, message: string) => void;
}

/** Options for the sampler's deterministic lifecycle tests. */
export interface MetricsSamplerOptions {
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly readers?: MetricsReaders;
}

/** Convert each CPU's cumulative ticks into totals for the interval comparison. */
export function readCpuCounters(): CpuCounters {
  const cores = cpus();
  let total = 0;
  let idle = 0;
  for (const core of cores) {
    const times = core.times;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
    idle += times.idle;
  }
  return { total, idle, cores: cores.length };
}

/**
 * Returns busy CPU percentage between two cumulative counter readings.
 *
 * A first reading, reset, changed core count, or invalid delta has no honest percentage and returns `null`.
 */
export function cpuPercentBetween(
  previous: CpuCounters | null,
  current: CpuCounters,
): number | null {
  if (previous === null || current.cores === 0 || current.cores !== previous.cores) return null;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (!Number.isFinite(total) || !Number.isFinite(idle) || total <= 0 || idle < 0 || idle > total) {
    return null;
  }
  return ((total - idle) / total) * 100;
}

/** Build default readers from Node's OS APIs, filesystem capacity, and the cache totals read model. */
export function createMetricsReaders(database: Kysely<Database>): MetricsReaders {
  return {
    readCpuCounters,
    readLoadAverage: () => loadavg(),
    readMemory: () => ({ totalBytes: totalmem(), freeBytes: freemem() }),
    readDiskSpace: (directory) => readDiskSpace(directory),
    readCacheSize: async () => {
      const result = await sql<{ cache_size_bytes: string }>`
        select coalesce(sum(total_size_bytes), 0)::text as cache_size_bytes
          from country_cache
      `.execute(database);
      const value = result.rows[0]?.cache_size_bytes;
      if (value === undefined || !/^\d+$/u.test(value)) {
        throw new Error('cache size query returned an invalid byte count');
      }
      return BigInt(value);
    },
  };
}

/**
 * Starts sampling immediately, then at the configured cadence without overlapping passes.
 *
 * Each metric source is isolated: a failed disk or memory read produces `null` for that field while the rest of the
 * sample can still be persisted. A database write failure is logged and retried on the next tick. The timer is
 * unreferenced and shutdown waits for the current pass to finish before the database pool closes.
 *
 * @param database - Process Kysely handle.
 * @param cacheDirectory - Cache root whose filesystem capacity is measured.
 * @param log - Warning logger.
 * @param options - Optional cadence, clock, and measurement readers for tests.
 * @returns Stop handle that clears the timer and drains an in-flight sample.
 */
export function startMetricsSampler(
  database: Kysely<Database>,
  cacheDirectory: string,
  log: MetricsSamplerLog,
  options: MetricsSamplerOptions = {},
): { stop: () => Promise<void> } {
  const intervalMs = options.intervalMs ?? METRICS_SAMPLER_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`metrics sampler interval must be a positive integer, got ${intervalMs}`);
  }
  const readers = options.readers ?? createMetricsReaders(database);
  const now = options.now ?? (() => new Date());
  let previousCpu: CpuCounters | null = null;
  let stopped = false;
  let active: Promise<void> | undefined;

  const run = (): void => {
    if (stopped || active !== undefined) return;
    const pending = sampleAndPersist(database, cacheDirectory, readers, now, previousCpu)
      .then(({ cpuCounters, failedReadings }) => {
        previousCpu = cpuCounters;
        if (failedReadings.length > 0) {
          log.warn(
            { failedReadings },
            'some system metrics could not be read; nullable fields were stored',
          );
        }
      })
      .catch((error: unknown) => {
        log.warn({ err: error }, 'system metrics sample failed; sampler will retry');
      })
      .finally(() => {
        if (active === pending) active = undefined;
      });
    active = pending;
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}

async function sampleAndPersist(
  database: Kysely<Database>,
  cacheDirectory: string,
  readers: MetricsReaders,
  now: () => Date,
  previousCpu: CpuCounters | null,
): Promise<{ cpuCounters: CpuCounters | null; failedReadings: string[] }> {
  const failedReadings: string[] = [];
  let cpuCounters: CpuCounters | null = null;
  let cpuPercent: number | null = null;
  try {
    cpuCounters = readers.readCpuCounters();
    cpuPercent = cpuPercentBetween(previousCpu, cpuCounters);
  } catch {
    // Keep this field unknown and reset the comparison baseline; a later good read starts a fresh interval.
    failedReadings.push('cpu');
    cpuCounters = null;
  }

  let loads: readonly number[] = [];
  try {
    loads = readers.readLoadAverage();
  } catch {
    // Load averages are optional measurements; keep the sample useful when this source fails.
    failedReadings.push('load');
  }
  const load1 = finiteNonNegative(loads[0]);
  const load5 = finiteNonNegative(loads[1]);
  const load15 = finiteNonNegative(loads[2]);
  if (
    (loads.length < 3 || load1 === null || load5 === null || load15 === null) &&
    !failedReadings.includes('load')
  ) {
    failedReadings.push('load');
  }

  let memory: { readonly totalBytes: number; readonly freeBytes: number } | null = null;
  try {
    memory = readers.readMemory();
  } catch {
    // See the nullable metrics columns; one unavailable operating-system fact does not discard the other readings.
    failedReadings.push('memory');
  }
  const measuredMemTotal = memory === null ? null : safeBytes(memory.totalBytes);
  const measuredMemFree = memory === null ? null : safeBytes(memory.freeBytes);
  let memTotalBytes: bigint | null = null;
  let memUsedBytes: bigint | null = null;
  if (
    measuredMemTotal !== null &&
    measuredMemFree !== null &&
    measuredMemFree <= measuredMemTotal
  ) {
    memTotalBytes = measuredMemTotal;
    memUsedBytes = measuredMemTotal - measuredMemFree;
  } else if (memory !== null) {
    failedReadings.push('memory');
  }

  let disk: DiskSpace | null = null;
  try {
    disk = await readers.readDiskSpace(cacheDirectory);
  } catch {
    // statfs can fail during transient mounts or permission changes; persist other available fields.
    failedReadings.push('disk');
  }
  const measuredDiskTotal = disk === null ? null : safeBigint(disk.totalBytes);
  const measuredDiskFree = disk === null ? null : safeBigint(disk.freeBytes);
  let diskTotalBytes: bigint | null = null;
  let diskUsedBytes: bigint | null = null;
  if (
    measuredDiskTotal !== null &&
    measuredDiskFree !== null &&
    measuredDiskFree <= measuredDiskTotal
  ) {
    diskTotalBytes = measuredDiskTotal;
    diskUsedBytes = measuredDiskTotal - measuredDiskFree;
  } else if (disk !== null) {
    failedReadings.push('disk');
  }

  let cacheSizeBytes: bigint | null = null;
  try {
    cacheSizeBytes = safeBigint(await readers.readCacheSize());
  } catch {
    // Cache metadata may be unavailable while the database reconnects; the write below will also retry.
    failedReadings.push('cache');
  }
  if (cacheSizeBytes === null && !failedReadings.includes('cache')) {
    failedReadings.push('cache');
  }

  const sampledAtRaw = now();
  if (!(sampledAtRaw instanceof Date) || !Number.isFinite(sampledAtRaw.getTime())) {
    throw new TypeError('metrics sampler clock must return a valid Date');
  }
  const sampledAt = new Date(Math.floor(sampledAtRaw.getTime() / 1_000) * 1_000);
  const values: MetricsSnapshot = {
    cpuPercent: cpuPercent !== null && Number.isFinite(cpuPercent) ? cpuPercent : null,
    load1,
    load5,
    load15,
    memUsedBytes,
    memTotalBytes,
    diskUsedBytes,
    diskTotalBytes,
    cacheSizeBytes,
  };

  await database
    .insertInto('metrics_samples')
    .values({
      sampled_at: sampledAt,
      cpu_percent: values.cpuPercent,
      load1: values.load1,
      load5: values.load5,
      load15: values.load15,
      mem_used_bytes: values.memUsedBytes,
      mem_total_bytes: values.memTotalBytes,
      disk_used_bytes: values.diskUsedBytes,
      disk_total_bytes: values.diskTotalBytes,
      cache_size_bytes: values.cacheSizeBytes,
    })
    .onConflict((conflict) => conflict.column('sampled_at').doNothing())
    .execute();

  return { cpuCounters, failedReadings };
}

function finiteNonNegative(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeBytes(value: number): bigint | null {
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

const MAX_POSTGRES_INT8 = 9_223_372_036_854_775_807n;

function safeBigint(value: bigint): bigint | null {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_POSTGRES_INT8 ? value : null;
}
