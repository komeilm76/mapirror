import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv, type SqlDatabase } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { freshDatabaseSkipReason, withFreshDatabase, dsnFor } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('interval schedule API', () => {
  it('creates and lists an interval with UTC defaults and country snapshots', async () => {
    await withIntervalsApi(async ({ app, token, countries }) => {
      const created = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: '  Finland nightly  ',
        frequency: 'daily',
        countryIds: [countries.finland.id],
      });
      expect(created.statusCode).toBe(201);
      const interval = created.json<{ interval: Record<string, unknown> }>().interval;
      expect(interval).toMatchObject({
        name: 'Finland nightly',
        frequency: 'daily',
        timeOfDay: '03:00',
        weekday: null,
        dayOfMonth: null,
        keepVersions: 3,
        onlyIfChanged: true,
        enabled: true,
        countries: [
          {
            countryId: countries.finland.id,
            name: 'Finland',
            slug: 'finland',
          },
        ],
        lastRun: null,
      });
      expect(new Date(interval.nextRunAt as string).getTime()).toBeGreaterThan(Date.now());

      const listed = await request(app, token, 'GET', '/_admin/api/intervals');
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ data: unknown[] }>().data).toEqual([interval]);
    });
  });

  it('uses weekday and month-day defaults and rejects frequency-shape mismatches with 422', async () => {
    await withIntervalsApi(async ({ app, token, countries }) => {
      const weekly = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'Weekly',
        frequency: 'weekly',
        countryIds: [countries.finland.id],
      });
      expect(weekly.statusCode).toBe(201);
      expect(
        weekly.json<{ interval: { weekday: number; dayOfMonth: number | null } }>().interval,
      ).toMatchObject({ weekday: 1, dayOfMonth: null });

      const monthly = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'Monthly',
        frequency: 'monthly',
        countryIds: [countries.sweden.id],
      });
      expect(monthly.statusCode).toBe(201);
      expect(
        monthly.json<{ interval: { weekday: number | null; dayOfMonth: number } }>().interval,
      ).toMatchObject({ weekday: null, dayOfMonth: 1 });

      const invalid = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'Wrong weekday',
        frequency: 'daily',
        weekday: 1,
        countryIds: [countries.finland.id],
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json<{ error: { code: string } }>().error.code).toBe('SEMANTIC_ERROR');

      const unknownCountry = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'Missing country',
        frequency: 'daily',
        countryIds: ['00000000-0000-4000-8000-000000000099'],
      });
      expect(unknownCountry.statusCode).toBe(422);
    });
  });

  it('patches schedule and memberships atomically and recomputes from the current database clock', async () => {
    await withIntervalsApi(async ({ app, token, database, countries }) => {
      const created = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'Editable',
        frequency: 'weekly',
        weekday: 5,
        countryIds: [countries.finland.id],
      });
      const id = created.json<{ interval: { id: string } }>().interval.id;

      const updated = await request(app, token, 'PATCH', `/_admin/api/intervals/${id}`, {
        frequency: 'monthly',
        timeOfDay: '04:15',
        countryIds: [countries.sweden.id],
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json<{ interval: Record<string, unknown> }>().interval).toMatchObject({
        frequency: 'monthly',
        timeOfDay: '04:15',
        weekday: null,
        dayOfMonth: 1,
        countries: [{ countryId: countries.sweden.id, name: 'Sweden', slug: 'sweden' }],
      });
      expect(
        new Date(updated.json<{ interval: { nextRunAt: string } }>().interval.nextRunAt).getTime(),
      ).toBeGreaterThan(Date.now());

      const wrongShape = await request(app, token, 'PATCH', `/_admin/api/intervals/${id}`, {
        weekday: 2,
      });
      expect(wrongShape.statusCode).toBe(422);
      expect(wrongShape.json<{ error: { code: string } }>().error.code).toBe('SEMANTIC_ERROR');

      const emptyPatch = await request(app, token, 'PATCH', `/_admin/api/intervals/${id}`, {});
      expect(emptyPatch.statusCode).toBe(400);

      await database.db
        .updateTable('intervals')
        .set({ enabled: false, next_run_at: new Date('2000-01-01T00:00:00.000Z') })
        .where('id', '=', id)
        .execute();
      const reenabled = await request(app, token, 'PATCH', `/_admin/api/intervals/${id}`, {
        enabled: true,
      });
      expect(reenabled.statusCode).toBe(200);
      expect(
        reenabled.json<{ interval: { enabled: boolean; nextRunAt: string } }>().interval.enabled,
      ).toBe(true);
      expect(
        new Date(
          reenabled.json<{ interval: { nextRunAt: string } }>().interval.nextRunAt,
        ).getTime(),
      ).toBeGreaterThan(Date.now());
    });
  });

  it('requires explicit confirmation before disabling a schedule with a running occurrence', async () => {
    await withIntervalsApi(async ({ app, token, database, countries }) => {
      const created = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'Active',
        frequency: 'daily',
        countryIds: [countries.finland.id],
      });
      const id = created.json<{ interval: { id: string } }>().interval.id;
      const run = await database.db
        .insertInto('interval_runs')
        .values({ interval_id: id, triggered_by: 'schedule' })
        .returning('id')
        .executeTakeFirstOrThrow();

      const listed = await request(app, token, 'GET', '/_admin/api/intervals');
      expect(
        listed.json<{ data: { lastRun: { id: string; status: string } | null }[] }>().data[0],
      ).toMatchObject({ lastRun: { id: run.id, status: 'running' } });

      const refused = await request(app, token, 'PATCH', `/_admin/api/intervals/${id}`, {
        enabled: false,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('CONFIRMATION_REQUIRED');

      const confirmed = await request(app, token, 'PATCH', `/_admin/api/intervals/${id}`, {
        enabled: false,
        confirm: true,
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json<{ interval: { enabled: boolean } }>().interval.enabled).toBe(false);
      expect(
        await database.db
          .selectFrom('interval_runs')
          .select('status')
          .where('id', '=', run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'running' });
    });
  });

  it('blocks normal deletion during a run and audits a forced deletion', async () => {
    await withIntervalsApi(async ({ app, token, database, countries }) => {
      const created = await request(app, token, 'POST', '/_admin/api/intervals', {
        name: 'Delete me',
        frequency: 'daily',
        countryIds: [countries.finland.id],
      });
      const id = created.json<{ interval: { id: string } }>().interval.id;
      await database.db
        .insertInto('interval_runs')
        .values({ interval_id: id, triggered_by: 'schedule' })
        .execute();

      const refused = await request(app, token, 'DELETE', `/_admin/api/intervals/${id}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('JOB_ALREADY_RUNNING');

      const deleted = await request(app, token, 'DELETE', `/_admin/api/intervals/${id}?force=true`);
      expect(deleted.statusCode).toBe(204);
      expect(
        await database.db.selectFrom('intervals').select('id').where('id', '=', id).execute(),
      ).toEqual([]);
      expect(
        await database.db
          .selectFrom('interval_runs')
          .select('id')
          .where('interval_id', '=', id)
          .execute(),
      ).toEqual([]); // The schema intentionally cascades run history on hard deletion.
      expect(
        await database.db
          .selectFrom('audit_logs')
          .select('action')
          .where('target_id', '=', id)
          .orderBy('action', 'asc')
          .execute(),
      ).toEqual([{ action: 'interval.create' }, { action: 'interval.delete' }]);
    });
  });
});

interface IntervalApiHarness {
  readonly app: FastifyInstance;
  readonly token: string;
  readonly database: SqlDatabase;
  readonly countries: {
    readonly finland: { readonly id: string };
    readonly sweden: { readonly id: string };
  };
}

async function withIntervalsApi(run: (harness: IntervalApiHarness) => Promise<void>) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'interval-admin', password_hash: 'unused' })
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
    { prefix: 'intervalcrud', migrate: true },
  );
}

async function insertCountry(database: IntervalApiHarness['database'], slug: string, name: string) {
  return database.db
    .insertInto('countries')
    .values({ source_id: `europe/${slug}`, slug, name })
    .returning('id')
    .executeTakeFirstOrThrow();
}

async function request(
  app: FastifyInstance,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
