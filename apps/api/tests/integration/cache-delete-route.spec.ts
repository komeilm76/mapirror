import { access, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import type { BuildAppOptions } from '../../src/app';
import {
  acquireCountryCacheStreamLock,
  cacheCountryAdvisoryLockKey,
  lockCountryCacheForEnqueue,
  releaseCountryCacheStreamLock,
} from '../../src/db/repositories/cache';
import { enqueueDownloadJob } from '../../src/modules/jobs/enqueue-download';
import { withCacheCountryMutationLock } from '../../src/modules/admin/cache-mutation-lock';
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

async function withDeleteApp(
  run: (harness: DeleteHarness) => Promise<void>,
  logger: BuildAppOptions['logger'] = false,
) {
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
        logger,
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

async function deleteVersion(
  app: FastifyInstance,
  token: string | undefined,
  countryId: string,
  versionId: string,
  query = '',
  payload?: Readonly<Record<string, unknown>>,
): Promise<InjectResponse> {
  return app.inject({
    method: 'DELETE',
    url: `/_admin/api/cache/${countryId}/versions/${versionId}${query}`,
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

  it('holds the exclusive cache lock until post-commit cleanup has finished', async () => {
    await withDeleteApp(async ({ app, countryId }) => {
      let cleanupStarted: () => void = () => {};
      let releaseCleanup: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        cleanupStarted = resolve;
      });
      const cleanup = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const mutation = app.db.db.connection().execute((connection) =>
        withCacheCountryMutationLock(connection, countryId, app.log, async () => {
          cleanupStarted();
          await cleanup;
        }),
      );
      await started;

      let enqueueSettled = false;
      const enqueue = enqueueDownloadJob(app.db.db, {
        countryId,
        version: '261024',
      }).then((jobId) => {
        enqueueSettled = true;
        return jobId;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(enqueueSettled).toBe(false);
      } finally {
        releaseCleanup();
      }
      await mutation;
      expect(await enqueue).toMatch(/^[\da-f-]{36}$/iu);
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

describe.skipIf(skipReason !== null)(
  'DELETE /_admin/api/cache/:countryId/versions/:versionId',
  () => {
    it('deletes only the selected file/row, recomputes cache facts, and writes the version audit', async () => {
      await withDeleteApp(async ({ app, token, adminId, countryId, cacheDir, versionPath }) => {
        const secondPath = join(cacheDir, 'finland', '261024', 'finland-261024.osm.pbf');
        await mkdir(join(cacheDir, 'finland', '261024'), { recursive: true });
        await writeFile(secondPath, Buffer.from('second-cached-map'));
        const second = await app.db.db
          .insertInto('map_versions')
          .values({
            country_id: countryId,
            version: '261024',
            origin: 'geofabrik_snapshot',
            source_filename: 'finland-261024.osm.pbf',
            file_size_bytes: 200,
            checksum_md5: 'fedcba9876543210fedcba9876543210',
            storage_path: 'finland/261024/finland-261024.osm.pbf',
            status: 'ready',
            ready_at: new Date('2026-10-25T00:00:00.000Z'),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await app.db.db
          .updateTable('country_cache')
          .set({
            versions_ready_count: 2,
            total_size_bytes: 300,
            update_state: 'update_available',
            available_version: '261024',
            available_size_bytes: 200,
            available_at: new Date('2026-10-25T00:00:00.000Z'),
          })
          .where('country_id', '=', countryId)
          .execute();

        const removed = await app.db.db
          .selectFrom('map_versions')
          .select(['id', 'version', 'file_size_bytes'])
          .where('country_id', '=', countryId)
          .where('version', '=', '261023')
          .executeTakeFirstOrThrow();
        await app.db.db
          .updateTable('map_versions')
          .set({ checksum_sha256: 'a'.repeat(64) })
          .where('id', '=', removed.id)
          .execute();
        const response = await deleteVersion(app, token, countryId, removed.id, '?confirm=true');
        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
        await expectFileMissing(versionPath);
        await expect(access(secondPath)).resolves.toBeUndefined();
        expect(
          await app.db.db
            .selectFrom('map_versions')
            .select('id')
            .where('country_id', '=', countryId)
            .execute(),
        ).toEqual([{ id: second.id }]);
        expect(
          await app.db.db
            .selectFrom('country_cache')
            .select([
              'is_public',
              'versions_ready_count',
              'total_size_bytes',
              'update_state',
              'available_version',
              'available_size_bytes',
              'available_at',
            ])
            .where('country_id', '=', countryId)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({
          is_public: true,
          versions_ready_count: 1,
          total_size_bytes: '200',
          update_state: 'unknown',
          available_version: null,
          available_size_bytes: null,
          available_at: null,
        });
        expect(
          await app.db.db
            .selectFrom('audit_logs')
            .select(['actor_id', 'actor_name', 'action', 'target_type', 'target_id', 'metadata'])
            .where('action', '=', 'version.delete')
            .executeTakeFirstOrThrow(),
        ).toMatchObject({
          actor_id: adminId,
          actor_name: 'cache-delete-admin',
          action: 'version.delete',
          target_type: 'map_version',
          target_id: removed.id,
          metadata: {
            countryId,
            slug: 'finland',
            version: '261023',
            origin: 'geofabrik_snapshot',
            status: 'ready',
            sizeBytes: '100',
            checksumMd5: '0123456789abcdef0123456789abcdef',
            checksumSha256: 'a'.repeat(64),
            wasLastVersion: false,
            wasPublic: true,
            unpublished: false,
          },
        });

        // Hard deletion releases the country/version unique key so a later redownload can create a new row.
        const replacement = await app.db.db
          .insertInto('map_versions')
          .values({
            country_id: countryId,
            version: '261023',
            origin: 'geofabrik_snapshot',
            source_filename: 'finland-261023.osm.pbf',
            file_size_bytes: 0,
            storage_path: 'finland/261023/finland-261023.osm.pbf',
            status: 'pending',
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        expect(replacement).toMatchObject({ version: '261023' });
        expect(replacement.id).not.toBe(removed.id);
      });
    });

    it('keeps the row and file when the transactional audit insert fails', async () => {
      await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
        const version = await app.db.db
          .selectFrom('map_versions')
          .select('id')
          .where('country_id', '=', countryId)
          .executeTakeFirstOrThrow();
        await sql`
          alter table audit_logs
          add constraint version_delete_audit_probe
          check (action <> 'version.delete') not valid
        `.execute(app.db.db);
        try {
          const response = await deleteVersion(app, token, countryId, version.id, '?confirm=true');
          expect(response.statusCode).toBe(500);
          await expect(access(versionPath)).resolves.toBeUndefined();
          expect(
            await app.db.db
              .selectFrom('map_versions')
              .select('id')
              .where('id', '=', version.id)
              .execute(),
          ).toEqual([{ id: version.id }]);
          expect(
            await app.db.db
              .selectFrom('country_cache')
              .select('country_id')
              .where('country_id', '=', countryId)
              .execute(),
          ).toEqual([{ country_id: countryId }]);
        } finally {
          await sql`alter table audit_logs drop constraint version_delete_audit_probe`.execute(
            app.db.db,
          );
        }
      });
    });

    it('deletes the cache row when the last version is removed but preserves catalog identity', async () => {
      await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
        const version = await app.db.db
          .selectFrom('map_versions')
          .select('id')
          .where('country_id', '=', countryId)
          .executeTakeFirstOrThrow();
        const response = await deleteVersion(app, token, countryId, version.id, '', {
          confirm: true,
        });
        expect(response.statusCode).toBe(204);
        await expectFileMissing(versionPath);
        expect(
          await app.db.db
            .selectFrom('country_cache')
            .select('country_id')
            .where('country_id', '=', countryId)
            .execute(),
        ).toEqual([]);
        expect(
          await app.db.db
            .selectFrom('countries')
            .select('id')
            .where('id', '=', countryId)
            .execute(),
        ).toEqual([{ id: countryId }]);
        expect(
          await app.db.db
            .selectFrom('audit_logs')
            .select('metadata')
            .where('action', '=', 'version.delete')
            .executeTakeFirstOrThrow(),
        ).toMatchObject({ metadata: { wasLastVersion: true, wasPublic: true } });
      });
    });

    it('auto-unpublishes if a ready version is deleted while only pending versions remain', async () => {
      await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
        await app.db.db
          .insertInto('map_versions')
          .values({
            country_id: countryId,
            version: 'pending-260101',
            origin: 'geofabrik_snapshot',
            source_filename: 'finland-260101.osm.pbf',
            file_size_bytes: 0,
            storage_path: 'finland/pending-260101/finland-260101.osm.pbf',
            status: 'pending',
          })
          .execute();
        const version = await app.db.db
          .selectFrom('map_versions')
          .select('id')
          .where('country_id', '=', countryId)
          .where('version', '=', '261023')
          .executeTakeFirstOrThrow();

        expect(
          (await deleteVersion(app, token, countryId, version.id, '?confirm=true')).statusCode,
        ).toBe(204);
        await expectFileMissing(versionPath);
        expect(
          await app.db.db
            .selectFrom('country_cache')
            .select([
              'is_public',
              'public_since',
              'versions_ready_count',
              'total_size_bytes',
              'update_state',
            ])
            .where('country_id', '=', countryId)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({
          is_public: false,
          public_since: null,
          versions_ready_count: 0,
          total_size_bytes: '0',
          update_state: 'unknown',
        });
      });
    });

    it('requires exact confirmation, admin auth, valid UUIDs, and a version belonging to the country', async () => {
      await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
        const version = await app.db.db
          .selectFrom('map_versions')
          .select('id')
          .where('country_id', '=', countryId)
          .executeTakeFirstOrThrow();
        for (const response of [
          await deleteVersion(app, token, countryId, version.id),
          await deleteVersion(app, token, countryId, version.id, '?confirm=false'),
          await deleteVersion(app, token, countryId, version.id, '', { confirm: false }),
          await deleteVersion(app, token, countryId, version.id, '?confirm=true', {
            confirm: false,
          }),
        ]) {
          expect(response.statusCode).toBe(409);
          expect(response.json()).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
        }
        const unknownQuery = await deleteVersion(
          app,
          token,
          countryId,
          version.id,
          '?confirm=true&unexpected=1',
        );
        expect(unknownQuery.statusCode).toBe(400);
        expect(unknownQuery.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
        const unknownBody = await deleteVersion(app, token, countryId, version.id, '', {
          confirm: true,
          unexpected: 'no',
        });
        expect(unknownBody.statusCode).toBe(400);
        expect(unknownBody.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
        expect(
          (await deleteVersion(app, undefined, countryId, version.id, '?confirm=true')).statusCode,
        ).toBe(401);
        const malformed = await deleteVersion(
          app,
          token,
          'bad-country',
          version.id,
          '?confirm=true',
        );
        expect(malformed.statusCode).toBe(400);
        expect(malformed.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
        const missing = await deleteVersion(
          app,
          token,
          countryId,
          '00000000-0000-4000-8000-000000000099',
          '?confirm=true',
        );
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        await expect(access(versionPath)).resolves.toBeUndefined();
      });
    });

    it('refuses an active country job and leaves the version row and file untouched', async () => {
      await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
        const version = await app.db.db
          .selectFrom('map_versions')
          .select('id')
          .where('country_id', '=', countryId)
          .executeTakeFirstOrThrow();
        await app.db.db
          .insertInto('jobs')
          .values({ type: 'download', payload: { countryId, version: '261024' } })
          .execute();
        const response = await deleteVersion(app, token, countryId, version.id, '?confirm=true');
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: { code: 'JOB_ALREADY_RUNNING' } });
        await expect(access(versionPath)).resolves.toBeUndefined();
        expect(
          await app.db.db
            .selectFrom('map_versions')
            .select('id')
            .where('id', '=', version.id)
            .execute(),
        ).toEqual([{ id: version.id }]);
      });
    });

    it('waits for active stream locks and returns 404 if a different country owns the version id', async () => {
      await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
        const version = await app.db.db
          .selectFrom('map_versions')
          .select('id')
          .where('country_id', '=', countryId)
          .executeTakeFirstOrThrow();
        await app.db.db
          .insertInto('map_versions')
          .values({
            country_id: countryId,
            version: 'pending-260102',
            origin: 'geofabrik_snapshot',
            source_filename: 'finland-pending-260102.osm.pbf',
            file_size_bytes: 0,
            storage_path: 'finland/pending-260102/finland-pending-260102.osm.pbf',
            status: 'pending',
          })
          .execute();
        await app.db.db.connection().execute(async (connection) => {
          await acquireCountryCacheStreamLock(connection, countryId);
          let streamLockHeld = true;
          let deletion: Promise<InjectResponse> | undefined;
          try {
            deletion = deleteVersion(app, token, countryId, version.id, '?confirm=true');
            await new Promise((resolve) => setTimeout(resolve, 100));
            await expect(access(versionPath)).resolves.toBeUndefined();
            expect(
              await app.db.db
                .selectFrom('map_versions')
                .select('id')
                .where('id', '=', version.id)
                .execute(),
            ).toEqual([{ id: version.id }]);
            await releaseCountryCacheStreamLock(connection, countryId);
            streamLockHeld = false;
            expect((await deletion).statusCode).toBe(204);
            await expectFileMissing(versionPath);
          } finally {
            if (streamLockHeld) await releaseCountryCacheStreamLock(connection, countryId);
            await deletion?.catch(() => undefined);
          }
        });

        const otherCountry = await app.db.db
          .insertInto('countries')
          .values({ source_id: 'europe/sweden', slug: 'sweden', name: 'Sweden' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const foreign = await app.db.db
          .insertInto('map_versions')
          .values({
            country_id: otherCountry.id,
            version: '260101',
            origin: 'geofabrik_snapshot',
            source_filename: 'sweden-260101.osm.pbf',
            file_size_bytes: 1,
            checksum_md5: '0123456789abcdef0123456789abcdef',
            storage_path: 'sweden/260101/sweden-260101.osm.pbf',
            status: 'ready',
            ready_at: new Date('2026-10-24T00:00:00.000Z'),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const crossCountry = await deleteVersion(
          app,
          token,
          countryId,
          foreign.id,
          '?confirm=true',
        );
        expect(crossCountry.statusCode).toBe(404);
        expect(crossCountry.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        expect(
          await app.db.db
            .selectFrom('map_versions')
            .select('id')
            .where('id', '=', foreign.id)
            .execute(),
        ).toEqual([{ id: foreign.id }]);
      });
    });

    it('returns 204 and logs incomplete cleanup without following an ancestor symlink', async () => {
      const logs: string[] = [];
      await withDeleteApp(
        async ({ app, token, countryId, cacheDir, versionPath }) => {
          const outside = join(cacheDir, 'outside');
          const outsideVersion = join(outside, '261023', 'finland-261023.osm.pbf');
          await mkdir(join(outside, '261023'), { recursive: true });
          await writeFile(outsideVersion, Buffer.from('not-under-cache-root'));
          await rm(join(cacheDir, 'finland'), { recursive: true, force: true });
          await symlink(outside, join(cacheDir, 'finland'), 'dir');

          const version = await app.db.db
            .selectFrom('map_versions')
            .select('id')
            .where('country_id', '=', countryId)
            .executeTakeFirstOrThrow();
          const response = await deleteVersion(app, token, countryId, version.id, '?confirm=true');

          expect(response.statusCode).toBe(204);
          await expectFileMissing(versionPath);
          await expect(access(join(cacheDir, 'finland'))).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(access(outsideVersion)).resolves.toBeUndefined();
        },
        { level: 'warn', stream: { write: (line) => logs.push(line) } },
      );
      expect(logs.join('')).toContain('ancestor symlink blocked leaf cleanup');
    });

    it('returns 204 and leaves an orphan for cleanup when unlink cannot remove the leaf', async () => {
      await withDeleteApp(async ({ app, token, countryId, versionPath }) => {
        const version = await app.db.db
          .selectFrom('map_versions')
          .select('id')
          .where('country_id', '=', countryId)
          .executeTakeFirstOrThrow();
        await rm(versionPath);
        await mkdir(versionPath);
        const response = await deleteVersion(app, token, countryId, version.id, '?confirm=true');
        expect(response.statusCode).toBe(204);
        expect((await stat(versionPath)).isDirectory()).toBe(true);
        expect(
          await app.db.db
            .selectFrom('map_versions')
            .select('id')
            .where('id', '=', version.id)
            .execute(),
        ).toEqual([]);
        expect(
          await app.db.db
            .selectFrom('audit_logs')
            .select('action')
            .where('action', '=', 'version.delete')
            .execute(),
        ).toEqual([{ action: 'version.delete' }]);
      });
    });
  },
);
