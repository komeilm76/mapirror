/** Admin manual interval trigger, run history, and country outcome handlers (`P4-INT-05`).
 *
 * @module modules/admin/interval-runs-route
 */

import {
  buildPageMeta,
  IntervalRunDetailParamsSchema,
  IntervalRunDetailResponseSchema,
  IntervalRunListQuerySchema,
  IntervalRunListResponseSchema,
  IntervalRunNowBodySchema,
  IntervalRunNowResponseSchema,
  IntervalRunParamsSchema,
  IntervalRunViewSchema,
  IntervalRunItemViewSchema,
  parsePagination,
} from '@mapirror/shared';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { sql } from 'kysely';

import type { IntervalRun, IntervalRunItem } from '../../db/schema';
import { lockCountryCacheForEnqueue } from '../../db/repositories/cache';
import { AUDIT_ACTIONS, insertAuditLog } from '../../db/repositories/audit-logs';
import { withTransaction } from '../../db/transaction';
import { AppError } from '../../lib/errors';
import { normaliseIp } from '../../lib/client-ip';
import { enqueueDownloadJobInTransaction } from '../jobs/enqueue-download';

const DEFAULT_RUN_PAGE_SIZE = 25;
const MAX_RUN_PAGE_SIZE = 100;
const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

type IntervalRunListRow = IntervalRun & { interval_name: string };
type IntervalRunDetailRow = IntervalRun & { interval_name: string };

/** Starts a manual run, ignoring the schedule's enabled flag but respecting its single-active-run rule. */
export async function postIntervalRun(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const params = IntervalRunParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;
  const body = IntervalRunNowBodySchema.safeParse(request.body === undefined ? {} : request.body);
  if (!body.success) throw body.error;
  void body;

  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  let result: { runId: string; jobIds: string[] };
  try {
    result = await withTransaction(request.server.db.db, async (trx) => {
      const interval = await trx
        .selectFrom('intervals')
        .select(['id', 'only_if_changed'])
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
      if (activeRun !== undefined) {
        throw new AppError('JOB_ALREADY_RUNNING', 'This interval already has a run in progress.', {
          intervalId: interval.id,
          runId: activeRun.id,
        });
      }

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
          'countries.name as country_name',
          'countries.slug as country_slug',
        ])
        .where('interval_countries.interval_id', '=', interval.id)
        .orderBy('countries.slug', 'asc')
        .orderBy('countries.id', 'asc')
        .execute();

      const createdAt = await sql<{
        database_now: Date;
      }>`select clock_timestamp() as database_now`.execute(trx);
      const run = await trx
        .insertInto('interval_runs')
        .values({
          interval_id: interval.id,
          triggered_by: 'manual',
          countries_total: countries.length,
          ...(countries.length === 0
            ? { status: 'succeeded' as const, finished_at: createdAt.rows[0]!.database_now }
            : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const jobIds: string[] = [];
      for (const country of countries) {
        const jobId = await enqueueDownloadJobInTransaction(trx, {
          countryId: country.country_id,
          version: 'latest',
          origin: 'geofabrik_latest',
          onlyIfChanged: interval.only_if_changed,
          createdBy: admin.id,
        });
        jobIds.push(jobId);
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

      await insertAuditLog(trx, {
        actorId: admin.id,
        actorName: admin.username,
        action: AUDIT_ACTIONS.intervalRun,
        targetType: 'interval_run',
        targetId: run.id,
        ip: normaliseIp(request.ip),
        metadata: { intervalId: interval.id, jobIds, countryCount: countries.length },
      });

      return { runId: run.id, jobIds };
    });
  } catch (error) {
    if (isActiveDownloadUniqueViolation(error)) {
      throw new AppError(
        'JOB_ALREADY_RUNNING',
        'A download for one or more countries is already queued or running.',
        undefined,
        { cause: error },
      );
    }
    throw error;
  }

  reply.code(202);
  return IntervalRunNowResponseSchema.parse(result);
}

/** Returns one interval's run history from a consistent paginated snapshot. */
export async function getIntervalRuns(
  request: FastifyRequest<{ Params: { id: string }; Querystring: Record<string, unknown> }>,
) {
  const params = IntervalRunParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;
  const parsed = IntervalRunListQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;
  const pagination = parsePagination(parsed.data, {
    defaultLimit: DEFAULT_RUN_PAGE_SIZE,
    maxLimit: MAX_RUN_PAGE_SIZE,
  });

  const snapshot = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const interval = await trx
        .selectFrom('intervals')
        .select('id')
        .where('id', '=', params.data.id)
        .executeTakeFirst();
      if (interval === undefined) throw intervalNotFound();

      const rowsQuery = trx
        .selectFrom('interval_runs')
        .innerJoin('intervals', 'intervals.id', 'interval_runs.interval_id')
        .selectAll('interval_runs')
        .select('intervals.name as interval_name')
        .where('interval_runs.interval_id', '=', params.data.id)
        .orderBy('interval_runs.started_at', 'desc')
        .orderBy('interval_runs.id', 'desc')
        .limit(pagination.limit)
        .offset(pagination.offset);
      const [rows, count] = await Promise.all([
        rowsQuery.execute(),
        trx
          .selectFrom('interval_runs')
          .select(sql<string>`count(*)::text`.as('total'))
          .where('interval_id', '=', params.data.id)
          .executeTakeFirstOrThrow(),
      ]);
      return { rows, total: safeCount(count.total) };
    });

  return IntervalRunListResponseSchema.parse({
    data: snapshot.rows.map(toRunView),
    meta: buildPageMeta(pagination.page, pagination.limit, snapshot.total),
  });
}

