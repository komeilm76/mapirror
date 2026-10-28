/** Admin job list, detail and cancellation routes (`P2-API-10`).
 *
 * @module modules/admin/jobs-route
 */

import {
  buildPageMeta,
  CatalogSyncJobPayloadSchema,
  DownloadJobPayloadSchema,
  ImportJobPayloadSchema,
  JobCancelRequestSchema,
  JobCancelResponseSchema,
  JobDetailResponseSchema,
  JobListQuerySchema,
  JobListResponseSchema,
  JobParamsSchema,
  JobViewSchema,
  JOB_PHASES,
  PruneJobPayloadSchema,
  UpdateCheckJobPayloadSchema,
  parsePagination,
  type JobListQuery,
  type JobPayload,
  type JobView,
} from '@mapirror/shared';
import { sql, type SelectQueryBuilder } from 'kysely';
import type { ZodType } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Database, Job, JobType, JsonValue } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { estimateJobEtaSeconds } from '../jobs/progress';
import { requestJobCancellation } from '../jobs/cancellation';

const JOB_LIST_DEFAULT_LIMIT = 25;
const JOB_LIST_MAX_LIMIT = 100;
const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const JOB_HANDLER_FAILED_MESSAGE = 'The job handler failed.';
const WORKER_LOST_MESSAGE = 'The worker stopped before this job completed.';

const JOB_VIEW_COLUMNS = [
  'id',
  'type',
  'status',
  'payload',
  'phase',
  'progress_bytes',
  'total_bytes',
  'speed_bps',
  'attempts',
  'max_attempts',
  'cancel_requested',
  'created_at',
  'started_at',
  'finished_at',
  'error_code',
] as const;

type JobViewRow = Pick<Job, (typeof JOB_VIEW_COLUMNS)[number]>;

/** Handles `GET /_admin/api/jobs` from one consistent database snapshot. */
export async function getJobs(
  request: FastifyRequest,
): Promise<ReturnType<typeof JobListResponseSchema.parse>> {
  const parsed = JobListQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;
  const query = parsed.data;
  const pagination = parsePagination(query, {
    defaultLimit: JOB_LIST_DEFAULT_LIMIT,
    maxLimit: JOB_LIST_MAX_LIMIT,
  });

  const snapshot = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const rowsQuery = filterJobs(trx.selectFrom('jobs').select(JOB_VIEW_COLUMNS), query)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(pagination.limit)
        .offset(pagination.offset);
      const countQuery = filterJobs(
        trx.selectFrom('jobs').select(sql<string>`count(*)::text`.as('total')),
        query,
      );
      const [rows, count] = await Promise.all([
        rowsQuery.execute(),
        countQuery.executeTakeFirstOrThrow(),
      ]);
      return { rows, total: safeCount(count.total) };
    });

  return JobListResponseSchema.parse({
    data: snapshot.rows.map(toJobView),
    meta: buildPageMeta(pagination.page, pagination.limit, snapshot.total),
  });
}

/** Handles `GET /_admin/api/jobs/:jobId` without exposing queue ownership or raw exception text. */
export async function getJob(
  request: FastifyRequest<{ Params: { jobId: string } }>,
): Promise<JobView> {
  const params = JobParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;

  const row = await request.server.db.db
    .selectFrom('jobs')
    .select(JOB_VIEW_COLUMNS)
    .where('id', '=', params.data.jobId)
    .executeTakeFirst();
  if (row === undefined) throw new AppError('NOT_FOUND', 'The requested job does not exist.');

  return JobDetailResponseSchema.parse(toJobView(row));
}

