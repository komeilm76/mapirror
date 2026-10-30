import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import { buildApp, parseEnv, type SqlDatabase } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { startJobWorker } from '../../src/modules/jobs/worker';
import { freshDatabaseSkipReason, withFreshDatabase, dsnFor } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe.skipIf(skipReason !== null)('interval run API and job lifecycle', () => {
  it('manually runs a disabled interval, lists history, and exposes aggregate partial outcomes', async () => {
    await withRunApi(async ({ app, token, database, countries }) => {
      const created = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'Manual Finland and Sweden',
        frequency: 'daily',
        countryIds: [countries.finland.id, countries.sweden.id],
        enabled: false,
      });
      expect(created.statusCode).toBe(201);
      const intervalId = created.json<{ interval: { id: string; enabled: boolean } }>().interval.id;
      expect(created.json<{ interval: { enabled: boolean } }>().interval.enabled).toBe(false);

      const accepted = await request(app, token, 'POST', `/_admin/api/intervals/${intervalId}/run`);
      expect(accepted.statusCode).toBe(202);
      const { runId, jobIds } = accepted.json<{ runId: string; jobIds: string[] }>();
      expect(jobIds).toHaveLength(2);
      expect(
        await database.db
          .selectFrom('interval_runs')
          .select(['triggered_by', 'status', 'countries_total'])
          .where('id', '=', runId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ triggered_by: 'manual', status: 'running', countries_total: 2 });

      const overlapping = await request(
        app,
        token,
        'POST',
        `/_admin/api/intervals/${intervalId}/run`,
      );
      expect(overlapping.statusCode).toBe(409);
      expect(overlapping.json<{ error: { code: string } }>().error.code).toBe(
        'JOB_ALREADY_RUNNING',
      );

      const history = await request(
        app,
        token,
        'GET',
        `/_admin/api/intervals/${intervalId}/runs?page=1`,
      );
      expect(history.statusCode).toBe(200);
      expect(
        history.json<{ data: { id: string; triggeredBy: string; status: string }[] }>().data,
      ).toMatchObject([{ id: runId, triggeredBy: 'manual', status: 'running' }]);
      expect(history.json<{ meta: { total: number; page: number } }>().meta).toMatchObject({
        total: 1,
        page: 1,
      });

      const initialDetail = await request(app, token, 'GET', `/_admin/api/interval-runs/${runId}`);
      expect(initialDetail.statusCode).toBe(200);
      expect(
        initialDetail
          .json<{ items: { countrySlug: string; status: string }[] }>()
          .items.map(({ countrySlug, status }) => ({ countrySlug, status })),
      ).toEqual([
        { countrySlug: 'finland', status: 'queued' },
        { countrySlug: 'sweden', status: 'queued' },
      ]);

      const secondJob = await database.db
        .selectFrom('jobs')
        .select(['id', 'payload'])
        .where('id', 'in', jobIds)
        .where(sql<string>`payload ->> 'countryId'`, '=', countries.sweden.id)
        .executeTakeFirstOrThrow();
      expect(secondJob.payload).toMatchObject({ keepVersions: 3 });
      await database.db
        .updateTable('jobs')
        .set({ max_attempts: 1 })
        .where('id', '=', secondJob.id)
        .execute();

      const worker = startJobWorker(
        database.db,
        {
          download: async (job, context) => {
            const payload = job.payload;
            const countryId =
              typeof payload === 'object' && payload !== null && !Array.isArray(payload)
                ? payload.countryId
                : undefined;
            if (countryId === countries.sweden.id) throw new Error('private upstream failure');
            await context.reportProgress({
              progressBytes: 123n,
              totalBytes: 123n,
              phase: 'downloading',
            });
            return { version: '2026-10-27T00:00:00Z' };
          },
        },
        {
          concurrency: 2,
          pollIntervalMs: 5,
          retryBaseDelayMs: 5,
          retryMaxDelayMs: 10,
          cancellationPollIntervalMs: 5,
          log,
        },
      );

      try {
        await waitForRunStatus(database, runId, 'partial');
      } finally {
        await worker.stop();
      }

      const detail = await request(app, token, 'GET', `/_admin/api/interval-runs/${runId}`);
      expect(detail.statusCode).toBe(200);
      const response = detail.json<{
        run: {
          status: string;
          countriesTotal: number;
          countriesOk: number;
          countriesFailed: number;
          countriesSkipped: number;
          bytesDownloaded: number | string;
        };
        items: {
          countrySlug: string;
          status: string;
          version: string | null;
          bytes: number | string;
          errorCode: string | null;
          errorMessage: string | null;
        }[];
      }>();
      expect(response.run).toMatchObject({
        status: 'partial',
        countriesTotal: 2,
        countriesOk: 1,
        countriesFailed: 1,
        countriesSkipped: 0,
        bytesDownloaded: 123,
      });
      expect(response.items).toEqual([
        expect.objectContaining({
          countrySlug: 'finland',
          status: 'downloaded',
          version: '2026-10-27T00:00:00Z',
          bytes: 123,
          errorCode: null,
        }),
        expect.objectContaining({
          countrySlug: 'sweden',
          status: 'failed',
          version: null,
          bytes: 0,
          errorCode: 'JOB_HANDLER_FAILED',
          errorMessage: 'The job handler failed.',
        }),
      ]);
      expect(JSON.stringify(response)).not.toContain('private upstream failure');

      const completedHistory = await request(
        app,
        token,
        'GET',
        `/_admin/api/intervals/${intervalId}/runs`,
      );
      expect(completedHistory.json<{ data: { status: string }[] }>().data[0]?.status).toBe(
        'partial',
      );
      expect(
        await database.db
          .selectFrom('audit_logs')
          .select('action')
          .where('action', '=', 'interval.run')
          .execute(),
      ).toHaveLength(1);
    });
  });

  it('records an immediately canceled queued country job as skipped', async () => {
    await withRunApi(async ({ app, token, countries }) => {
      const created = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'Cancel before work',
        frequency: 'daily',
        countryIds: [countries.finland.id],
      });
      const intervalId = created.json<{ interval: { id: string } }>().interval.id;
      const accepted = await request(app, token, 'POST', `/_admin/api/intervals/${intervalId}/run`);
      const { runId, jobIds } = accepted.json<{ runId: string; jobIds: string[] }>();

      const canceled = await request(
        app,
        token,
        'POST',
        `/_admin/api/jobs/${jobIds[0]!}/cancel`,
        {},
      );
      expect(canceled.statusCode).toBe(202);
      expect(canceled.json<{ status: string }>().status).toBe('canceled');

      const detail = await request(app, token, 'GET', `/_admin/api/interval-runs/${runId}`);
      expect(
        detail.json<{
          run: {
            status: string;
            countriesOk: number;
            countriesFailed: number;
            countriesSkipped: number;
          };
          items: { status: string; errorMessage: string | null }[];
        }>(),
      ).toMatchObject({
        run: { status: 'succeeded', countriesOk: 0, countriesFailed: 0, countriesSkipped: 1 },
        items: [{ status: 'skipped', errorMessage: 'The download was canceled.' }],
      });
    });
  });

  it('rejects a non-empty manual-run body and unknown interval ids', async () => {
    await withRunApi(async ({ app, token, countries }) => {
      const unknown = await request(
        app,
        token,
        'POST',
        '/_admin/api/intervals/00000000-0000-4000-8000-000000000099/run',
      );
      expect(unknown.statusCode).toBe(404);

      const created = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'No extras',
        frequency: 'daily',
        countryIds: [countries.finland.id],
      });
      expect(created.statusCode).toBe(201);
      const intervalId = created.json<{ interval: { id: string } }>().interval.id;
      const invalidBody = await request(
        app,
        token,
        'POST',
        `/_admin/api/intervals/${intervalId}/run`,
        { force: true },
      );
      expect(invalidBody.statusCode).toBe(400);
      expect(invalidBody.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    });
  });
});

interface RunApiHarness {
  readonly app: FastifyInstance;
  readonly token: string;
  readonly database: SqlDatabase;
  readonly countries: {
    readonly finland: { readonly id: string };
    readonly sweden: { readonly id: string };
  };
}

async function withRunApi(run: (harness: RunApiHarness) => Promise<void>) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'interval-run-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const token = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const finland = await insertCountry(database, 'finland', 'Finland');
      const sweden = await insertCountry(database, 'sweden', 'Sweden');
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
        logger: false,
      });
      try {
        await run({ app, token: token.token, database, countries: { finland, sweden } });
      } finally {
        await app.close();
      }
    },
    { prefix: 'intervalrunapi', migrate: true },
  );
}

async function insertCountry(database: SqlDatabase, slug: string, name: string) {
  return database.db
    .insertInto('countries')
    .values({ source_id: `europe/${slug}`, slug, name })
    .returning('id')
    .executeTakeFirstOrThrow();
}

async function request(
  app: FastifyInstance,
  token: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function waitForRunStatus(
  database: SqlDatabase,
  runId: string,
  expected: 'partial',
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const row = await database.db
      .selectFrom('interval_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    if (row.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`interval run ${runId} did not reach ${expected} before the deadline`);
}