/** Returns one durable run with its country snapshots in stable country-slug order. */
export async function getIntervalRun(request: FastifyRequest<{ Params: { runId: string } }>) {
  const params = IntervalRunDetailParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;

  const detail = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const row = await trx
        .selectFrom('interval_runs')
        .innerJoin('intervals', 'intervals.id', 'interval_runs.interval_id')
        .selectAll('interval_runs')
        .select('intervals.name as interval_name')
        .where('interval_runs.id', '=', params.data.runId)
        .executeTakeFirst();
      if (row === undefined) throw runNotFound();
      const items = await trx
        .selectFrom('interval_run_items')
        .selectAll()
        .where('run_id', '=', row.id)
        .orderBy('country_slug', 'asc')
        .orderBy('id', 'asc')
        .execute();
      return { row, items };
    });

  return IntervalRunDetailResponseSchema.parse({
    run: toRunView(detail.row),
    items: detail.items.map(toRunItemView),
  });
}

function toRunView(row: IntervalRunListRow | IntervalRunDetailRow) {
  const startedAt = row.started_at.toISOString();
  const endedAt = row.finished_at?.getTime() ?? Date.now();
  return IntervalRunViewSchema.parse({
    id: row.id,
    intervalId: row.interval_id,
    intervalName: row.interval_name,
    triggeredBy: row.triggered_by,
    status: row.status,
    countriesTotal: row.countries_total,
    countriesOk: row.countries_ok,
    countriesFailed: row.countries_failed,
    countriesSkipped: row.countries_skipped,
    bytesDownloaded: jsonInteger(row.bytes_downloaded),
    startedAt,
    finishedAt: row.finished_at?.toISOString() ?? null,
    durationMs: Math.max(0, endedAt - row.started_at.getTime()),
    errorMessage: row.error_message,
  });
}

function toRunItemView(row: IntervalRunItem) {
  return IntervalRunItemViewSchema.parse({
    id: row.id,
    countryId: row.country_id,
    countrySlug: row.country_slug,
    countryName: row.country_name,
    jobId: row.job_id,
    status: row.status,
    version: row.version,
    bytes: jsonInteger(row.bytes),
    errorCode: row.error_code,
    errorMessage: row.error_message,
  });
}

function jsonInteger(value: string | number | bigint): number | string {
  const decimal = String(value);
  if (!/^(?:0|[1-9]\d*)$/u.test(decimal)) {
    throw new RangeError('run byte count is not a non-negative decimal integer');
  }
  const parsed = BigInt(decimal);
  return parsed <= MAX_SAFE_JSON_INTEGER ? Number(parsed) : parsed.toString();
}

function safeCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('run row count is not a non-negative decimal integer');
  }
  const count = BigInt(value);
  if (count > MAX_SAFE_JSON_INTEGER) {
    throw new RangeError('run count exceeds the safe JSON integer range');
  }
  return Number(count);
}

function isActiveDownloadUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'jobs_one_active_download'
  );
}

function intervalNotFound(): AppError {
  return new AppError('NOT_FOUND', 'The requested interval does not exist.');
}

function runNotFound(): AppError {
  return new AppError('NOT_FOUND', 'The requested interval run does not exist.');
}
