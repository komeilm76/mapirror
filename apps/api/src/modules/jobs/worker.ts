/**
 * PostgreSQL-backed job claiming and the in-process worker pool (`P2-JOB-01`, heartbeat/retry ownership in `P2-JOB-02`).
 *
 * Each slot claims one eligible row atomically with `FOR UPDATE SKIP LOCKED`, then holds a session-level advisory lock
 * on that same dedicated connection for the whole handler lifetime. No database transaction spans job execution.
 *
 * @module modules/jobs/worker
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { MAX_WORKER_CONCURRENCY } from '../../config/limits';
import type { Database, Job, JobType, JsonValue } from '../../db/schema';
import { JobOwnershipLostError, monitorJobCancellation } from './cancellation';
import { releaseJobLock, tryAcquireJobLock } from './lock';
import { createJobProgressReporter, type JobProgressUpdate } from './progress';
import { jobRetryDelayMs } from './retry';

/** Optional cancellation signal for handlers that can stop promptly after ownership/heartbeat is lost. */
export interface JobHandlerContext {
  /** The worker's pinned session; reuse it for database work instead of checking out another pool connection. */
  readonly database: Kysely<Database>;
  /** Aborted when cancellation is requested or worker ownership is lost. */
  readonly signal: AbortSignal;
  /** Reports monotonic byte progress, phase and total-size metadata (writes are throttled). */
  readonly reportProgress: (update: JobProgressUpdate) => Promise<void>;
}

/** A handler receives a claimed row and may return JSON to store as its result. */
export type JobHandler = (job: Job, context: JobHandlerContext) => Promise<JsonValue | void>;

/** One handler per job type. Missing handlers are deliberately not claimable. */
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

/** Logger methods needed by the worker; Fastify's logger and a test spy both satisfy this. */
export interface WorkerLog {
  readonly info: (context: object, message: string) => void;
  readonly warn: (context: object, message: string) => void;
  readonly error: (context: object, message: string) => void;
}

/** Options for the worker pool. Timing values are injectable to keep the polling tests fast. */
export interface JobWorkerOptions {
  /** Number of independent claim loops. Must be a positive integer. */
  readonly concurrency: number;
  /** Delay after no eligible row or a transient database error. Defaults to one second. */
  readonly pollIntervalMs?: number;
  /** Heartbeat cadence. Defaults to 15 seconds. */
  readonly heartbeatIntervalMs?: number;
  /** Cancellation flag poll cadence. Defaults to 250 ms. */
  readonly cancellationPollIntervalMs?: number;
  /** Initial delay before a retry. Defaults to one second. */
  readonly retryBaseDelayMs?: number;
  /** Maximum retry delay. Defaults to five minutes. */
  readonly retryMaxDelayMs?: number;
  /** Tests may supply a stable ID; production IDs are generated independently per worker slot. */
  readonly workerId?: () => string;
  /** Process logger. */
  readonly log: WorkerLog;
}

