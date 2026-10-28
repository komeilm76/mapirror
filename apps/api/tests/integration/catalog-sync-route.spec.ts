import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import { CATALOG_SYNC_ENQUEUE_LOCK } from '../../src/modules/jobs/enqueue-catalog-sync';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

async function withSyncApp(
  run: (context: {
    app: FastifyInstance;
    adminId: string;
    token: string;
    database: FastifyInstance['db']['db'];
  }) => Promise<void>,
) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'catalog-sync-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const issued = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
      });
      try {
        await run({ app, adminId: admin.id, token: issued.token, database: app.db.db });
      } finally {
        await app.close();
      }
    },
    { prefix: 'catalogsyncroute', migrate: true },
  );
}

function postCatalogSync(app: FastifyInstance, token?: string, payload?: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({
    method: 'POST',
    url: '/_admin/api/catalog/sync',
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(payload === undefined ? {} : { payload }),
  });
}

describe.skipIf(skipReason !== null)('POST /_admin/api/catalog/sync', () => {
  it('requires an admin and creates an attributed queued job with 202', async () => {
    await withSyncApp(async ({ app, adminId, token, database }) => {
      const anonymous = await postCatalogSync(app);
      expect(anonymous.statusCode).toBe(401);
      expect(
        await database.selectFrom('jobs').select('id').where('type', '=', 'catalog_sync').execute(),
      ).toEqual([]);

      const response = await postCatalogSync(app, token);
      expect(response.statusCode).toBe(202);
      const { jobId } = response.json<{ jobId: string }>();
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/u);

      const job = await database
        .selectFrom('jobs')
        .select(['id', 'type', 'status', 'payload', 'created_by'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow();
      expect(job).toMatchObject({
        id: jobId,
        type: 'catalog_sync',
        status: 'queued',
        payload: { source: 'geofabrik' },
        created_by: adminId,
      });
    });
  });

  it('serializes simultaneous requests and returns one active id to every caller', async () => {
    await withSyncApp(async ({ app, token, database }) => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => postCatalogSync(app, token, {})),
      );
      expect(responses.map(({ statusCode }) => statusCode)).toEqual(Array(8).fill(202));
      const ids = responses.map((response) => response.json<{ jobId: string }>().jobId);
      expect(new Set(ids).size).toBe(1);
      expect(
        await database
          .selectFrom('jobs')
          .select('id')
          .where('type', '=', 'catalog_sync')
          .where('status', 'in', ['queued', 'running'])
          .execute(),
      ).toHaveLength(1);
    });
  });

  it('waits on the transaction-scoped enqueue lock held by another database session', async () => {
    await withSyncApp(async ({ app, token, database }) => {
      let announceLock!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        announceLock = resolve;
      });
      let releaseLock!: () => void;
      const lockReleased = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = database.transaction().execute(async (trx) => {
        await sql`
          select pg_advisory_xact_lock(hashtextextended(${CATALOG_SYNC_ENQUEUE_LOCK}, 0))
        `.execute(trx);
        announceLock();
        await lockReleased;
      });
      await lockAcquired;

      let requestSettled = false;
      const request = postCatalogSync(app, token).then((response) => {
        requestSettled = true;
        return response;
      });
      let observedWaiter = false;
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const result = await sql<{ count: number }>`
            select count(*)::int as count
              from pg_stat_activity
             where datname = current_database()
               and pid <> pg_backend_pid()
               and wait_event_type = 'Lock'
               and wait_event = 'advisory'
               and query ilike '%pg_advisory_xact_lock%'
          `.execute(database);
          if ((result.rows[0]?.count ?? 0) > 0) {
            observedWaiter = true;
            break;
          }
          if (requestSettled) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(observedWaiter).toBe(true);
        expect(requestSettled).toBe(false);
      } finally {
        releaseLock();
        await holder;
      }

      const response = await request;
      expect(response.statusCode).toBe(202);
      expect(response.json<{ jobId: string }>().jobId).toMatch(/^[0-9a-f-]{36}$/u);
    });
  });

  it('reuses a running job and creates a new one after the previous job is terminal', async () => {
    await withSyncApp(async ({ app, adminId, token, database }) => {
      const existing = await database
        .insertInto('jobs')
        .values({
          type: 'catalog_sync',
          payload: { source: 'geofabrik' },
          status: 'running',
          created_by: adminId,
          locked_by: 'catalog-sync-test-worker',
          locked_at: new Date(),
          started_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const reused = await postCatalogSync(app, token);
      expect(reused.statusCode).toBe(202);
      expect(reused.json<{ jobId: string }>().jobId).toBe(existing.id);

      await database
        .updateTable('jobs')
        .set({ status: 'succeeded', finished_at: new Date() })
        .where('id', '=', existing.id)
        .execute();
      const next = await postCatalogSync(app, token);
      expect(next.statusCode).toBe(202);
      expect(next.json<{ jobId: string }>().jobId).not.toBe(existing.id);
    });
  });

  it('rejects non-empty bodies without enqueueing work', async () => {
    await withSyncApp(async ({ app, token, database }) => {
      const response = await postCatalogSync(app, token, { source: 'other' });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
      expect(
        await database.selectFrom('jobs').select('id').where('type', '=', 'catalog_sync').execute(),
      ).toEqual([]);
    });
  });
});
