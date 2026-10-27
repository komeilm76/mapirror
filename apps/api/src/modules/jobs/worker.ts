/**
 * PostgreSQL-backed job claiming and the in-process worker pool (`P2-JOB-01`).
 *
 * Each claim is one atomic CTE + `UPDATE … FROM … RETURNING` statement whose candidate row is selected with
 * `FOR UPDATE SKIP LOCKED`. Competing
 * workers therefore take different queued rows without a process-local mutex, Redis, or a transaction left open while
 * a handler runs. The API process owns the pool; handlers are registered by job type as their tasks land.
 *
 * Unregistered job types remain queued rather than being claimed and failed before their handler exists. A handler
 * failure is logged and persisted as one generic client-safe error; retry/reaping, heartbeats, cancellation and
 * payload validation belong to later job tasks.
 *
 * @module modules/jobs/worker
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { MAX_WORKER_CONCURRENCY } from '../../config/limits';
import type { Database, Job, JobType, JsonValue } from '../../db/schema';

/** A handler receives a claimed row and may return JSON to store as its result. */
export type JobHandler = (job: Job) => Promise<JsonValue | void>;

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
 * Stopping aborts an idle poll immediately but lets a handler already in progress finish before resolving. Database
 * errors do not kill a slot: it warns, backs off for the poll interval, and tries again. Job execution itself is never
 * inside the claim transaction.
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
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError('worker poll interval must be a positive safe integer');
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
    let job: Job | null;
    try {
      job = await claimNextJob(database, options.workerId, eligibleTypes);
    } catch (error) {
      options.log.warn(
        { err: error, workerId: options.workerId },
        'job claim failed; worker will retry',
      );
      await pause(options.pollIntervalMs, options.signal);
      continue;
    }

    if (job === null) {
      await pause(options.pollIntervalMs, options.signal);
      continue;
    }

    const handler = handlers[job.type];
    // The eligible type list is derived from this same immutable handler map. Keep the guard anyway so a future
    // mutable registry cannot turn a claimed row into an unhandled, permanently-running job.
    if (handler === undefined) {
      options.log.error({ jobId: job.id, type: job.type }, 'claimed job has no registered handler');
      try {
        await markFailed(database, job, options.workerId);
      } catch (error) {
        options.log.error(
          { err: error, jobId: job.id, type: job.type },
          'could not persist job failure',
        );
      }
      continue;
    }

    let result: JsonValue | void;
    try {
      result = await handler(job);
    } catch (error) {
      options.log.error({ err: error, jobId: job.id, type: job.type }, 'job handler failed');
      try {
        await markFailed(database, job, options.workerId);
      } catch (persistError) {
        options.log.error(
          { err: persistError, jobId: job.id, type: job.type },
          'could not persist job failure',
        );
      }
      continue;
    }

    try {
      await markSucceeded(database, job, options.workerId, result ?? null);
    } catch (error) {
      // Do not misreport a completed handler as a handler failure when only the terminal database write failed.
      // Job recovery is the reaper's concern (`P2-JOB-02`).
      options.log.error(
        { err: error, jobId: job.id, type: job.type },
        'could not persist job success',
      );
    }
  }
}

/** Marks the job successful only while this worker still owns its running row. */
async function markSucceeded(
  database: Kysely<Database>,
  job: Job,
  workerId: string,
  result: JsonValue | null,
): Promise<void> {
  await database
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
    .execute();
}

/** Marks the job failed with a safe message; detailed errors remain in the application log. */
async function markFailed(database: Kysely<Database>, job: Job, workerId: string): Promise<void> {
  await database
    .updateTable('jobs')
    .set({
      status: 'failed',
      error_code: FAILED_ERROR_CODE,
      error_message: FAILED_ERROR_MESSAGE,
      finished_at: sql`now()`,
      locked_by: null,
      locked_at: null,
    })
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .where('locked_by', '=', workerId)
    .execute();
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
