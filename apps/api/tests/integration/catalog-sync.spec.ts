import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { MapSource, SourceRegion } from '../../src/modules/geofabrik/source';
import {
  createCatalogSyncHandler,
  isCatalogSyncDue,
} from '../../src/modules/jobs/catalog-sync-handler';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const syncedAt = new Date('2026-06-01T12:00:00.000Z');

function sourceFor(regions: SourceRegion[]): MapSource {
  return {
    id: 'geofabrik',
    listRegions: (signal) =>
      signal?.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve(regions),
    getRegionDetail: () => Promise.reject(new Error('not used by catalog sync')),
    listSnapshots: () => Promise.reject(new Error('not used by catalog sync')),
    resolveDownload: () => Promise.reject(new Error('not used by catalog sync')),
  };
}

describe.skipIf(skipReason !== null)('PostgreSQL catalog sync job', () => {
  it('upserts repeatably, preserves assigned slugs, audits each success, and retains removed cached countries', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const removed = await db
          .insertInto('countries')
          .values({
            source: 'geofabrik',
            source_id: 'europe/old-area',
            slug: 'old-area',
            name: 'Old area',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await db.insertInto('country_cache').values({ country_id: removed.id }).execute();
        await db
          .insertInto('map_versions')
          .values({
            country_id: removed.id,
            version: '261001',
            origin: 'geofabrik_snapshot',
            source_filename: 'old-area-261001.osm.pbf',
            file_size_bytes: 42,
            checksum_md5: '0123456789abcdef0123456789abcdef',
            storage_path: 'old-area/261001.osm.pbf',
            status: 'ready',
            ready_at: syncedAt,
          })
          .execute();

        const firstRegions: SourceRegion[] = [
          {
            id: 'europe/finland',
            parentId: 'europe',
            name: 'Finland',
            isoAlpha2: ['FI'],
            isoOther: ['FI-01'],
            pbfUrl: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf',
          },
          {
            id: 'europe/sweden',
            parentId: 'europe',
            name: 'Sweden',
            isoAlpha2: ['SE'],
            isoOther: [],
            pbfUrl: 'https://download.geofabrik.de/europe/sweden-latest.osm.pbf',
          },
          {
            id: 'europe/georgia',
            parentId: 'europe',
            name: 'Georgia',
            isoAlpha2: [],
            isoOther: [],
            pbfUrl: null,
          },
          {
            id: 'asia/georgia',
            parentId: 'asia',
            name: 'Georgia',
            isoAlpha2: [],
            isoOther: [],
            pbfUrl: null,
          },
        ];
        const job = await db
          .insertInto('jobs')
          .values({ type: 'catalog_sync', payload: {} })
          .returningAll()
          .executeTakeFirstOrThrow();
        const controller = new AbortController();
        const handler = createCatalogSyncHandler({
          source: sourceFor(firstRegions),
          now: () => syncedAt,
        });
        const jobContext = {
          database: db,
          signal: controller.signal,
          reportProgress: () => Promise.resolve(),
        };

        await expect(handler(job, jobContext)).resolves.toEqual({
          source: 'geofabrik',
          syncedCount: 4,
        });
        const initial = await db
          .selectFrom('countries')
          .select(['source_id', 'slug', 'catalog_synced_at'])
          .where('source', '=', 'geofabrik')
          .orderBy('source_id')
          .execute();
        expect(initial).toHaveLength(5);
        expect(initial.find((row) => row.source_id === 'europe/finland')).toMatchObject({
          slug: 'finland',
        });

        const updatedRegions = firstRegions.map((region) =>
          region.id === 'europe/finland' ? { ...region, name: 'Republic of Finland' } : region,
        );
        const secondJob = await db
          .insertInto('jobs')
          .values({ type: 'catalog_sync', payload: { source: 'geofabrik' } })
          .returningAll()
          .executeTakeFirstOrThrow();
        await createCatalogSyncHandler({
          source: sourceFor(updatedRegions),
          now: () => new Date(syncedAt.getTime() + 60_000),
        })(secondJob, jobContext);

        const current = await db
          .selectFrom('countries')
          .select(['id', 'source_id', 'slug', 'name', 'catalog_synced_at'])
          .where('source', '=', 'geofabrik')
          .orderBy('source_id')
          .execute();
        expect(current).toHaveLength(5);
        expect(current.find((row) => row.source_id === 'europe/finland')).toMatchObject({
          slug: 'finland',
          name: 'Republic of Finland',
          catalog_synced_at: new Date(syncedAt.getTime() + 60_000),
        });
        const retained = current.find((row) => row.source_id === 'europe/old-area');
        expect(retained?.id).toBe(removed.id);
        expect(
          await db
            .selectFrom('country_cache')
            .select('country_id')
            .where('country_id', '=', removed.id)
            .execute(),
        ).toEqual([{ country_id: removed.id }]);
        expect(
          await db
            .selectFrom('map_versions')
            .select('country_id')
            .where('country_id', '=', removed.id)
            .execute(),
        ).toEqual([{ country_id: removed.id }]);

        const audits = await db
          .selectFrom('audit_logs')
          .select(['action', 'actor_name', 'target_type', 'target_id', 'metadata'])
          .where('action', '=', 'catalog.sync')
          .orderBy('id')
          .execute();
        expect(audits).toHaveLength(2);
        expect(audits[0]).toMatchObject({
          action: 'catalog.sync',
          actor_name: 'system',
          target_type: 'catalog',
          target_id: 'geofabrik',
          metadata: {
            source: 'geofabrik',
            regionCount: 4,
            slugResolutions: [
              { sourceId: 'asia/georgia', slug: 'asia-georgia' },
              { sourceId: 'europe/georgia', slug: 'europe-georgia' },
            ],
          },
        });
      },
      { migrate: true, prefix: 'catalogsync' },
    );
  });

  it('serializes concurrent sync jobs before slug lookup and upsert', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const regions: SourceRegion[] = [
          {
            id: 'europe/finland',
            parentId: 'europe',
            name: 'Finland',
            isoAlpha2: ['FI'],
            isoOther: [],
            pbfUrl: null,
          },
        ];
        const jobs = await Promise.all(
          [0, 1].map(() =>
            db
              .insertInto('jobs')
              .values({ type: 'catalog_sync', payload: {} })
              .returningAll()
              .executeTakeFirstOrThrow(),
          ),
        );
        const contextFor = () => ({
          database: db,
          signal: new AbortController().signal,
          reportProgress: () => Promise.resolve(),
        });
        const handlers = [
          createCatalogSyncHandler({ source: sourceFor(regions), now: () => syncedAt }),
          createCatalogSyncHandler({
            source: sourceFor(regions),
            now: () => new Date(syncedAt.getTime() + 1),
          }),
        ];

        const firstJob = jobs[0];
        const secondJob = jobs[1];
        const firstHandler = handlers[0];
        const secondHandler = handlers[1];
        if (
          firstJob === undefined ||
          secondJob === undefined ||
          firstHandler === undefined ||
          secondHandler === undefined
        ) {
          throw new Error('catalog sync concurrency fixtures were incomplete');
        }
        await Promise.all([
          firstHandler(firstJob, contextFor()),
          secondHandler(secondJob, contextFor()),
        ]);
        await expect(
          db.selectFrom('countries').select(['source_id', 'slug']).execute(),
        ).resolves.toEqual([{ source_id: 'europe/finland', slug: 'finland' }]);
        await expect(
          db.selectFrom('audit_logs').select('id').where('action', '=', 'catalog.sync').execute(),
        ).resolves.toHaveLength(2);
      },
      { migrate: true, prefix: 'catalograce' },
    );
  });

  it('cancels promptly while waiting for the per-source transaction lock', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const job = await db
          .insertInto('jobs')
          .values({ type: 'catalog_sync', payload: {} })
          .returningAll()
          .executeTakeFirstOrThrow();
        const controller = new AbortController();
        const handler = createCatalogSyncHandler({
          source: sourceFor([
            {
              id: 'europe/finland',
              parentId: 'europe',
              name: 'Finland',
              isoAlpha2: ['FI'],
              isoOther: [],
              pbfUrl: null,
            },
          ]),
        });

        await db.transaction().execute(async (trx) => {
          await sql`select pg_advisory_xact_lock(hashtextextended('mapirror.catalog_sync:geofabrik', 0))`.execute(
            trx,
          );
          const settled = handler(job, {
            database: db,
            signal: controller.signal,
            reportProgress: () => Promise.resolve(),
          }).then(
            () => 'resolved',
            () => 'rejected',
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          controller.abort(new Error('cancel while waiting for lock'));
          const outcome = await Promise.race([
            settled,
            new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 250)),
          ]);
          expect(outcome).toBe('rejected');
        });

        await expect(db.selectFrom('countries').selectAll().execute()).resolves.toEqual([]);
        await expect(db.selectFrom('audit_logs').selectAll().execute()).resolves.toEqual([]);
      },
      { migrate: true, prefix: 'cataloglockcancel' },
    );
  });

  it('rolls back every upsert when the required audit insert fails', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await db.schema
          .alterTable('audit_logs')
          .addCheckConstraint('test_reject_catalog_sync_audit', sql`action <> 'catalog.sync'`)
          .execute();
        const job = await db
          .insertInto('jobs')
          .values({ type: 'catalog_sync', payload: {} })
          .returningAll()
          .executeTakeFirstOrThrow();
        const handler = createCatalogSyncHandler({
          source: sourceFor([
            {
              id: 'europe/finland',
              parentId: 'europe',
              name: 'Finland',
              isoAlpha2: ['FI'],
              isoOther: [],
              pbfUrl: null,
            },
          ]),
          now: () => syncedAt,
        });

        await expect(
          handler(job, {
            database: db,
            signal: new AbortController().signal,
            reportProgress: () => Promise.resolve(),
          }),
        ).rejects.toMatchObject({ code: '23514', constraint: 'test_reject_catalog_sync_audit' });
        await expect(db.selectFrom('countries').selectAll().execute()).resolves.toEqual([]);
        await expect(db.selectFrom('settings').selectAll().execute()).resolves.toEqual([]);
        await expect(db.selectFrom('audit_logs').selectAll().execute()).resolves.toEqual([]);
      },
      { migrate: true, prefix: 'catalogaudit' },
    );
  });

  it('uses a durable sync marker for TTL and treats the exact boundary as due', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const now = new Date('2026-06-01T12:00:00.000Z');
        await expect(isCatalogSyncDue(db, 60, now)).resolves.toBe(true);
        const queued = await db
          .insertInto('jobs')
          .values({ type: 'catalog_sync', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();
        await expect(isCatalogSyncDue(db, 60, now)).resolves.toBe(false);
        await db
          .updateTable('jobs')
          .set({ status: 'canceled' })
          .where('id', '=', queued.id)
          .execute();
        await expect(isCatalogSyncDue(db, 60, now)).resolves.toBe(true);
        await db
          .insertInto('jobs')
          .values({ type: 'catalog_sync', status: 'failed', payload: {}, finished_at: now })
          .execute();
        await db
          .insertInto('jobs')
          .values({ type: 'download', status: 'succeeded', payload: {}, finished_at: now })
          .execute();
        await expect(isCatalogSyncDue(db, 60, now)).resolves.toBe(true);
        await db
          .insertInto('settings')
          .values({ key: 'source.catalogSyncedAt', value: { malformed: true } })
          .execute();
        await expect(isCatalogSyncDue(db, 60, now)).resolves.toBe(true);
        await db
          .updateTable('settings')
          .set({ value: JSON.stringify('2026-6-1') })
          .where('key', '=', 'source.catalogSyncedAt')
          .execute();
        await expect(isCatalogSyncDue(db, 60, now)).resolves.toBe(true);
        await db.deleteFrom('settings').where('key', '=', 'source.catalogSyncedAt').execute();

        await db
          .insertInto('settings')
          .values({
            key: 'source.catalogSyncedAt',
            value: JSON.stringify(new Date(now.getTime() - 59 * 60_000).toISOString()),
          })
          .execute();
        await db.deleteFrom('jobs').where('type', '=', 'catalog_sync').execute();
        await expect(isCatalogSyncDue(db, 60, now)).resolves.toBe(false);
        await expect(isCatalogSyncDue(db, 60, new Date(now.getTime() + 60_000))).resolves.toBe(
          true,
        );
        await expect(isCatalogSyncDue(db, 0, now)).rejects.toThrow(RangeError);
      },
      { migrate: true, prefix: 'catalogttl' },
    );
  });

  it('supports a successful empty catalog without inferring freshness from country rows', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const job = await db
          .insertInto('jobs')
          .values({ type: 'catalog_sync', payload: {} })
          .returningAll()
          .executeTakeFirstOrThrow();
        const result = await createCatalogSyncHandler({
          source: sourceFor([]),
          now: () => syncedAt,
        })(job, {
          database: db,
          signal: new AbortController().signal,
          reportProgress: () => Promise.resolve(),
        });
        expect(result).toEqual({ source: 'geofabrik', syncedCount: 0 });
        expect(await db.selectFrom('countries').selectAll().execute()).toEqual([]);
        expect(await db.selectFrom('audit_logs').select('action').execute()).toEqual([
          { action: 'catalog.sync' },
        ]);

        await expect(
          db
            .selectFrom('settings')
            .select('value')
            .where('key', '=', 'source.catalogSyncedAt')
            .executeTakeFirst(),
        ).resolves.toEqual({ value: syncedAt.toISOString() });
        await db.deleteFrom('jobs').where('id', '=', job.id).execute();
        await expect(isCatalogSyncDue(db, 360, syncedAt)).resolves.toBe(false);
      },
      { migrate: true, prefix: 'catalogempty' },
    );
  });
});
