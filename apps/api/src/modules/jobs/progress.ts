/**
 * Monotonic, throttled job progress reporting and safe ETA estimates (`P2-JOB-03`).
 *
 * `eta_seconds` is derived from the durable byte counters and recent speed; it is intentionally not stored as a second
 * clock-sensitive value in the jobs table.
 *
 * @module modules/jobs/progress
 */

import { performance } from 'node:perf_hooks';

import type { JOB_PHASES } from '@mapirror/shared';
import { sql, type Kysely } from 'kysely';

import type { Database, Job } from '../../db/schema';

/** Progress writes are capped at one per second; `flush` persists the latest buffered update immediately. */
export const JOB_PROGRESS_MIN_INTERVAL_MS = 1_000;
/** Estimates beyond 30 days are not useful to the UI and are reported as unknown. */
export const MAX_JOB_ETA_SECONDS = 30 * 24 * 60 * 60;
/** PostgreSQL `bigint` columns are signed 64-bit values. */
const MAX_POSTGRES_INT8 = 9_223_372_036_854_775_807n;

/** Progress phases shared with the API and browser response contract. */
export type JobProgressPhase = (typeof JOB_PHASES)[number];

/** A progress snapshot. Byte counts use `bigint` to match PostgreSQL's int8 range without rounding. */
export interface JobProgressUpdate {
  /** Bytes received/processed so far. Regressions are ignored. */
  readonly progressBytes: bigint;
  /** Known job size; `null` explicitly means unknown, while `undefined` keeps the previous value. */
  readonly totalBytes?: bigint | null;
  /** Current user-facing phase; `null` clears the phase. */
  readonly phase?: JobProgressPhase | null;
}

/** Reporter returned to one handler for its active job. */
export interface JobProgressReporter {
  /** Buffer or persist a progress snapshot, throttled to at most one write per interval. */
  readonly report: (update: JobProgressUpdate) => Promise<void>;
  /** Persist the latest buffered state regardless of the throttle interval. */
  readonly flush: () => Promise<void>;
  /** Stop the timer and flush remaining state. */
  readonly stop: () => Promise<void>;
}

/** Injectable throttle for deterministic tests. */
export interface JobProgressReporterOptions {
  /** Minimum interval between database updates; production defaults to one second. */
  readonly minIntervalMs?: number;
  /** Monotonic clock source; defaults to `performance.now`. */
  readonly now?: () => number;
}

interface PendingProgress {
  readonly progressBytes: bigint;
  readonly totalBytes?: bigint | null;
  readonly phase?: JobProgressPhase | null;
}

/**
 * Creates a progress callback bound to the current job and worker ownership.
 *
 * Updates are buffered and coalesced, progress bytes are made monotonic both in process and in SQL, and speed is
 * calculated from the last persisted byte count/time. Every write is conditional on the worker still owning a running
 * row. The handler should await `report` and the worker flushes once more before its terminal update.
 *
 * @param session - Kysely instance pinned to the job-lock connection.
 * @param job - Claimed job snapshot.
 * @param workerId - Worker-slot owner token.
 * @param options - Throttle and clock controls.
 * @returns `report`, `flush` and `stop` methods for the handler/worker.
 */