/** The running worker pool. `stop` stops new claims and waits for already claimed handlers to finish. */
export interface JobWorker {
  stop(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 250;
const FAILED_ERROR_CODE = 'JOB_HANDLER_FAILED';
const FAILED_ERROR_MESSAGE = 'The job handler failed.';

/**
 * Atomically claims the highest-priority eligible row for one worker slot.
 *
 * `run_after` is compared to the database clock, not the worker's clock. Adding `id` as the final sort key makes ties
 * deterministic without changing the documented priority/run-time/creation ordering.
 *
 * @param database - The process Kysely handle; no transaction spans job execution.
 * @param workerId - Unique owner label for this worker slot.
 * @param eligibleTypes - Job types for which this process has registered handlers.
 * @returns The claimed job, or `null` when no registered, due job is queued.
 */
export async function claimNextJob(
  database: Kysely<Database>,
  workerId: string,
  eligibleTypes: readonly JobType[],
): Promise<Job | null> {
  if (workerId.trim().length === 0) throw new TypeError('workerId must not be empty');
  if (eligibleTypes.length === 0) return null;

  const result = await sql<Job>`
    with next_job as (
      select id
        from jobs
       where status = 'queued'
         and run_after <= now()
         and type = any(${sql.val([...eligibleTypes])}::job_type[])
       order by priority desc, run_after asc, created_at asc, id asc
       limit 1
       for update skip locked
    )
    update jobs as job
       set status = 'running',
           locked_by = ${workerId},
           locked_at = now(),
           started_at = now(),
           finished_at = null,
           attempts = job.attempts + 1
      from next_job
     where job.id = next_job.id
    returning job.*
  `.execute(database);

  return result.rows[0] ?? null;
}

/**
 * Starts `concurrency` independent poll-and-dispatch loops.
 *
 * Stopping aborts an idle poll immediately but lets a handler already in progress finish before resolving. Each active
 * slot pins one PostgreSQL connection for its session-level job lock; the handler itself is outside a transaction.
 * Database errors do not kill a slot: it warns, backs off for the poll interval, and tries again.
 *
 * @param database - The process Kysely handle.
 * @param handlers - Registered handlers; unregistered types stay queued.
 * @param options - Concurrency, logger and optional test controls.
 * @returns A handle that stops polling and drains active handler calls.
 */
export function startJobWorker(
  database: Kysely<Database>,
  handlers: JobHandlers,
  options: JobWorkerOptions,
): JobWorker {
  if (
    !Number.isSafeInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > MAX_WORKER_CONCURRENCY
  ) {
    throw new RangeError(`worker concurrency must be between 1 and ${MAX_WORKER_CONCURRENCY}`);
  }

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const cancellationPollIntervalMs =
    options.cancellationPollIntervalMs ?? DEFAULT_CANCELLATION_POLL_INTERVAL_MS;
  const retryBaseDelayMs = options.retryBaseDelayMs;
  const retryMaxDelayMs = options.retryMaxDelayMs;
  validateInterval(pollIntervalMs, 'worker poll interval');
  validateInterval(heartbeatIntervalMs, 'worker heartbeat interval');
  validateInterval(cancellationPollIntervalMs, 'job cancellation poll interval');
  if (retryBaseDelayMs !== undefined || retryMaxDelayMs !== undefined) {
    // Validate the full override pair before starting any asynchronous loop.
    jobRetryDelayMs(1, retryBaseDelayMs, retryMaxDelayMs);
  }

  const eligibleTypes = (Object.keys(handlers) as JobType[]).filter(
    (type) => handlers[type] !== undefined,
  );
  const controller = new AbortController();
  const makeWorkerId = options.workerId ?? (() => randomUUID());
  const loops =
    eligibleTypes.length === 0
      ? []
      : Array.from({ length: options.concurrency }, (_, index) =>
          runWorkerSlot(database, handlers, eligibleTypes, {
            signal: controller.signal,
            workerId: `${makeWorkerId()}-${index + 1}`,
            pollIntervalMs,
            heartbeatIntervalMs,
            cancellationPollIntervalMs,
            retryBaseDelayMs,
            retryMaxDelayMs,
            log: options.log,
          }),
        );

  let stopping: Promise<void> | undefined;
  return {
    stop: () => {
      controller.abort();
      stopping ??= Promise.all(loops).then(() => undefined);
      return stopping;
    },
  };
}

interface WorkerSlotOptions {
  readonly signal: AbortSignal;
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly cancellationPollIntervalMs: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly log: WorkerLog;
}

/** Claims and processes jobs until shutdown, isolating failures to the individual job or poll cycle. */
async function runWorkerSlot(
  database: Kysely<Database>,
  handlers: JobHandlers,
  eligibleTypes: readonly JobType[],
  options: WorkerSlotOptions,
): Promise<void> {
  while (!options.signal.aborted) {
    try {
      const processed = await database.connection().execute(async (session) => {
        const job = await claimNextJob(session, options.workerId, eligibleTypes);
        if (job === null) return false;
        await processClaimedJob(session, job, handlers[job.type], options);
        return true;
      });
      if (!processed) await pause(options.pollIntervalMs, options.signal);
    } catch (error) {
      options.log.warn(
        { err: error, workerId: options.workerId },
        'job worker cycle failed; worker will retry',
      );
      await pause(options.pollIntervalMs, options.signal);
    }
  }
}

/** Processes one claimed row while retaining its lock, heartbeating, reporting progress and honoring cancellation. */
async function processClaimedJob(
  session: Kysely<Database>,
  job: Job,
  handler: JobHandler | undefined,
  options: WorkerSlotOptions,
): Promise<void> {
  const acquired = await tryAcquireJobLock(session, job.id);
  if (!acquired) {
    options.log.warn({ jobId: job.id }, 'job advisory lock was busy; returning claim to queue');
    await returnUnstartedClaim(session, job, options.workerId, options.pollIntervalMs);
    return;
  }

  const ownership = new AbortController();
  let heartbeatError: unknown;
  const heartbeat = startHeartbeat(session, job, options, ownership, (error) => {
    heartbeatError = error;
  });
  const cancellation = monitorJobCancellation(session, job, options.workerId, ownership, {
    intervalMs: options.cancellationPollIntervalMs,
    log: options.log,
  });
  const progress = createJobProgressReporter(session, job, options.workerId);

  try {
    let result: JsonValue | void = undefined;
    let handlerFailed = false;
    let handlerError: unknown;
    try {
      if (handler === undefined) throw new Error('claimed job has no registered handler');
      result = await handler(job, {
        database: session,
        signal: ownership.signal,
        reportProgress: progress.report,
      });
    } catch (error) {
      handlerFailed = true;
      handlerError = error;
    }

    await Promise.all([heartbeat.stop(), cancellation.stop()]);
    await progress.flush();

    if (cancellation.requested()) {
      await markCanceled(session, job, options.workerId);
      return;
    }
    if (heartbeatError !== undefined || cancellation.ownershipLost()) {
      options.log.warn(
        { err: heartbeatError, jobId: job.id, type: job.type },
        'job ownership was lost; leaving job for reaper recovery',
      );
      return;
    }

    if (handlerFailed) {
      options.log.error({ err: handlerError, jobId: job.id, type: job.type }, 'job handler failed');
      const persisted = await markFailed(
        session,
        job,
        options.workerId,
        options.retryBaseDelayMs,
        options.retryMaxDelayMs,
      );
      if (!persisted)
        await finishConcurrentCancellation(session, job, options.workerId, options.log);
      return;
    }

    const persisted = await markSucceeded(session, job, options.workerId, result ?? null);
    if (!persisted) await finishConcurrentCancellation(session, job, options.workerId, options.log);
  } finally {
    try {
      await Promise.all([heartbeat.stop(), cancellation.stop(), progress.stop()]);
    } finally {
      await releaseJobLock(session, job.id);
    }
  }
}

/** Starts a non-overlapping heartbeat timer that refreshes `locked_at` independently of handler progress. */
function startHeartbeat(
  session: Kysely<Database>,
  job: Job,
  options: WorkerSlotOptions,
  ownership: AbortController,
  onFailure: (error: unknown) => void,
): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const schedule = (): void => {
    timer = setTimeout(() => {
      inFlight = (async () => {
        try {
          const owned = await refreshHeartbeat(session, job, options.workerId);
          if (!owned) throw new Error('job row is no longer owned by this worker');
        } catch (error) {
          onFailure(error);
          if (!ownership.signal.aborted) ownership.abort(new JobOwnershipLostError(job.id));
          options.log.warn({ err: error, jobId: job.id }, 'job heartbeat failed');
        }
      })().finally(() => {
        inFlight = undefined;
        if (!stopped) schedule();
      });
    }, options.heartbeatIntervalMs);
    timer.unref?.();
  };
  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight;
    },
  };
}

