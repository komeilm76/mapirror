/** PostgreSQL-backed interval claiming and periodic scheduling (`P4-INT-03`).
 *
 * Due schedules are claimed with `FOR UPDATE SKIP LOCKED`. A run, its per-country download jobs/items, and the next
 * occurrence are written in one transaction; an enqueue failure rolls all of them back, leaving the occurrence due
 * for a later pass. Cache-country advisory locks serialize each scheduled country's enqueue with whole-country cache deletion.
 *
 * @module modules/intervals/scheduler
 */

import { sql, type Kysely } from 'kysely';

import { lockCountryCacheForEnqueue } from '../../db/repositories/cache';
import type { RepositoryExecutor } from '../../db/repositories/executor';
import type { Database } from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import { nextRunAt, type IntervalSchedule } from '../../lib/time';
import { enqueueDownloadJobInTransaction } from '../jobs/enqueue-download';

/** Scheduler cadence from `02-architecture.md` §5. */
export const INTERVAL_SCHEDULER_INTERVAL_MS = 30_000;

/** Logger methods needed by the interval scheduler. */
export interface IntervalSchedulerLog {
  readonly info: (context: object, message: string) => void;
  readonly warn: (context: object, message: string) => void;
  readonly error: (context: object, message: string) => void;
}

/** Periodic scheduler options; timing is injectable for deterministic lifecycle tests. */
export interface IntervalSchedulerOptions {
  readonly pollIntervalMs?: number;
  readonly log: IntervalSchedulerLog;
}

/** Handle for the periodic interval scheduler. */
export interface IntervalScheduler {
  stop(): Promise<void>;
}

/** One committed scheduling pass. Failed intervals remain due and are retried on a later pass. */
export interface IntervalSchedulePassResult {
  readonly scheduled: number;
  readonly overlaps: number;
  readonly empty: number;
  readonly failed: number;
}

type ScheduledOutcome =
  | {
      readonly kind: 'scheduled';
      readonly intervalId: string;
      readonly runId: string;
      readonly countries: number;
    }
  | { readonly kind: 'overlap'; readonly intervalId: string; readonly activeRunId: string }
  | { readonly kind: 'empty'; readonly intervalId: string; readonly runId: string };

/** A transaction failure after the interval row was claimed; its ID is excluded for the rest of this pass. */
class ClaimedIntervalError extends Error {
  constructor(
    readonly intervalId: string,
    cause: unknown,
  ) {
    super('The interval scheduling transaction failed.', { cause });
    this.name = 'ClaimedIntervalError';
  }
}

/**
 * Claims and processes every currently due interval once, leaving failed occurrences due for the next pass.
 *
 * Processing continues past one failed interval so it cannot starve other due schedules. The failed row is excluded
 * only for this pass; its transaction is rolled back and the next polling pass retries it unchanged.
 *
 * @param database - Process Kysely handle.
 * @param log - Scheduler logger.
 * @param signal - Optional cooperative stop signal checked between transactions.
 * @returns Counts for schedules, overlap skips, empty schedules and transaction failures.
 */
export async function scheduleDueIntervalsOnce(
  database: Kysely<Database>,
  log: IntervalSchedulerLog,
  signal?: AbortSignal,
): Promise<IntervalSchedulePassResult> {
  const excludedIntervalIds = new Set<string>();
  const result = { scheduled: 0, overlaps: 0, empty: 0, failed: 0 };

  while (!signal?.aborted) {
    let outcome: ScheduledOutcome | null;
    try {
      outcome = await scheduleOneDueInterval(database, excludedIntervalIds);
    } catch (error) {
      if (!(error instanceof ClaimedIntervalError)) throw error;
      excludedIntervalIds.add(error.intervalId);
      result.failed += 1;
      log.warn(
        { err: error.cause, intervalId: error.intervalId },
        'interval scheduling transaction rolled back; occurrence remains due for retry',
      );
      continue;
    }

    if (outcome === null) break;
    if (outcome.kind === 'overlap') {
      result.overlaps += 1;
      log.warn(
        {
          code: 'SKIPPED_OVERLAP',
          intervalId: outcome.intervalId,
          activeRunId: outcome.activeRunId,
        },
        'interval occurrence skipped because its previous run is still active',
      );
    } else if (outcome.kind === 'empty') {
      result.empty += 1;
      log.info(
        { intervalId: outcome.intervalId, runId: outcome.runId },
        'empty interval occurrence recorded as succeeded',
      );
    } else {
      result.scheduled += 1;
      log.info(
        { intervalId: outcome.intervalId, runId: outcome.runId, countryCount: outcome.countries },
        'interval run and country download jobs scheduled',
      );
    }
  }

  return result;
}

