/** Admin interval schedule list and CRUD handlers (`P4-INT-04`).
 *
 * @module modules/admin/intervals-route
 */

import {
  IntervalCreateBodySchema,
  IntervalDeleteQuerySchema,
  IntervalListResponseSchema,
  IntervalMutationResponseSchema,
  IntervalParamsSchema,
  IntervalUpdateBodySchema,
  IntervalViewSchema,
  type IntervalView,
} from '@mapirror/shared';
import { sql } from 'kysely';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Interval, IntervalFrequency } from '../../db/schema';
import type { RepositoryExecutor } from '../../db/repositories/executor';
import { AUDIT_ACTIONS, insertAuditLog } from '../../db/repositories/audit-logs';
import { withTransaction } from '../../db/transaction';
import { nextRunAt, type IntervalSchedule } from '../../lib/time';
import { normaliseIp } from '../../lib/client-ip';
import { AppError } from '../../lib/errors';

interface IntervalPath {
  readonly id: string;
}

interface IntervalQuery {
  readonly force?: 'true' | 'false';
}

interface IntervalScheduleFields {
  readonly frequency: IntervalFrequency;
  readonly timeOfDay: string;
  readonly weekday: number | null;
  readonly dayOfMonth: number | null;
}

/** Handles `GET /_admin/api/intervals` from one repeatable-read snapshot. */
export async function getIntervals(request: FastifyRequest) {
  const data = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const rows = await trx
        .selectFrom('intervals')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      return loadIntervalViews(trx, rows);
    });
  return IntervalListResponseSchema.parse({ data });
}