/** Extends the lease timestamp only while the same worker still owns a running row. */
async function refreshHeartbeat(
  session: Kysely<Database>,
  job: Job,
  workerId: string,
): Promise<boolean> {
  const row = await session
    .updateTable('jobs')
    .set({ locked_at: sql`now()` })
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .where('locked_by', '=', workerId)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** Marks success only while this worker owns the row and no cancellation request won the race. */
async function markSucceeded(
  session: Kysely<Database>,
  job: Job,
  workerId: string,
  result: JsonValue | null,
): Promise<boolean> {
  const row = await session
    .updateTable('jobs')
    .set({
      status: 'succeeded',
      result,
      error_code: null,
      error_message: null,
      finished_at: sql`now()`,
      locked_by: null,
      locked_at: null,
    })
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .where('locked_by', '=', workerId)
    .where('cancel_requested', '=', false)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** Retries a failed attempt after bounded exponential backoff, or marks it terminal after max_attempts. */
async function markFailed(
  session: Kysely<Database>,
  job: Job,
  workerId: string,
  retryBaseDelayMs?: number,
  retryMaxDelayMs?: number,
): Promise<boolean> {
  const retry = job.attempts < job.max_attempts;
  const delayMs = retry ? jobRetryDelayMs(job.attempts, retryBaseDelayMs, retryMaxDelayMs) : 0;
  const row = await session
    .updateTable('jobs')
    .set({
      status: retry ? 'queued' : 'failed',
      run_after: retry ? sql`now() + ${delayMs} * interval '1 millisecond'` : job.run_after,
      error_code: FAILED_ERROR_CODE,
      error_message: FAILED_ERROR_MESSAGE,
      finished_at: retry ? null : sql`now()`,
      locked_by: null,
      locked_at: null,
    })
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .where('locked_by', '=', workerId)
    .where('cancel_requested', '=', false)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** Marks the active job canceled only after its handler has observed cancellation and returned from cleanup. */
async function markCanceled(session: Kysely<Database>, job: Job, workerId: string): Promise<void> {
  await session
    .updateTable('jobs')
    .set({
      status: 'canceled',
      result: null,
      error_code: null,
      error_message: null,
      cancel_requested: true,
      finished_at: sql`now()`,
      locked_by: null,
      locked_at: null,
    })
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .where('locked_by', '=', workerId)
    .execute();
}

/** Closes a cancellation request that committed while a worker was persisting success/failure. */
async function finishConcurrentCancellation(
  session: Kysely<Database>,
  job: Job,
  workerId: string,
  log: WorkerLog,
): Promise<void> {
  const current = await session
    .selectFrom('jobs')
    .select(['status', 'cancel_requested', 'locked_by'])
    .where('id', '=', job.id)
    .executeTakeFirst();
  if (current?.status === 'running' && current.cancel_requested && current.locked_by === workerId) {
    await markCanceled(session, job, workerId);
    return;
  }
  log.warn(
    { jobId: job.id, status: current?.status },
    'job terminal update lost its ownership condition',
  );
}

/** Returns an unstarted claim to the queue without consuming an attempt. */
async function returnUnstartedClaim(
  session: Kysely<Database>,
  job: Job,
  workerId: string,
  delayMs: number,
): Promise<void> {
  await session
    .updateTable('jobs')
    .set({
      status: 'queued',
      attempts: sql`greatest(attempts - 1, 0)`,
      run_after: sql`now() + ${delayMs} * interval '1 millisecond'`,
      locked_by: null,
      locked_at: null,
      started_at: null,
    })
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .where('locked_by', '=', workerId)
    .execute();
}

/** Validates a timer interval before worker slots are started. */
function validateInterval(milliseconds: number, name: string): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/** Waits for the poll delay, or wakes immediately when shutdown aborts it. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}
