import { CacheDetailResponseSchema, CacheListResponseSchema } from '@mapirror/shared';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

async function withCacheApp(
  run: (context: { app: FastifyInstance; token: string; countryId: string }) => Promise<void>,
) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'cache-api-admin', password_hash: 'unused' })
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
          iso_other: ['FI-01'],
          source_size_hint_bytes: 773_465_008,
          catalog_synced_at: new Date('2026-10-24T06:00:00.000Z'),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await database.db
        .insertInto('country_cache')
        .values({
          country_id: country.id,
          is_public: true,
          public_since: new Date('2026-10-20T12:00:00.000Z'),
          update_state: 'update_available',
          available_version: '261024',
          available_size_bytes: 774_000_000,
          update_checked_at: new Date('2026-10-24T06:00:00.000Z'),
          versions_ready_count: 1,
          total_size_bytes: 9_007_199_254_740_993n,
          created_at: new Date('2026-10-21T12:00:00.000Z'),
        })
        .execute();

      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
      });
      try {
        await run({ app, token: token.token, countryId: country.id });
      } finally {
        await app.close();
      }
    },
    { prefix: 'cacheapi', migrate: true },
  );
}

function getCache(app: FastifyInstance, token: string, query = '') {
  return app.inject({
    method: 'GET',
    url: `/_admin/api/cache${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function getCacheDetail(app: FastifyInstance, token: string, countryId: string) {
  return app.inject({
    method: 'GET',
    url: `/_admin/api/cache/${countryId}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function insertVersion(
  app: FastifyInstance,
  countryId: string,
  values: {
    version: string;
    origin?: 'geofabrik_snapshot' | 'geofabrik_latest' | 'upload';
    status?: 'ready' | 'pending' | 'failed';
    readyAt?: Date | null;
  },
) {
  return app.db.db
    .insertInto('map_versions')
    .values({
      country_id: countryId,
      version: values.version,
      origin: values.origin ?? 'geofabrik_snapshot',
      source_filename: `${values.version}.osm.pbf`,
      file_size_bytes: 7_734_650_008,
      checksum_md5: '0123456789abcdef0123456789abcdef',
      storage_path: `finland/${values.version}/${values.version}.osm.pbf`,
      status: values.status ?? 'ready',
      ready_at: values.readyAt ?? new Date('2026-10-23T20:20:51.000Z'),
      created_at: new Date('2026-10-23T20:00:00.000Z'),
      data_timestamp: new Date('2026-10-23T19:59:00.000Z'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

describe.skipIf(skipReason !== null)('GET /_admin/api/cache', () => {
  it('returns only cached catalog rows, cache timestamps, and latest successful source download', async () => {
    await withCacheApp(async ({ app, token, countryId }) => {
      await insertVersion(app, countryId, {
        version: '261023',
        readyAt: new Date('2026-10-23T20:20:51.000Z'),
      });
      await insertVersion(app, countryId, {
        version: 'upload-1',
        origin: 'upload',
        readyAt: new Date('2026-10-25T20:20:51.000Z'),
      });
      await insertVersion(app, countryId, {
        version: 'pending-1',
        status: 'pending',
        readyAt: new Date('2026-10-26T20:20:51.000Z'),
      });
      await app.db.db
        .insertInto('countries')
        .values({
          source_id: 'europe/norway',
          parent_id: 'europe',
          slug: 'norway',
          name: 'Norway',
          iso_alpha2: ['NO'],
        })
        .execute();

      const response = await getCache(app, token);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: [
          {
            countryId,
            sourceId: 'europe/finland',
            name: 'Finland',
            slug: 'finland',
            continent: 'europe',
            iso: ['FI', 'FI-01'],
            sourceSizeHintBytes: 773_465_008,
            cache: {
              cached: true,
              versionsReady: 1,
              totalSizeBytes: '9007199254740993',
              isPublic: true,
              updateState: 'update_available',
              availableVersion: '261024',
              availableSizeBytes: 774_000_000,
            },
            lastSyncedAt: '2026-10-24T06:00:00.000Z',
            lastCheckedAt: '2026-10-24T06:00:00.000Z',
            createdAt: '2026-10-21T12:00:00.000Z',
            mostRecentDownloadAt: '2026-10-23T20:20:51.000Z',
          },
        ],
        meta: { page: 1, limit: 50, total: 1, totalPages: 1 },
      });
    });
  });

  it('applies catalog search, update filters and pagination to the cached-only set', async () => {
    await withCacheApp(async ({ app, token }) => {
      const finland = await app.db.db
        .selectFrom('countries')
        .select('id')
        .where('slug', '=', 'finland')
        .executeTakeFirstOrThrow();
      await app.db.db
        .insertInto('countries')
        .values([
          {
            source_id: 'europe/sweden',
            parent_id: 'europe',
            slug: 'sweden',
            name: 'Sweden',
            iso_alpha2: ['SE'],
          },
          {
            source_id: 'europe/norway',
            parent_id: 'europe',
            slug: 'norway',
            name: 'Norway',
            iso_alpha2: ['NO'],
          },
        ])
        .execute();
      const added = await app.db.db
        .selectFrom('countries')
        .select(['id', 'slug'])
        .where('slug', 'in', ['sweden', 'norway'])
        .execute();
      await app.db.db
        .insertInto('country_cache')
        .values({ country_id: added.find(({ slug }) => slug === 'sweden')!.id })
        .execute();
      expect(finland.id).toBeTruthy();

      const filtered = await getCache(app, token, '?q=fi&update=available&limit=1');
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json()).toMatchObject({
        data: [{ slug: 'finland' }],
        meta: { page: 1, limit: 1, total: 1, totalPages: 1 },
      });
      const cachedRows = await getCache(app, token, '?sort=name');
      expect(cachedRows.statusCode).toBe(200);
      expect(CacheListResponseSchema.parse(cachedRows.json()).data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: 'sweden', mostRecentDownloadAt: null }),
        ]),
      );
      const uncachedFilter = await getCache(app, token, '?cache=uncached');
      expect(uncachedFilter.statusCode).toBe(400);
    });
  });

  it('sorts the cache size column by local cached bytes rather than source-size hints', async () => {
    await withCacheApp(async ({ app, token }) => {
      await app.db.db
        .insertInto('countries')
        .values([
          {
            source_id: 'europe/sweden',
            parent_id: 'europe',
            slug: 'sweden',
            name: 'Sweden',
            source_size_hint_bytes: 10_000_000_000,
          },
          {
            source_id: 'europe/norway',
            parent_id: 'europe',
            slug: 'norway',
            name: 'Norway',
            source_size_hint_bytes: 20_000_000_000,
          },
        ])
        .execute();
      const added = await app.db.db
        .selectFrom('countries')
        .select(['id', 'slug'])
        .where('slug', 'in', ['sweden', 'norway'])
        .execute();
      await app.db.db
        .insertInto('country_cache')
        .values([
          { country_id: added.find(({ slug }) => slug === 'sweden')!.id, total_size_bytes: 100 },
          { country_id: added.find(({ slug }) => slug === 'norway')!.id, total_size_bytes: 300 },
        ])
        .execute();

      const response = await getCache(app, token, '?sort=size&order=asc');
      expect(response.statusCode).toBe(200);
      expect(CacheListResponseSchema.parse(response.json()).data.map(({ slug }) => slug)).toEqual([
        'sweden',
        'norway',
        'finland',
      ]);
    });
  });

  it('rejects unauthenticated requests and unknown query keys', async () => {
    await withCacheApp(async ({ app, token }) => {
      const unauthorized = await app.inject({ method: 'GET', url: '/_admin/api/cache' });
      expect(unauthorized.statusCode).toBe(401);
      const invalid = await getCache(app, token, '?unexpected=true');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });
  });
});