/** Creates a schedule and its country memberships atomically. */
export async function postInterval(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ interval: IntervalView }> {
  const parsed = IntervalCreateBodySchema.safeParse(request.body);
  if (!parsed.success) throw parsed.error;
  const body = parsed.data;
  const schedule = normalizeCreateSchedule(body);
  assertCountriesProvided(body.countryIds);

  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  const interval = await withTransaction(request.server.db.db, async (trx) => {
    await assertCountriesExist(trx, body.countryIds);
    const now = await databaseClock(trx);
    const next = nextRunAt(asIntervalSchedule(schedule), now);
    const inserted = await trx
      .insertInto('intervals')
      .values({
        name: body.name,
        frequency: schedule.frequency,
        time_of_day: schedule.timeOfDay,
        weekday: schedule.weekday,
        day_of_month: schedule.dayOfMonth,
        keep_versions: body.keepVersions ?? 3,
        only_if_changed: body.onlyIfChanged ?? true,
        enabled: body.enabled ?? true,
        next_run_at: next,
        created_by: admin.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('interval_countries')
      .values(body.countryIds.map((country_id) => ({ interval_id: inserted.id, country_id })))
      .execute();
    await insertAuditLog(trx, {
      actorId: admin.id,
      actorName: admin.username,
      action: AUDIT_ACTIONS.intervalCreate,
      targetType: 'interval',
      targetId: inserted.id,
      ip: normaliseIp(request.ip),
      metadata: {
        name: body.name,
        frequency: schedule.frequency,
        countryIds: body.countryIds,
        enabled: body.enabled ?? true,
      },
    });
    const views = await loadIntervalViews(trx, [
      await trx
        .selectFrom('intervals')
        .selectAll()
        .where('id', '=', inserted.id)
        .executeTakeFirstOrThrow(),
    ]);
    return views[0]!;
  });

  reply.code(201);
  return IntervalMutationResponseSchema.parse({ interval });
}

/** Updates schedule fields and/or memberships under the interval row lock. */
export async function patchInterval(
  request: FastifyRequest<{ Params: IntervalPath }>,
): Promise<{ interval: IntervalView }> {
  const params = IntervalParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;
  const parsed = IntervalUpdateBodySchema.safeParse(request.body);
  if (!parsed.success) throw parsed.error;
  const body = parsed.data;
  if (body.confirm !== undefined && body.enabled !== false) {
    throw semanticError('confirm may only accompany enabled=false.');
  }
  if (body.countryIds !== undefined) assertCountriesProvided(body.countryIds);

  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  const interval = await withTransaction(request.server.db.db, async (trx) => {
    const current = await trx
      .selectFrom('intervals')
      .selectAll()
      .where('id', '=', params.data.id)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) throw intervalNotFound();

    const beforeCountryIds = await listCountryIds(trx, current.id);
    const schedule = normalizeUpdatedSchedule(current, body);
    const scheduleChanged =
      body.frequency !== undefined ||
      body.timeOfDay !== undefined ||
      body.weekday !== undefined ||
      body.dayOfMonth !== undefined;
    const reenabled = body.enabled === true && !current.enabled;

    let activeRunId: string | undefined;
    if (body.enabled === false && current.enabled) {
      const activeRun = await trx
        .selectFrom('interval_runs')
        .select('id')
        .where('interval_id', '=', current.id)
        .where('status', '=', 'running')
        .forUpdate()
        .executeTakeFirst();
      if (activeRun !== undefined) {
        activeRunId = activeRun.id;
        if (body.confirm !== true) {
          throw new AppError(
            'CONFIRMATION_REQUIRED',
            'This interval has a run in progress. Confirm pausing the schedule while that run continues.',
            { intervalId: current.id, runId: activeRun.id },
          );
        }
      }
    }

    if (body.countryIds !== undefined) await assertCountriesExist(trx, body.countryIds);
    const nextRun =
      scheduleChanged || reenabled
        ? nextRunAt(asIntervalSchedule(schedule), await databaseClock(trx))
        : current.next_run_at;
    await trx
      .updateTable('intervals')
      .set({
        name: body.name ?? current.name,
        frequency: schedule.frequency,
        time_of_day: schedule.timeOfDay,
        weekday: schedule.weekday,
        day_of_month: schedule.dayOfMonth,
        ...(body.keepVersions === undefined ? {} : { keep_versions: body.keepVersions }),
        ...(body.onlyIfChanged === undefined ? {} : { only_if_changed: body.onlyIfChanged }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        next_run_at: nextRun,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', current.id)
      .execute();

    if (body.countryIds !== undefined) {
      await trx.deleteFrom('interval_countries').where('interval_id', '=', current.id).execute();
      await trx
        .insertInto('interval_countries')
        .values(body.countryIds.map((country_id) => ({ interval_id: current.id, country_id })))
        .execute();
    }

    const afterCountryIds = body.countryIds ?? beforeCountryIds;
    await insertAuditLog(trx, {
      actorId: admin.id,
      actorName: admin.username,
      action: AUDIT_ACTIONS.intervalUpdate,
      targetType: 'interval',
      targetId: current.id,
      ip: normaliseIp(request.ip),
      metadata: {
        before: {
          name: current.name,
          frequency: current.frequency,
          enabled: current.enabled,
          countryIds: beforeCountryIds,
        },
        after: {
          name: body.name ?? current.name,
          frequency: schedule.frequency,
          enabled: body.enabled ?? current.enabled,
          countryIds: afterCountryIds,
        },
        ...(activeRunId === undefined ? {} : { activeRunId }),
      },
    });

    const updated = await trx
      .selectFrom('intervals')
      .selectAll()
      .where('id', '=', current.id)
      .executeTakeFirstOrThrow();
    return (await loadIntervalViews(trx, [updated]))[0]!;
  });

  return IntervalMutationResponseSchema.parse({ interval });
}

/** Hard-deletes a schedule and its cascaded run history; force is required when a run is active. */
export async function deleteInterval(
  request: FastifyRequest<{ Params: IntervalPath; Querystring: IntervalQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const params = IntervalParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;
  const query = IntervalDeleteQuerySchema.safeParse(request.query);
  if (!query.success) throw query.error;

  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  await withTransaction(request.server.db.db, async (trx) => {
    const interval = await trx
      .selectFrom('intervals')
      .select(['id', 'name', 'frequency', 'enabled'])
      .where('id', '=', params.data.id)
      .forUpdate()
      .executeTakeFirst();
    if (interval === undefined) throw intervalNotFound();

    const activeRun = await trx
      .selectFrom('interval_runs')
      .select('id')
      .where('interval_id', '=', interval.id)
      .where('status', '=', 'running')
      .forUpdate()
      .executeTakeFirst();
    const force = query.data.force === 'true';
    if (activeRun !== undefined && !force) {
      throw new AppError(
        'JOB_ALREADY_RUNNING',
        'This interval has a run in progress. Wait for it to finish or retry with force=true.',
        { intervalId: interval.id, runId: activeRun.id },
      );
    }
    if (activeRun !== undefined) {
      await trx
        .updateTable('interval_runs')
        .set({
          status: 'failed',
          finished_at: sql<Date>`now()`,
          error_message: 'Interval was force-deleted while its run was active.',
        })
        .where('id', '=', activeRun.id)
        .where('status', '=', 'running')
        .execute();
    }

    await insertAuditLog(trx, {
      actorId: admin.id,
      actorName: admin.username,
      action: AUDIT_ACTIONS.intervalDelete,
      targetType: 'interval',
      targetId: interval.id,
      ip: normaliseIp(request.ip),
      metadata: {
        name: interval.name,
        frequency: interval.frequency,
        enabled: interval.enabled,
        force,
        ...(activeRun === undefined ? {} : { activeRunId: activeRun.id }),
      },
    });
    await trx.deleteFrom('intervals').where('id', '=', interval.id).execute();
  });

  reply.code(204);
}

async function loadIntervalViews(
  executor: RepositoryExecutor,
  rows: readonly Interval[],
): Promise<IntervalView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(({ id }) => id);
  const [memberships, recentRuns] = await Promise.all([
    executor
      .selectFrom('interval_countries')
      .innerJoin('countries', 'countries.id', 'interval_countries.country_id')
      .select([
        'interval_countries.interval_id',
        'countries.id as country_id',
        'countries.name as country_name',
        'countries.slug as country_slug',
      ])
      .where('interval_countries.interval_id', 'in', ids)
      .orderBy('countries.slug', 'asc')
      .orderBy('countries.id', 'asc')
      .execute(),
    executor
      .selectFrom('interval_runs')
      .select(['id', 'interval_id', 'status', 'started_at', 'finished_at'])
      .distinctOn('interval_id')
      .where('interval_id', 'in', ids)
      .orderBy('interval_id', 'asc')
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .execute(),
  ]);
  const countriesByInterval = new Map<string, IntervalView['countries']>();
  for (const membership of memberships) {
    const countries = countriesByInterval.get(membership.interval_id) ?? [];
    countries.push({
      countryId: membership.country_id,
      name: membership.country_name,
      slug: membership.country_slug,
    });
    countriesByInterval.set(membership.interval_id, countries);
  }
  const runsByInterval = new Map(
    recentRuns.map((run) => [
      run.interval_id,
      {
        id: run.id,
        status: run.status,
        startedAt: run.started_at.toISOString(),
        finishedAt: run.finished_at?.toISOString() ?? null,
      },
    ]),
  );

  return rows.map((row) =>
    IntervalViewSchema.parse({
      id: row.id,
      name: row.name,
      frequency: row.frequency,
      timeOfDay: row.time_of_day.slice(0, 5),
      weekday: row.weekday,
      dayOfMonth: row.day_of_month,
      countries: countriesByInterval.get(row.id) ?? [],
      keepVersions: row.keep_versions,
      onlyIfChanged: row.only_if_changed,
      enabled: row.enabled,
      nextRunAt: row.next_run_at.toISOString(),
      lastRun: runsByInterval.get(row.id) ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }),
  );
}

function normalizeCreateSchedule(
  body: ReturnType<typeof IntervalCreateBodySchema.parse>,
): IntervalScheduleFields {
  if (body.frequency === 'daily') {
    if (body.weekday !== undefined || body.dayOfMonth !== undefined) {
      throw invalidScheduleShape(body.frequency);
    }
    return {
      frequency: body.frequency,
      timeOfDay: body.timeOfDay ?? '03:00',
      weekday: null,
      dayOfMonth: null,
    };
  }
  if (body.frequency === 'weekly') {
    if (body.dayOfMonth !== undefined) throw invalidScheduleShape(body.frequency);
    return {
      frequency: body.frequency,
      timeOfDay: body.timeOfDay ?? '03:00',
      weekday: body.weekday ?? 1,
      dayOfMonth: null,
    };
  }
  if (body.weekday !== undefined) throw invalidScheduleShape(body.frequency);
  return {
    frequency: body.frequency,
    timeOfDay: body.timeOfDay ?? '03:00',
    weekday: null,
    dayOfMonth: body.dayOfMonth ?? 1,
  };
}

function normalizeUpdatedSchedule(
  current: Interval,
  body: ReturnType<typeof IntervalUpdateBodySchema.parse>,
): IntervalScheduleFields {
  const frequency = body.frequency ?? current.frequency;
  const frequencyChanged = frequency !== current.frequency;
  if (
    (frequency === 'daily' && (body.weekday !== undefined || body.dayOfMonth !== undefined)) ||
    (frequency === 'weekly' && body.dayOfMonth !== undefined) ||
    (frequency === 'monthly' && body.weekday !== undefined)
  ) {
    throw invalidScheduleShape(frequency);
  }

  return {
    frequency,
    timeOfDay: body.timeOfDay ?? current.time_of_day.slice(0, 5),
    weekday:
      frequency === 'weekly'
        ? (body.weekday ?? (frequencyChanged ? 1 : (current.weekday ?? 1)))
        : null,
    dayOfMonth:
      frequency === 'monthly'
        ? (body.dayOfMonth ?? (frequencyChanged ? 1 : (current.day_of_month ?? 1)))
        : null,
  };
}

function asIntervalSchedule(schedule: IntervalScheduleFields): IntervalSchedule {
  return {
    frequency: schedule.frequency,
    time_of_day: schedule.timeOfDay,
    weekday: schedule.weekday,
    day_of_month: schedule.dayOfMonth,
  };
}

function semanticError(message: string): AppError {
  return new AppError('SEMANTIC_ERROR', message);
}

function invalidScheduleShape(frequency: IntervalFrequency): AppError {
  return new AppError(
    'SEMANTIC_ERROR',
    'The weekday and dayOfMonth fields must match the selected frequency.',
    { frequency },
  );
}

function assertCountriesProvided(countryIds: readonly string[]): void {
  if (countryIds.length === 0) {
    throw new AppError('SEMANTIC_ERROR', 'Select at least one country for this interval.');
  }
}

async function assertCountriesExist(executor: RepositoryExecutor, countryIds: readonly string[]) {
  const countries = await executor
    .selectFrom('countries')
    .select('id')
    .where('id', 'in', countryIds)
    .orderBy('id', 'asc')
    .forKeyShare()
    .execute();
  if (countries.length !== countryIds.length) {
    const found = new Set(countries.map(({ id }) => id));
    throw new AppError('SEMANTIC_ERROR', 'One or more selected countries are not in the catalog.', {
      countryIds: countryIds.filter((id) => !found.has(id)),
    });
  }
}

async function listCountryIds(executor: RepositoryExecutor, intervalId: string): Promise<string[]> {
  const countries = await executor
    .selectFrom('interval_countries')
    .select('country_id')
    .where('interval_id', '=', intervalId)
    .orderBy('country_id', 'asc')
    .execute();
  return countries.map(({ country_id }) => country_id);
}

async function databaseClock(executor: RepositoryExecutor): Promise<Date> {
  const result = await sql<{
    database_now: Date;
  }>`select clock_timestamp() as database_now`.execute(executor);
  return result.rows[0]!.database_now;
}

function intervalNotFound(): AppError {
  return new AppError('NOT_FOUND', 'The requested interval does not exist.');
}
