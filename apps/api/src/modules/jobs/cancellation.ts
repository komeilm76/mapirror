/**
 * Cooperative job cancellation requests and the worker-side cancellation poller (`P2-JOB-03`).
 *
 * Queued jobs are canceled immediately. A running job keeps its `running` status and advisory-lock owner while the
 * handler reacts to its AbortSignal and cleans temporary resources; only the owning worker writes the terminal state.
 *
 * @module modules/jobs/cancellation
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database, Job, JobStatus } from '../../db/schema';
import type { WorkerLog } from './worker';

/** Result of asking for cancellation. */
export interface JobCancellationResult {
  /** `false` only when no row exists for the requested id. */
  readonly found: boolean;
  /** The persisted status after the request, or `null` when not found. */
  readonly status: JobStatus | null;
  /** `true` when this call requested cancellation or the job was already canceled. */
  readonly accepted: boolean;
}

/** Identifies an operator-requested cancellation to a cooperative handler. */
export class JobCancellationRequestedError extends Error {
  constructor(jobId: string) {
    super(`Cancellation requested for job ${jobId}`);
    this.name = 'JobCancellationRequestedError';
  }
}

/** Identifies loss of row ownership to a cooperative handler. The reaper owns subsequent recovery. */
export class JobOwnershipLostError extends Error {
  constructor(jobId: string) {
    super(`Worker ownership lost for job ${jobId}`);
    this.name = 'JobOwnershipLostError';
  }
}

/**
 * Requests cancellation without stealing the running worker's terminal-state write.
 *
 * A queued job is immediately terminal and can no longer be claimed. A running job gets only the durable request bit;
 * its worker observes that bit, aborts the handler signal, waits for cooperative cleanup, then marks it canceled.
 * Terminal succeeded/failed jobs are not changed. Repeating a request for an already canceled job is idempotently
 * accepted.
 *
 * @param database - Kysely database handle.
 * @param jobId - Durable job id.
 * @returns Whether the row exists, its current state, and whether cancellation was accepted.
 */
export async function requestJobCancellation(
  database: Kysely<Database>,
  jobId: string,
): Promise<JobCancellationResult> {
  if (jobId.trim().length === 0) throw new TypeError('jobId must not be empty');

  const updated = await database
    .updateTable('jobs')
    .set({
      cancel_requested: true,
      status: sql<JobStatus>`case when status = 'queued' then 'canceled'::job_status else status end`,
      finished_at: sql`case when status = 'queued' then now() else finished_at end`,
      locked_by: sql`case when status = 'queued' then null else locked_by end`,
      locked_at: sql`case when status = 'queued' then null else locked_at end`,
    })
    .where('id', '=', jobId)
    .where('status', 'in', ['queued', 'running'])
    .returning('status')
    .executeTakeFirst();

  if (updated !== undefined) return { found: true, status: updated.status, accepted: true };

  const existing = await database
    .selectFrom('jobs')
    .select('status')
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (existing === undefined) return { found: false, status: null, accepted: false };
  return {
    found: true,
    status: existing.status,
    accepted: existing.status === 'canceled',
  };
}

/** Options for the worker-side durable cancellation poll. */
export interface JobCancellationMonitorOptions {
  /** Poll frequency. Production uses 250 ms, comfortably within the two-second cancellation target. */
  readonly intervalMs: number;
  /** Worker logger. */
  readonly log: WorkerLog;
}

/** State and shutdown control for a running job's cancellation monitor. */
export interface JobCancellationMonitor {
  /** True once the persisted request bit has been observed. */
  readonly requested: () => boolean;
  /** True if the job row stopped being owned by this worker. */
  readonly ownershipLost: () => boolean;
  /** Stops future polls and waits for an in-flight query. */
  readonly stop: () => Promise<void>;
}

/**
 * Polls the running row for `cancel_requested` on the worker's pinned session.
 *
 * The database signal is durable, so process-local events are not required and an API process can request cancellation
 * regardless of which process owns the job. Query failures are logged and retried on the next short interval.
 *
 * @param session - Kysely instance pinned to the job-lock connection.
 * @param job - Claimed job snapshot.
 * @param workerId - Worker-slot owner token.
 * @param ownership - Abort controller shared with the handler.
 * @param options - Poll cadence and logger.
 * @returns Monitor state and a stop method.
 */
export function monitorJobCancellation(
  session: Kysely<Database>,
  job: Job,
  workerId: string,
  ownership: AbortController,
  options: JobCancellationMonitorOptions,
): JobCancellationMonitor {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new RangeError('job cancellation poll interval must be a positive safe integer');
  }

  let stopped = false;
  let requested = job.cancel_requested;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const requestAbort = (): void => {
    if (!ownership.signal.aborted) ownership.abort(new JobCancellationRequestedError(job.id));
  };
  if (requested) requestAbort();

  const schedule = (): void => {
    if (stopped || requested || lost) return;
    timer = setTimeout(() => {
      inFlight = (async () => {
        try {
          const row = await session
            .selectFrom('jobs')
            .select('cancel_requested')
            .where('id', '=', job.id)
            .where('status', '=', 'running')
            .where('locked_by', '=', workerId)
            .executeTakeFirst();
          if (row === undefined) {
            lost = true;
            if (!ownership.signal.aborted) ownership.abort(new JobOwnershipLostError(job.id));
          } else if (row.cancel_requested) {
            requested = true;
            requestAbort();
          }
        } catch (error) {
          options.log.warn(
            { err: error, jobId: job.id },
            'job cancellation poll failed; worker will retry',
          );
        }
      })().finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, options.intervalMs);
    timer.unref?.();
  };
  schedule();

  return {
    requested: () => requested,
    ownershipLost: () => lost,
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight;
    },
  };
}
