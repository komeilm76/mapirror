/**
 * Stale-job recovery guarded by the same session-level advisory locks held by active workers (`P2-JOB-02`).
 *
 * A stale timestamp is only a candidate signal. A row changes state only after this connection can acquire the job's
 * lock, which is released immediately after the guarded update. This distinguishes a dead worker from a slow handler.
 *
 * @module modules/jobs/reaper
 */

import { sql, type Kysely } from 'kysely';

import type { Database } from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import { finalizeIntervalRunItem } from '../intervals/run-items';
import type { WorkerLog } from './worker';
import { releaseJobLock, tryAcquireJobLock } from './lock';
import { jobRetryDelayMs } from './retry';

/** Default heartbeat age at which a running job becomes a recovery candidate. */
export const STALE_JOB_AGE_MS = 4 * 60_000 + 30_000;
/** The reaper cadence plus stale age stays below five minutes, leaving processing margin. */
export const JOB_REAPER_INTERVAL_MS = 15_000;
const MAX_RECOVERY_AGE_MS = 5 * 60_000;
const WORKER_LOST_ERROR_CODE = 'WORKER_LOST';
const WORKER_LOST_ERROR_MESSAGE = 'The worker stopped before this job completed.';

/** Reaper scheduler and retry-policy options. */
export interface JobReaperOptions {
  /** Scheduler interval; defaults to 15 seconds. */
  readonly pollIntervalMs?: number;
  /** How old `locked_at` must be before a row is examined; defaults to 4 minutes 30 seconds. */
  readonly staleAfterMs?: number;
  /** Initial retry delay; defaults to one second. */
  readonly retryBaseDelayMs?: number;
  /** Maximum retry delay; defaults to five minutes. */
  readonly retryMaxDelayMs?: number;
  /** Required process logger. */
  readonly log: WorkerLog;
}

/** Summary of one recovery pass. */
export interface JobReapResult {
  /** Number of stale running rows considered. */
  readonly examined: number;
  /** Rows made queued after acquiring their lock. */
  readonly requeued: number;
  /** Rows made terminal after exhausting attempts. */
  readonly failed: number;
  /** Rows left unchanged because an active session still held the lock. */
  readonly lockBusy: number;
}

/** Handle for the periodic reaper. */
export interface JobReaper {
  stop(): Promise<void>;
}

/**
 * Checks stale running jobs and recovers only rows whose worker lock is no longer held.
 *
 * @param database - Process Kysely handle.
 * @param options - Injectable cutoff, retry delays and clock for deterministic integration tests.
 * @returns Counts for the recovery pass.
 */
export async function reapStaleJobs(
  database: Kysely<Database>,
  options: {
    readonly now?: Date;
    readonly staleAfterMs?: number;
    readonly retryBaseDelayMs?: number;
    readonly retryMaxDelayMs?: number;
  } = {},
): Promise<JobReapResult> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? STALE_JOB_AGE_MS;
  validateInterval(staleAfterMs, 'stale job age');
  if (Number.isNaN(now.getTime())) throw new RangeError('reaper time must be a valid date');
  const cutoff = new Date(now.getTime() - staleAfterMs);

  return database.connection().execute(async (session) => {
    const candidates = await session
      .selectFrom('jobs')
      .select(['id', 'attempts', 'max_attempts'])
      .where('status', '=', 'running')
      .where('locked_at', '<', cutoff)
      .orderBy('locked_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    let requeued = 0;
    let failed = 0;
    let lockBusy = 0;

    for (const job of candidates) {
      const acquired = await tryAcquireJobLock(session, job.id);
      if (!acquired) {
        lockBusy += 1;
        continue;
      }

      try {
        const retry = job.attempts < job.max_attempts;
        const delayMs = retry
          ? jobRetryDelayMs(
              Math.max(1, job.attempts),
              options.retryBaseDelayMs,
              options.retryMaxDelayMs,
            )
          : 0;
        const recovered = await withTransaction(session, async (trx) => {
          const row = await trx
            .updateTable('jobs')
            .set({
              status: retry ? 'queued' : 'failed',
              run_after: sql`case when ${retry} then now() + ${delayMs} * interval '1 millisecond' else run_after end`,
              error_code: WORKER_LOST_ERROR_CODE,
              error_message: WORKER_LOST_ERROR_MESSAGE,
              finished_at: retry ? null : sql`${now}`,
              locked_by: null,
              locked_at: null,
            })
            .where('id', '=', job.id)
            .where('status', '=', 'running')
            // A heartbeat may have advanced the row after the candidate query. Never overwrite a fresh timestamp.
            .where('locked_at', '<', cutoff)
            .returning('id')
            .executeTakeFirst();
          if (row !== undefined && !retry) {
            await finalizeIntervalRunItem(trx, job.id, {
              status: 'failed',
              errorCode: WORKER_LOST_ERROR_CODE,
              errorMessage: WORKER_LOST_ERROR_MESSAGE,
            });
          }
          return row;
        });

        if (recovered !== undefined) {
          if (retry) requeued += 1;
          else failed += 1;
        }
      } finally {
        await releaseJobLock(session, job.id);
      }
    }

    return { examined: candidates.length, requeued, failed, lockBusy };
  });
}

/**
 * Starts the non-overlapping periodic stale-job scan. Shutdown stops future passes and waits for an active one.
 *
 * @param database - Process Kysely handle.
 * @param options - Scheduler, retry and logging options.
 * @returns A handle that stops and drains the reaper loop.
 */
export function startJobReaper(database: Kysely<Database>, options: JobReaperOptions): JobReaper {
  const pollIntervalMs = options.pollIntervalMs ?? JOB_REAPER_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? STALE_JOB_AGE_MS;
  validateInterval(pollIntervalMs, 'job reaper interval');
  validateInterval(staleAfterMs, 'stale job age');
  if (pollIntervalMs + staleAfterMs > MAX_RECOVERY_AGE_MS) {
    throw new RangeError('job reaper interval plus stale age must not exceed five minutes');
  }
  if (options.retryBaseDelayMs !== undefined || options.retryMaxDelayMs !== undefined) {
    jobRetryDelayMs(1, options.retryBaseDelayMs, options.retryMaxDelayMs);
  }

  const controller = new AbortController();
  const loop = runReaperLoop(database, options, pollIntervalMs, staleAfterMs, controller.signal);
  let stopping: Promise<void> | undefined;
  return {
    stop: () => {
      controller.abort();
      stopping ??= loop;
      return stopping;
    },
  };
}

/** Runs immediately, then waits between scans; long scans never overlap. */
async function runReaperLoop(
  database: Kysely<Database>,
  options: JobReaperOptions,
  pollIntervalMs: number,
  staleAfterMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await reapStaleJobs(database, {
        staleAfterMs,
        retryBaseDelayMs: options.retryBaseDelayMs,
        retryMaxDelayMs: options.retryMaxDelayMs,
      });
      if (result.requeued > 0 || result.failed > 0 || result.lockBusy > 0) {
        options.log.info(result, 'stale job recovery pass completed');
      }
    } catch (error) {
      options.log.error({ err: error }, 'stale job recovery pass failed');
    }
    await pause(pollIntervalMs, signal);
  }
}

/** Validates a timer or stale-age value before it is used in Date/SQL arithmetic. */
function validateInterval(milliseconds: number, name: string): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/** Waits for the reaper cadence, or wakes immediately during shutdown. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}