export function createJobProgressReporter(
  session: Kysely<Database>,
  job: Job,
  workerId: string,
  options: JobProgressReporterOptions = {},
): JobProgressReporter {
  const minIntervalMs = options.minIntervalMs ?? JOB_PROGRESS_MIN_INTERVAL_MS;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 1) {
    throw new RangeError('job progress interval must be a positive safe integer');
  }
  const clock = options.now ?? (() => performance.now());
  const now = (): number => {
    const value = clock();
    if (!Number.isFinite(value))
      throw new RangeError('job progress clock must return a finite number');
    return value;
  };
  let persistedBytes = BigInt(job.progress_bytes);
  let lastWriteAt = now() - minIntervalMs;
  let pending: PendingProgress | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let lastError: unknown;
  let stopped = false;

  const merge = (
    previous: PendingProgress | undefined,
    update: JobProgressUpdate,
  ): PendingProgress => ({
    progressBytes:
      previous === undefined || update.progressBytes > previous.progressBytes
        ? update.progressBytes
        : previous.progressBytes,
    totalBytes: update.totalBytes === undefined ? previous?.totalBytes : update.totalBytes,
    phase: update.phase === undefined ? previous?.phase : update.phase,
  });

  const schedule = (): void => {
    if (stopped || timer !== undefined || pending === undefined) return;
    const remainingMs = Math.max(0, minIntervalMs - (now() - lastWriteAt));
    timer = setTimeout(() => {
      timer = undefined;
      void persistPending().catch(() => undefined);
    }, remainingMs);
    timer.unref?.();
  };

  const persistPending = async (): Promise<void> => {
    if (inFlight !== undefined) {
      await inFlight;
      return persistPending();
    }
    if (lastError !== undefined) throw normalizeProgressError(lastError);
    if (pending === undefined) return;

    const update = pending;
    pending = undefined;
    const startedAt = now();
    const nextBytes = update.progressBytes > persistedBytes ? update.progressBytes : persistedBytes;
    const elapsedMs = Math.max(1, Math.floor(startedAt - lastWriteAt));
    const deltaBytes = nextBytes - persistedBytes;
    const estimatedSpeed = deltaBytes > 0n ? (deltaBytes * 1_000n) / BigInt(elapsedMs) : 0n;
    const speedBps = estimatedSpeed > MAX_POSTGRES_INT8 ? MAX_POSTGRES_INT8 : estimatedSpeed;
    const values = {
      progress_bytes: sql<bigint>`greatest(progress_bytes, ${nextBytes})`,
      speed_bps: speedBps,
      ...(update.totalBytes === undefined ? {} : { total_bytes: update.totalBytes }),
      ...(update.phase === undefined ? {} : { phase: update.phase }),
    };

    inFlight = (async () => {
      const row = await session
        .updateTable('jobs')
        .set(values)
        .where('id', '=', job.id)
        .where('status', '=', 'running')
        .where('locked_by', '=', workerId)
        .returning('progress_bytes')
        .executeTakeFirst();
      if (row === undefined) throw new Error(`worker no longer owns progress for job ${job.id}`);
      persistedBytes = BigInt(row.progress_bytes);
      lastWriteAt = startedAt;
    })();

    try {
      await inFlight;
    } catch (error) {
      lastError = error;
      pending = merge(update, pending ?? update);
      throw error;
    } finally {
      inFlight = undefined;
    }
    if (pending !== undefined) schedule();
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    await persistPending();
  };

  return {
    report: async (update) => {
      if (stopped) throw new Error(`progress reporter for job ${job.id} is stopped`);
      if (lastError !== undefined) throw normalizeProgressError(lastError);
      validateProgressUpdate(update);
      pending = merge(pending, update);
      if (inFlight === undefined && now() - lastWriteAt >= minIntervalMs) {
        await persistPending();
      } else {
        schedule();
      }
    },
    flush,
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await persistPending();
    },
  };
}

/**
 * Returns a bounded integer ETA, or `null` when the estimate is unavailable or implausibly long.
 *
 * Uses integer arithmetic, so values above JavaScript's exact integer range remain correct until the final bounded
 * seconds value is produced.
 *
 * @param progressBytes - Bytes completed so far.
 * @param totalBytes - Expected total bytes, or `null` if unknown.
 * @param speedBps - Current transfer speed, or `null` if not available.
 * @returns Seconds remaining (zero when complete), or `null` when unknown.
 */
export function estimateJobEtaSeconds(
  progressBytes: string | number | bigint,
  totalBytes: string | number | bigint | null,
  speedBps: string | number | bigint | null,
): number | null {
  const progress = parseNonNegativeBigInt(progressBytes);
  const total = totalBytes === null ? null : parseNonNegativeBigInt(totalBytes);
  const speed = speedBps === null ? null : parseNonNegativeBigInt(speedBps);
  if (progress === null || total === null) return null;
  if (total <= progress) return 0;
  if (speed === null || speed === 0n) return null;

  const remaining = total - progress;
  const seconds = (remaining + speed - 1n) / speed;
  return seconds > BigInt(MAX_JOB_ETA_SECONDS) ? null : Number(seconds);
}

/** Preserves thrown `Error`s and wraps non-Error promise rejections for callers. */
function normalizeProgressError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('progress persistence failed', { cause: error });
}

/** Rejects negative or unsafe byte counts before they reach SQL. */
function validateProgressUpdate(update: JobProgressUpdate): void {
  if (
    typeof update.progressBytes !== 'bigint' ||
    update.progressBytes < 0n ||
    update.progressBytes > MAX_POSTGRES_INT8
  ) {
    throw new RangeError('progressBytes must be a non-negative PostgreSQL bigint');
  }
  if (update.totalBytes !== undefined && update.totalBytes !== null) {
    if (
      typeof update.totalBytes !== 'bigint' ||
      update.totalBytes < 0n ||
      update.totalBytes > MAX_POSTGRES_INT8
    ) {
      throw new RangeError(
        'totalBytes must be a non-negative PostgreSQL bigint, null, or undefined',
      );
    }
  }
}

/** Parses a PostgreSQL int8-shaped value without accepting lossy JS numbers. */
function parseNonNegativeBigInt(value: string | number | bigint): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (!/^\d+$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