/** Starts an immediate pass followed by non-overlapping polling passes until stopped. */
export function startIntervalScheduler(
  database: Kysely<Database>,
  options: IntervalSchedulerOptions,
): IntervalScheduler {
  const pollIntervalMs = options.pollIntervalMs ?? INTERVAL_SCHEDULER_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError(
      `interval scheduler poll interval must be a positive integer, got ${pollIntervalMs}`,
    );
  }

  const controller = new AbortController();
  const loop = runScheduler(database, options.log, pollIntervalMs, controller.signal);
  let stopping: Promise<void> | undefined;
  return {
    stop: () => {
      controller.abort();
      stopping ??= loop;
      return stopping;
    },
  };
}

async function scheduleOneDueInterval(
  database: Kysely<Database>,
  excludedIntervalIds: ReadonlySet<string>,
): Promise<ScheduledOutcome | null> {
  let claimedIntervalId: string | undefined;

  try {
    return await withTransaction(database, async (trx) => {
      claimedIntervalId = undefined;
      const clock = await sql<{ database_now: Date }>`select now() as database_now`.execute(trx);
      const now = clock.rows[0]!.database_now;
      let query = trx
        .selectFrom('intervals')
        .selectAll()
        .where('enabled', '=', true)
        .where('next_run_at', '<=', now)
        .orderBy('next_run_at', 'asc')
        .orderBy('id', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked();
      if (excludedIntervalIds.size > 0) {
        query = query.where('id', 'not in', [...excludedIntervalIds]);
      }
      const interval = await query.executeTakeFirst();
      if (interval === undefined) return null;
      claimedIntervalId = interval.id;

      const activeRun = await trx
        .selectFrom('interval_runs')
        .select('id')
        .where('interval_id', '=', interval.id)
        .where('status', '=', 'running')
        .executeTakeFirst();
      if (activeRun !== undefined) {
        const next = await computeNextFromDatabaseClock(trx, interval);
        await trx
          .updateTable('intervals')
          .set({ next_run_at: next })
          .where('id', '=', interval.id)
          .executeTakeFirst();
        return { kind: 'overlap', intervalId: interval.id, activeRunId: activeRun.id };
      }

      // Read membership first, then take the same advisory locks as normal download admission in sorted order.
      // Re-read current membership after locking; enqueueing each country remains serialized with cache deletion.
      const initialMemberships = await trx
        .selectFrom('interval_countries')
        .select('country_id')
        .where('interval_id', '=', interval.id)
        .orderBy('country_id', 'asc')
        .execute();
      for (const membership of initialMemberships) {
        await lockCountryCacheForEnqueue(trx, membership.country_id);
      }
      const countries = await trx
        .selectFrom('interval_countries')
        .innerJoin('countries', 'countries.id', 'interval_countries.country_id')
        .select([
          'countries.id as country_id',
          'countries.slug as country_slug',
          'countries.name as country_name',
        ])
        .where('interval_countries.interval_id', '=', interval.id)
        .orderBy('countries.slug', 'asc')
        .orderBy('countries.id', 'asc')
        .execute();

      const run = await trx
        .insertInto('interval_runs')
        .values({
          interval_id: interval.id,
          triggered_by: 'schedule',
          countries_total: countries.length,
          ...(countries.length === 0 ? { status: 'succeeded' as const, finished_at: now } : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      for (const country of countries) {
        const jobId = await enqueueDownloadJobInTransaction(trx, {
          countryId: country.country_id,
          version: 'latest',
          origin: 'geofabrik_latest',
          onlyIfChanged: interval.only_if_changed,
          ...(interval.created_by === null ? {} : { createdBy: interval.created_by }),
        });
        await trx
          .insertInto('interval_run_items')
          .values({
            run_id: run.id,
            country_id: country.country_id,
            country_slug: country.country_slug,
            country_name: country.country_name,
            job_id: jobId,
          })
          .execute();
      }

      const next = await computeNextFromDatabaseClock(trx, interval);
      await trx
        .updateTable('intervals')
        .set({ next_run_at: next })
        .where('id', '=', interval.id)
        .executeTakeFirst();

      return countries.length === 0
        ? { kind: 'empty', intervalId: interval.id, runId: run.id }
        : {
            kind: 'scheduled',
            intervalId: interval.id,
            runId: run.id,
            countries: countries.length,
          };
    });
  } catch (error) {
    if (claimedIntervalId !== undefined) throw new ClaimedIntervalError(claimedIntervalId, error);
    throw error;
  }
}

async function computeNextFromDatabaseClock(
  executor: RepositoryExecutor,
  interval: IntervalSchedule,
): Promise<Date> {
  const clock = await sql<{ schedule_now: Date }>`
    select clock_timestamp() as schedule_now
  `.execute(executor);
  return nextRunAt(interval, clock.rows[0]!.schedule_now);
}

async function runScheduler(
  database: Kysely<Database>,
  log: IntervalSchedulerLog,
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await scheduleDueIntervalsOnce(database, log, signal);
    } catch (error) {
      log.error({ err: error }, 'interval scheduler pass failed; scheduler will retry');
    }
    await pause(pollIntervalMs, signal);
  }
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}