describe.skipIf(skipReason !== null)('GET /_admin/api/cache/:countryId', () => {
  it('returns cache update state, ready versions, and only queued/running jobs for this country', async () => {
    await withCacheApp(async ({ app, token, countryId }) => {
      const version = await insertVersion(app, countryId, { version: '261023' });
      const otherCountry = await app.db.db
        .insertInto('countries')
        .values({ source_id: 'europe/norway', slug: 'norway', name: 'Norway' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const jobs = await app.db.db
        .insertInto('jobs')
        .values([
          {
            type: 'download',
            status: 'running',
            payload: { countryId, version: '261024' },
            progress_bytes: 123_456_789,
            total_bytes: 774_000_000,
          },
          {
            type: 'update_check',
            status: 'queued',
            payload: { countryId },
            progress_bytes: 0,
            total_bytes: null,
          },
          {
            type: 'download',
            status: 'failed',
            payload: { countryId, version: '260101' },
          },
          {
            type: 'download',
            status: 'running',
            payload: { countryId: otherCountry.id, version: '261024' },
          },
        ])
        .returning(['id', 'status', 'type'])
        .execute();
      const runningDownload = jobs.find(
        ({ status, type }) => status === 'running' && type === 'download',
      );
      const queuedUpdate = jobs.find(
        ({ status, type }) => status === 'queued' && type === 'update_check',
      );

      const response = await getCacheDetail(app, token, countryId);
      expect(response.statusCode).toBe(200);
      const detail = CacheDetailResponseSchema.parse(response.json());
      expect(detail).toMatchObject({
        country: {
          countryId,
          name: 'Finland',
          slug: 'finland',
          sourceId: 'europe/finland',
          iso: ['FI', 'FI-01'],
        },
        cache: {
          isPublic: true,
          publicSince: '2026-10-20T12:00:00.000Z',
          totalSizeBytes: '9007199254740993',
          versionsReady: 1,
          updateState: 'update_available',
          availableVersion: '261024',
          availableSizeBytes: 774_000_000,
          updateCheckedAt: '2026-10-24T06:00:00.000Z',
        },
        versions: [
          {
            id: version.id,
            version: '261023',
            origin: 'geofabrik_snapshot',
            dataTimestamp: '2026-10-23T19:59:00.000Z',
            sizeBytes: 7_734_650_008,
            checksumMd5: '0123456789abcdef0123456789abcdef',
            status: 'ready',
            createdAt: '2026-10-23T20:00:00.000Z',
          },
        ],
      });
      expect(detail.activeJobs).toHaveLength(2);
      expect(detail.activeJobs.find(({ type }) => type === 'download')).toMatchObject({
        id: runningDownload!.id,
        status: 'running',
        progressBytes: 123_456_789,
        totalBytes: 774_000_000,
      });
      expect(detail.activeJobs.find(({ type }) => type === 'update_check')).toMatchObject({
        id: queuedUpdate!.id,
        status: 'queued',
        progressBytes: 0,
        totalBytes: null,
      });
    });
  });

  it('returns documented errors for an uncached, unknown, or malformed country id', async () => {
    await withCacheApp(async ({ app, token }) => {
      const uncached = await app.db.db
        .insertInto('countries')
        .values({ source_id: 'europe/norway', slug: 'norway', name: 'Norway' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const uncachedResponse = await getCacheDetail(app, token, uncached.id);
      expect(uncachedResponse.statusCode).toBe(404);
      expect(uncachedResponse.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

      const unknownResponse = await getCacheDetail(
        app,
        token,
        '00000000-0000-4000-8000-000000000099',
      );
      expect(unknownResponse.statusCode).toBe(404);
      const malformedResponse = await getCacheDetail(app, token, 'not-a-uuid');
      expect(malformedResponse.statusCode).toBe(400);
      expect(malformedResponse.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });
  });
});