/** Handles `POST /_admin/api/jobs/:jobId/cancel` using the durable worker cancellation protocol. */
export async function cancelJob(
  request: FastifyRequest<{ Params: { jobId: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const params = JobParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;
  const body = JobCancelRequestSchema.safeParse(request.body === undefined ? {} : request.body);
  if (!body.success) throw body.error;

  const result = await requestJobCancellation(request.server.db.db, params.data.jobId);
  if (!result.found || result.status === null) {
    throw new AppError('NOT_FOUND', 'The requested job does not exist.');
  }

  const response = JobCancelResponseSchema.parse({
    jobId: params.data.jobId,
    status: result.status,
    accepted: result.accepted,
    cancelRequested: result.status === 'running' || result.status === 'canceled',
  });
  await reply.code(result.accepted ? 202 : 200).send(response);
}

function filterJobs<Output>(
  query: SelectQueryBuilder<Database, 'jobs', Output>,
  filters: Pick<JobListQuery, 'status' | 'type'>,
): SelectQueryBuilder<Database, 'jobs', Output> {
  let filtered = query;
  if (filters.status !== undefined) filtered = filtered.where('status', '=', filters.status);
  if (filters.type !== undefined) filtered = filtered.where('type', '=', filters.type);
  return filtered;
}

function toJobView(row: JobViewRow): JobView {
  const error = row.error_code === null ? null : safeJobError(row.error_code);
  const phase = isJobPhase(row.phase) ? row.phase : null;
  return JobViewSchema.parse({
    id: row.id,
    type: row.type,
    status: row.status,
    phase,
    progressBytes: jsonInteger(row.progress_bytes),
    totalBytes: row.total_bytes === null ? null : jsonInteger(row.total_bytes),
    speedBps: row.speed_bps === null ? null : jsonInteger(row.speed_bps),
    etaSeconds:
      row.status === 'running' && !row.cancel_requested
        ? estimateJobEtaSeconds(row.progress_bytes, row.total_bytes, row.speed_bps)
        : null,
    payload: safeJobPayload(row.type, row.payload),
    cancelRequested: row.cancel_requested,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    error,
  });
}

function safeJobPayload(type: JobType, payload: JsonValue): JobPayload | null {
  switch (type) {
    case 'download':
      return projectPayload(DownloadJobPayloadSchema, payload, [
        'countryId',
        'version',
        'origin',
        'onlyIfChanged',
      ]);
    case 'catalog_sync':
      return projectPayload(CatalogSyncJobPayloadSchema, payload, ['source']);
    case 'import':
      return projectPayload(ImportJobPayloadSchema, payload, [
        'uploadId',
        'countryId',
        'version',
        'replace',
      ]);
    case 'update_check':
      return projectPayload(UpdateCheckJobPayloadSchema, payload, ['countryIds']);
    case 'prune':
      return projectPayload(PruneJobPayloadSchema, payload, ['countryId', 'keep']);
  }
}

function projectPayload<T extends JobPayload>(
  schema: ZodType<T>,
  payload: JsonValue,
  allowedKeys: readonly string[],
): T | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const projection = Object.fromEntries(
    Object.entries(payload).filter(([key]) => allowedKeys.includes(key)),
  );
  const parsed = schema.safeParse(projection);
  return parsed.success ? parsed.data : null;
}

function safeJobError(code: string): JobView['error'] {
  if (code === 'WORKER_LOST') return { code, message: WORKER_LOST_MESSAGE };
  return { code: 'JOB_HANDLER_FAILED', message: JOB_HANDLER_FAILED_MESSAGE };
}

function isJobPhase(value: string | null): value is NonNullable<JobView['phase']> {
  return value !== null && JOB_PHASES.includes(value as NonNullable<JobView['phase']>);
}

function jsonInteger(value: string): number | string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('job byte count is not a non-negative decimal integer');
  }
  const exact = BigInt(value);
  return exact <= MAX_SAFE_JSON_INTEGER ? Number(exact) : exact.toString();
}

function safeCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('job row count is not a non-negative decimal integer');
  }
  const count = BigInt(value);
  if (count > MAX_SAFE_JSON_INTEGER)
    throw new RangeError('job row count exceeds the JSON safe integer range');
  return Number(count);
}
