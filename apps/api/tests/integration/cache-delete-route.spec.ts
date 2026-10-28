import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import {
  acquireCountryCacheStreamLock,
  cacheCountryAdvisoryLockKey,
  lockCountryCacheForEnqueue,
  releaseCountryCacheStreamLock,
} from '../../src/db/repositories/cache';
import { enqueueDownloadJob } from '../../src/modules/jobs/enqueue-download';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

interface DeleteHarness {
  readonly app: FastifyInstance;
  readonly token: string;
  readonly adminId: string;
  readonly countryId: string;
  readonly cacheDir: string;
  readonly versionPath: string;
}

async function withDeleteApp(run: (harness: DeleteHarness) => Promise<void>) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'cache-delete-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const token = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const country = await database.db
        .insertInto('countries')
        .values({
          source_id: 'europe/finland',
          parent_id: 'europe',
          slug: 'finland',
          name: 'Finland',
          iso_alpha2: ['FI'],
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await database.db
        .insertInto('country_cache')
        .values({
          country_id: country.id,
          is_public: true,
          public_since: new Date('2026-10-20T12:00:00.000Z'),
          versions_ready_count: 1,
          total_size_bytes: 100,
        })
        .execute();

      const cacheDir = await mkdtemp(join(tmpdir(), 'mapirror-cache-delete-'));
      const versionPath = join(cacheDir, 'finland', '261023', 'finland-261023.osm.pbf');
      await mkdir(join(cacheDir, 'finland', '261023'), { recursive: true });
      await writeFile(versionPath, Buffer.from('cached-map'));
      await database.db
        .insertInto('map_versions')
        .values({
          country_id: country.id,
          version: '261023',
          origin: 'geofabrik_snapshot',
          source_filename: 'finland-261023.osm.pbf',
          data_timestamp: new Date('2026-10-23T20:20:51.000Z'),
          file_size_bytes: 100,
          checksum_md5: '0123456789abcdef0123456789abcdef',
          storage_path: 'finland/261023/finland-261023.osm.pbf',
          status: 'ready',
          ready_at: new Date('2026-10-24T00:00:00.000Z'),
        })
        .execute();

      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name), CACHE_DIR: cacheDir }),
        database,
      });
      try {
        await run({
          app,
          token: token.token,
          adminId: admin.id,
          countryId: country.id,
          cacheDir,
          versionPath,
        });
      } finally {
        await app.close();
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
    { prefix: 'cachedeleteapi', migrate: true },
  );
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function deleteCountry(
  app: FastifyInstance,
  token: string | undefined,
  countryId: string,
  query = '',
  payload?: { readonly confirm: string },
): Promise<InjectResponse> {
  return app.inject({
    method: 'DELETE',
    url: `/_admin/api/cache/${countryId}${query}`,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function expectFileMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe.skipIf(skipReason !== null)('DELETE /_admin/api/cache/:countryId', () => {
  it('removes every version file and cache row, keeps the catalog country, and audits atomically', async () => {
    await withDeleteApp(async ({ app, token, countryId, versionPath, cacheDir, adminId }) => {
      const secondPath = join(cacheDir, 'finland', '260101', 'finland-260101.osm.pbf');
      await mkdir(join(cacheDir, 'finland', '260101'), { recursive: true });
      await writeFile(secondPath, Buffer.from('failed-map'));
      await app.db.db
        .insertInto('map_versions')
        .values({
          country_id: countryId,
          version: '260101',
          origin: 'geofabrik_snapshot',
          source_filename: 'finland-260101.osm.pbf',
          file_size_bytes: 0,
          storage_path: 'finland/260101/finland-260101.osm.pbf',
          status: 'failed',
        })
        .execute();

      const response = await deleteCountry(app, token, countryId, '?confirm=finland');
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      await expectFileMissing(versionPath);
      await expectFileMissing(secondPath);
      expect(
        await app.db.db
          .selectFrom('countries')
          .select('id')
          .where('id', '=', countryId)
          .executeTakeFirst(),
      ).toEqual({ id: countryId });
      expect(
        await app.db.db
          .selectFrom('country_cache')
          .select('country_id')
          .where('country_id', '=', countryId)
          .execute(),
      ).toEqual([]);
      expect(
        await app.db.db
          .selectFrom('map_versions')
          .select('id')
          .where('country_id', '=', countryId)
          .execute(),
      ).toEqual([]);
      const audit = await app.db.db
        .selectFrom('audit_logs')
        .select(['actor_id', 'actor_name', 'action', 'target_type', 'target_id', 'metadata'])
        .where('action', '=', 'cache.delete_country')
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({
        actor_id: adminId,
        actor_name: 'cache-delete-admin',
        action: 'cache.delete_country',
        target_type: 'country',
        target_id: countryId,
        metadata: {
          slug: 'finland',
          versionCount: 2,
          totalSizeBytes: '100',
          wasPublic: true,
        },
      });
    });
  });

  it('accepts the JSON confirmation body and rejects a mismatch without changing cache state', async () => {
    await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
      const wrong = await deleteCountry(app, token, countryId, '', { confirm: 'norway' });
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json()).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
      expect(
        await app.db.db.selectFrom('country_cache').select('country_id').execute(),
      ).toHaveLength(1);
      await expect(access(versionPath)).resolves.toBeUndefined();

      const deleted = await deleteCountry(app, token, countryId, '', { confirm: 'finland' });
      expect(deleted.statusCode).toBe(204);
      await expectFileMissing(versionPath);
    });
  });

  it('requires auth and rejects malformed params, unrecognized keys, and missing confirmation', async () => {
    await withDeleteApp(async ({ app, token, countryId }) => {
      const unauthenticated = await deleteCountry(app, undefined, countryId, '?confirm=finland');
      expect(unauthenticated.statusCode).toBe(401);
      const malformed = await deleteCountry(app, token, 'not-a-uuid', '?confirm=finland');
      expect(malformed.statusCode).toBe(400);
      const unknownQuery = await deleteCountry(
        app,
        token,
        countryId,
        '?confirm=finland&extra=true',
      );
      expect(unknownQuery.statusCode).toBe(400);
      const noConfirmation = await deleteCountry(app, token, countryId);
      expect(noConfirmation.statusCode).toBe(409);
      expect(noConfirmation.json()).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
      expect(
        await app.db.db.selectFrom('country_cache').select('country_id').execute(),
      ).toHaveLength(1);
    });
  });

  it('refuses active jobs unless asked to cancel, then waits for queued cancellation before unlinking', async () => {
    await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
      const job = await app.db.db
        .insertInto('jobs')
        .values({ type: 'download', payload: { countryId, version: '261024' } })
        .returning('id')
        .executeTakeFirstOrThrow();

      const refused = await deleteCountry(app, token, countryId, '?confirm=finland');
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: 'JOB_ALREADY_RUNNING' } });
      expect(
        await app.db.db.selectFrom('country_cache').select('country_id').execute(),
      ).toHaveLength(1);
      await expect(access(versionPath)).resolves.toBeUndefined();

      const deleted = await deleteCountry(
        app,
        token,
        countryId,
        '?confirm=finland&cancelJobs=true',
      );
      expect(deleted.statusCode).toBe(204);
      const canceled = await app.db.db
        .selectFrom('jobs')
        .select(['status', 'cancel_requested'])
        .where('id', '=', job.id)
        .executeTakeFirstOrThrow();
      expect(canceled).toMatchObject({ status: 'canceled', cancel_requested: true });
      await expectFileMissing(versionPath);
    });
  });

  it('commits the delete and reports an orphan instead of returning 500 on unlink failure', async () => {
    await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
      await rm(versionPath);
      await mkdir(versionPath);

      const response = await deleteCountry(app, token, countryId, '?confirm=finland');
      expect(response.statusCode).toBe(204);
      expect((await stat(versionPath)).isDirectory()).toBe(true);
      expect(
        await app.db.db
          .selectFrom('country_cache')
          .select('country_id')
          .where('country_id', '=', countryId)
          .execute(),
      ).toEqual([]);
    });
  });

  it('does not delete data while a running job has not completed cooperative cleanup', async () => {
    await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
      const job = await app.db.db
        .insertInto('jobs')
        .values({
          type: 'download',
          status: 'running',
          payload: { countryId, version: '261024' },
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const response = await deleteCountry(
        app,
        token,
        countryId,
        '?confirm=finland&cancelJobs=true',
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'JOB_ALREADY_RUNNING' } });
      expect(
        await app.db.db.selectFrom('country_cache').select('country_id').execute(),
      ).toHaveLength(1);
      await expect(access(versionPath)).resolves.toBeUndefined();
      expect(
        await app.db.db
          .selectFrom('jobs')
          .select(['status', 'cancel_requested'])
          .where('id', '=', job.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ status: 'running', cancel_requested: true });
    });
  }, 10_000);

  it('does not unlink a file until an active stream releases its shared country lock', async () => {
    await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
      await app.db.db.connection().execute(async (connection) => {
        await acquireCountryCacheStreamLock(connection, countryId);
        let streamLockHeld = true;
        let deletion: Promise<InjectResponse> | undefined;
        try {
          const currentDeletion = deleteCountry(app, token, countryId, '?confirm=finland');
          deletion = currentDeletion;
          await new Promise((resolve) => setTimeout(resolve, 100));
          await expect(access(versionPath)).resolves.toBeUndefined();
          expect(
            await connection
              .selectFrom('country_cache')
              .select('country_id')
              .where('country_id', '=', countryId)
              .execute(),
          ).toHaveLength(1);

          await releaseCountryCacheStreamLock(connection, countryId);
          streamLockHeld = false;
          expect((await currentDeletion).statusCode).toBe(204);
          await expect(access(versionPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          if (streamLockHeld) await releaseCountryCacheStreamLock(connection, countryId);
          await deletion?.catch(() => undefined);
        }
      });
    });
  });

  it('allows download admission to coexist with an active cached-file stream', async () => {
    await withDeleteApp(async ({ app, countryId }) => {
      await app.db.db.connection().execute(async (connection) => {
        await acquireCountryCacheStreamLock(connection, countryId);
        let streamLockHeld = true;
        let settled = false;
        let enqueued: Promise<string> | undefined;
        try {
          enqueued = enqueueDownloadJob(app.db.db, {
            countryId,
            version: '261024',
          }).then((jobId) => {
            settled = true;
            return jobId;
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(settled).toBe(true);
          expect(await enqueued).toMatch(/^[\da-f-]{36}$/iu);
        } finally {
          if (streamLockHeld) {
            await releaseCountryCacheStreamLock(connection, countryId);
            streamLockHeld = false;
          }
          await enqueued?.catch(() => undefined);
        }
      });
    });
  });

  it('holds download enqueue behind a cache-delete session lock until file cleanup can finish', async () => {
    await withDeleteApp(async ({ app, countryId }) => {
      const lockName = cacheCountryAdvisoryLockKey(countryId);
      await app.db.db.connection().execute(async (connection) => {
        await sql`
          select pg_advisory_lock(hashtextextended(${lockName}, 0))
        `.execute(connection);
        let settled = false;
        try {
          const enqueued = enqueueDownloadJob(app.db.db, {
            countryId,
            version: '261024',
          }).then((jobId) => {
            settled = true;
            return jobId;
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(settled).toBe(false);
          expect(
            await connection
              .selectFrom('jobs')
              .select('id')
              .where('type', '=', 'download')
              .execute(),
          ).toEqual([]);

          await sql`
            select pg_advisory_unlock(hashtextextended(${lockName}, 0))
          `.execute(connection);
          expect(await enqueued).toMatch(/^[\da-f-]{36}$/iu);
        } finally {
          if (!settled) {
            await sql`
              select pg_advisory_unlock(hashtextextended(${lockName}, 0))
            `.execute(connection);
          }
        }
      });
    });
  });

  it('serializes download enqueue against cache deletion on the shared advisory lock', async () => {
    await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
      const deletions: Promise<InjectResponse>[] = [];
      await app.db.db.transaction().execute(async (trx) => {
        await lockCountryCacheForEnqueue(trx, countryId);
        deletions.push(deleteCountry(app, token, countryId, '?confirm=finland'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        await trx
          .insertInto('jobs')
          .values({ type: 'download', payload: { countryId, version: '261024' } })
          .execute();
      });
      expect(deletions).toHaveLength(1);
      const response = await deletions[0]!;
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'JOB_ALREADY_RUNNING' } });
      await expect(access(versionPath)).resolves.toBeUndefined();
      expect(
        await app.db.db
          .selectFrom('country_cache')
          .select('country_id')
          .where('country_id', '=', countryId)
          .execute(),
      ).toHaveLength(1);

      await expect(
        enqueueDownloadJob(app.db.db, { countryId, version: '261024' }),
      ).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });
    });
  });
});
