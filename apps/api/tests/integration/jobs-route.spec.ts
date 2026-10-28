import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv, type SqlDatabase } from '../../src/index';
import type { JsonValue } from '../../src/db/schema';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

interface JobsHarness {
  readonly app: FastifyInstance;
  readonly database: SqlDatabase;
  readonly token: string;
}

async function withJobsApp(run: (harness: JobsHarness) => Promise<void>): Promise<void> {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'jobs-route-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const issued = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
      });
      try {
        await run({ app, database, token: issued.token });
      } finally {
        await app.close();
      }
    },
    { prefix: 'jobsroute', migrate: true },
  );
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function insertJob(
  database: SqlDatabase,
  input: {
    readonly type?: 'download' | 'import' | 'update_check' | 'catalog_sync' | 'prune';
    readonly status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    readonly payload?: JsonValue;
    readonly createdAt?: Date;
    readonly progressBytes?: bigint;
    readonly totalBytes?: bigint | null;
    readonly speedBps?: bigint | null;
    readonly phase?: string | null;
    readonly attempts?: number;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
    readonly cancelRequested?: boolean;
    readonly lockedBy?: string | null;
    readonly lockedAt?: Date | null;
  } = {},
): Promise<string> {
  const row = await database.db
    .insertInto('jobs')
    .values({
      type: input.type ?? 'prune',
      status: input.status ?? 'queued',
      payload: input.payload ?? {},
      created_at: input.createdAt ?? new Date('2026-10-28T00:00:00.000Z'),
      progress_bytes: input.progressBytes ?? 0n,
      total_bytes: input.totalBytes ?? null,
      speed_bps: input.speedBps ?? null,
      phase: input.phase ?? null,
      attempts: input.attempts ?? 0,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      cancel_requested: input.cancelRequested ?? false,
      locked_by: input.lockedBy ?? null,
      locked_at: input.lockedAt ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function jobsUrl(query = ''): string {
  return `/_admin/api/jobs${query}`;
}

function jobUrl(jobId: string): string {
  return `/_admin/api/jobs/${jobId}`;
}

function cancelUrl(jobId: string): string {
  return `${jobUrl(jobId)}/cancel`;
}

describe.skipIf(skipReason !== null)('admin jobs API', () => {
  it('lists the newest jobs first with strict status/type filters and bounded pagination', async () => {
    await withJobsApp(async ({ app, database, token }) => {
      const oldest = await insertJob(database, {
        type: 'download',
        status: 'queued',
        payload: { countryId: '00000000-0000-4000-8000-000000000001', version: '261021' },
        createdAt: new Date('2026-10-27T00:00:00.000Z'),
      });
      const middle = await insertJob(database, {
        type: 'download',
        status: 'running',
        payload: { countryId: '00000000-0000-4000-8000-000000000002', version: '261022' },
        createdAt: new Date('2026-10-27T01:00:00.000Z'),
      });
      const newest = await insertJob(database, {
        type: 'catalog_sync',
        status: 'succeeded',
        payload: { source: 'geofabrik' },
        createdAt: new Date('2026-10-27T02:00:00.000Z'),
      });

      const page = await app.inject({
        method: 'GET',
        url: jobsUrl('?status=running&type=download&page=1&limit=1'),
        headers: auth(token),
      });
      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({
        data: [{ id: middle, status: 'running', type: 'download' }],
        meta: { page: 1, limit: 1, total: 1, totalPages: 1 },
      });

      const firstPage = await app.inject({
        method: 'GET',
        url: jobsUrl('?limit=1'),
        headers: auth(token),
      });
      expect(firstPage.json<{ data: { id: string }[] }>().data[0]?.id).toBe(newest);
      const secondPage = await app.inject({
        method: 'GET',
        url: jobsUrl('?page=2&limit=1'),
        headers: auth(token),
      });
      expect(secondPage.json<{ data: { id: string }[] }>().data[0]?.id).toBe(middle);
      const all = await app.inject({ method: 'GET', url: jobsUrl(), headers: auth(token) });
      expect(all.json<{ data: { id: string }[] }>().data.map(({ id }) => id)).toEqual([
        newest,
        middle,
        oldest,
      ]);

      const clamped = await app.inject({
        method: 'GET',
        url: jobsUrl('?limit=100000'),
        headers: auth(token),
      });
      expect(clamped.json<{ meta: { limit: number } }>().meta.limit).toBe(100);
      const strict = await app.inject({
        method: 'GET',
        url: jobsUrl('?status=active'),
        headers: auth(token),
      });
      expect(strict.statusCode).toBe(400);
      expect(strict.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
      const unknownKey = await app.inject({
        method: 'GET',
        url: jobsUrl('?status=running&unexpected=true'),
        headers: auth(token),
      });
      expect(unknownKey.statusCode).toBe(400);
    });
  });

  it('returns exact progress, bounded ETA, allow-listed payload and generic safe error detail', async () => {
    await withJobsApp(async ({ app, database, token }) => {
      const countryId = '00000000-0000-4000-8000-000000000099';
      const jobId = await insertJob(database, {
        type: 'download',
        status: 'running',
        payload: {
          countryId,
          version: '261023',
          sourceUrl: 'https://private.example/secret.pbf',
          internalToken: 'do-not-return',
        },
        progressBytes: 9_007_199_254_740_993n,
        totalBytes: 9_007_199_254_741_993n,
        speedBps: 333n,
        phase: 'downloading',
        attempts: 1,
        lockedBy: 'eta-test-worker',
        lockedAt: new Date(),
        errorCode: 'JOB_HANDLER_FAILED',
        errorMessage: 'raw private exception text must not leak',
      });

      const response = await app.inject({
        method: 'GET',
        url: jobUrl(jobId),
        headers: auth(token),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: jobId,
        status: 'running',
        phase: 'downloading',
        progressBytes: '9007199254740993',
        totalBytes: '9007199254741993',
        speedBps: 333,
        etaSeconds: 4,
        payload: { countryId, version: '261023' },
        cancelRequested: false,
        attempts: 1,
        maxAttempts: 3,
        error: { code: 'JOB_HANDLER_FAILED', message: 'The job handler failed.' },
      });
      expect(response.body).not.toContain('private.example');
      expect(response.body).not.toContain('do-not-return');
      expect(response.body).not.toContain('raw private exception');

      const retryingId = await insertJob(database, {
        type: 'download',
        status: 'queued',
        payload: { countryId, version: '261024' },
        progressBytes: 9_007_199_254_740_993n,
        totalBytes: 9_007_199_254_741_993n,
        speedBps: 333n,
        attempts: 1,
        errorCode: 'JOB_HANDLER_FAILED',
      });
      const retrying = await app.inject({
        method: 'GET',
        url: jobUrl(retryingId),
        headers: auth(token),
      });
      expect(retrying.json<{ etaSeconds: number | null }>().etaSeconds).toBeNull();

      const lostId = await insertJob(database, {
        status: 'failed',
        errorCode: 'WORKER_LOST',
        errorMessage: 'raw connection details must remain private',
        attempts: 3,
      });
      const lost = await app.inject({
        method: 'GET',
        url: jobUrl(lostId),
        headers: auth(token),
      });
      expect(lost.json()).toMatchObject({
        error: {
          code: 'WORKER_LOST',
          message: 'The worker stopped before this job completed.',
        },
      });
      expect(lost.body).not.toContain('raw connection details');

      const missing = await app.inject({
        method: 'GET',
        url: jobUrl('00000000-0000-4000-8000-000000000000'),
        headers: auth(token),
      });
      expect(missing.statusCode).toBe(404);
      const invalid = await app.inject({
        method: 'GET',
        url: jobUrl('bad-id'),
        headers: auth(token),
      });
      expect(invalid.statusCode).toBe(400);
    });
  });

  it('acknowledges queued and running cancellation without stealing worker cleanup', async () => {
    await withJobsApp(async ({ app, database, token }) => {
      const queuedId = await insertJob(database, { status: 'queued' });
      const queued = await app.inject({
        method: 'POST',
        url: cancelUrl(queuedId),
        headers: auth(token),
      });
      expect(queued.statusCode).toBe(202);
      expect(queued.json()).toMatchObject({
        jobId: queuedId,
        status: 'canceled',
        accepted: true,
        cancelRequested: true,
      });
      const canceledRow = await database.db
        .selectFrom('jobs')
        .select(['status', 'cancel_requested', 'finished_at', 'locked_by', 'locked_at'])
        .where('id', '=', queuedId)
        .executeTakeFirstOrThrow();
      expect(canceledRow).toMatchObject({ status: 'canceled', cancel_requested: true });
      expect(canceledRow.finished_at).toBeInstanceOf(Date);
      expect(canceledRow.locked_by).toBeNull();
      expect(canceledRow.locked_at).toBeNull();

      const runningId = await insertJob(database, {
        type: 'download',
        status: 'running',
        payload: { countryId: '00000000-0000-4000-8000-000000000003', version: '261023' },
        lockedBy: 'remote-worker-slot-1',
        lockedAt: new Date(),
        attempts: 1,
      });
      const running = await app.inject({
        method: 'POST',
        url: cancelUrl(runningId),
        headers: auth(token),
      });
      expect(running.statusCode).toBe(202);
      expect(running.json()).toMatchObject({
        status: 'running',
        accepted: true,
        cancelRequested: true,
      });
      const runningRow = await database.db
        .selectFrom('jobs')
        .select(['status', 'cancel_requested', 'locked_by', 'locked_at'])
        .where('id', '=', runningId)
        .executeTakeFirstOrThrow();
      expect(runningRow).toMatchObject({
        status: 'running',
        cancel_requested: true,
        locked_by: 'remote-worker-slot-1',
      });
      expect(runningRow.locked_at).toBeInstanceOf(Date);
    });
  });

  it('is idempotent for canceled jobs and reports already-terminal work without mutating it', async () => {
    await withJobsApp(async ({ app, database, token }) => {
      const canceledId = await insertJob(database, {
        status: 'canceled',
        cancelRequested: true,
      });
      const canceled = await app.inject({
        method: 'POST',
        url: cancelUrl(canceledId),
        headers: auth(token),
      });
      expect(canceled.statusCode).toBe(202);
      expect(canceled.json()).toMatchObject({ status: 'canceled', accepted: true });

      const succeededId = await insertJob(database, {
        status: 'succeeded',
        cancelRequested: false,
      });
      const terminal = await app.inject({
        method: 'POST',
        url: cancelUrl(succeededId),
        headers: auth(token),
      });
      expect(terminal.statusCode).toBe(200);
      expect(terminal.json()).toMatchObject({
        jobId: succeededId,
        status: 'succeeded',
        accepted: false,
        cancelRequested: false,
      });
      expect(
        await database.db
          .selectFrom('jobs')
          .select(['status', 'cancel_requested'])
          .where('id', '=', succeededId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'succeeded', cancel_requested: false });

      const unknown = await app.inject({
        method: 'POST',
        url: cancelUrl('00000000-0000-4000-8000-000000000000'),
        headers: auth(token),
      });
      expect(unknown.statusCode).toBe(404);
      const invalidBody = await app.inject({
        method: 'POST',
        url: cancelUrl(succeededId),
        headers: { ...auth(token), 'content-type': 'application/json' },
        payload: { force: true },
      });
      expect(invalidBody.statusCode).toBe(400);
      const anonymous = await app.inject({ method: 'POST', url: cancelUrl(succeededId) });
      expect(anonymous.statusCode).toBe(401);
    });
  });
});
