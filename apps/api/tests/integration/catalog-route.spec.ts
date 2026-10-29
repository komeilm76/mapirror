import { performance } from 'node:perf_hooks';

import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

async function withCatalogApp(
  run: (context: { app: FastifyInstance; token: string }) => Promise<void>,
) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'catalog-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const token = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
      });
      try {
        await run({ app, token: token.token });
      } finally {
        await app.close();
      }
    },
    { prefix: 'catalogapi', migrate: true },
  );
}

function getCatalog(app: FastifyInstance, token: string, query = '') {
  return app.inject({
    method: 'GET',
    url: `/_admin/api/catalog${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe.skipIf(skipReason !== null)('GET /_admin/api/catalog', () => {
  it('projects the catalog, cache summary, ISO codes, and durable freshness marker', async () => {
    await withCatalogApp(async ({ app, token }) => {
      const db = app.db.db;
      const countries = await db
        .insertInto('countries')
        .values([
          {
            source_id: 'europe/finland',
            parent_id: 'europe',
            slug: 'finland',
            name: 'Finland',
            iso_alpha2: ['FI'],
            iso_other: ['FI-01'],
            source_size_hint_bytes: 773_465_008,
            catalog_synced_at: new Date('2026-10-24T06:00:00.000Z'),
          },
          {
            source_id: 'europe/norway',
            parent_id: 'europe',
            slug: 'norway',
            name: 'Norway',
            iso_alpha2: ['NO'],
            source_size_hint_bytes: 900,
            catalog_synced_at: new Date('2026-10-24T06:00:00.000Z'),
          },
          {
            source_id: 'europe/sweden',
            parent_id: 'europe',
            slug: 'sweden',
            name: 'Sweden',
            iso_alpha2: ['SE'],
            source_size_hint_bytes: 100,
            catalog_synced_at: new Date('2026-10-24T06:00:00.000Z'),
          },
        ])
        .returning(['id', 'slug'])
        .execute();
      const finland = countries.find(({ slug }) => slug === 'finland');
      expect(finland).toBeDefined();
      await db
        .insertInto('country_cache')
        .values({
          country_id: finland!.id,
          is_public: true,
          update_state: 'update_available',
          available_version: '261024',
          available_size_bytes: 774_000_000,
          versions_ready_count: 3,
          total_size_bytes: 2_319_000_000,
        })
        .execute();
      const syncedAt = '2026-10-24T06:00:00.000Z';
      await db
        .insertInto('settings')
        .values({ key: 'source.catalogSyncedAt', value: JSON.stringify(syncedAt) })
        .execute();

      const response = await getCatalog(app, token);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: [
          {
            countryId: finland!.id,
            sourceId: 'europe/finland',
            name: 'Finland',
            slug: 'finland',
            continent: 'europe',
            iso: ['FI', 'FI-01'],
            sourceSizeHintBytes: 773_465_008,
            cache: {
              cached: true,
              versionsReady: 3,
              totalSizeBytes: 2_319_000_000,
              isPublic: true,
              updateState: 'update_available',
              availableVersion: '261024',
              availableSizeBytes: 774_000_000,
            },
            lastSyncedAt: syncedAt,
          },
          {
            countryId: countries.find(({ slug }) => slug === 'norway')!.id,
            sourceId: 'europe/norway',
            name: 'Norway',
            slug: 'norway',
            continent: 'europe',
            iso: ['NO'],
            sourceSizeHintBytes: 900,
            cache: {
              cached: false,
              versionsReady: 0,
              totalSizeBytes: 0,
              isPublic: false,
              updateState: 'unknown',
              availableVersion: null,
              availableSizeBytes: null,
            },
            lastSyncedAt: syncedAt,
          },
          {
            countryId: countries.find(({ slug }) => slug === 'sweden')!.id,
            sourceId: 'europe/sweden',
            name: 'Sweden',
            slug: 'sweden',
            continent: 'europe',
            iso: ['SE'],
            sourceSizeHintBytes: 100,
            cache: {
              cached: false,
              versionsReady: 0,
              totalSizeBytes: 0,
              isPublic: false,
              updateState: 'unknown',
              availableVersion: null,
              availableSizeBytes: null,
            },
            lastSyncedAt: syncedAt,
          },
        ],
        meta: { page: 1, limit: 50, total: 3, totalPages: 1 },
        catalogSyncedAt: syncedAt,
      });
    });
  });

  it('applies name/ISO search, filters, stable sorting, and pagination in SQL', async () => {
    await withCatalogApp(async ({ app, token }) => {
      const db = app.db.db;
      await db
        .insertInto('countries')
        .values([
          {
            source_id: 'europe/finland',
            parent_id: 'europe',
            slug: 'finland',
            name: 'Finland',
            iso_alpha2: ['FI'],
            iso_other: ['FI-01'],
            source_size_hint_bytes: 500,
            catalog_synced_at: new Date('2026-01-01T00:00:00.000Z'),
            created_at: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            source_id: 'europe/norway',
            parent_id: 'europe',
            slug: 'norway',
            name: 'Norway',
            iso_alpha2: ['NO'],
            source_size_hint_bytes: 900,
            catalog_synced_at: new Date('2026-01-02T00:00:00.000Z'),
            created_at: new Date('2026-01-02T00:00:00.000Z'),
          },
          {
            source_id: 'europe/sweden',
            parent_id: 'europe',
            slug: 'sweden',
            name: 'Sweden',
            iso_alpha2: ['SE'],
            source_size_hint_bytes: 100,
            catalog_synced_at: new Date('2026-01-03T00:00:00.000Z'),
            created_at: new Date('2026-01-03T00:00:00.000Z'),
          },
          {
            source_id: 'asia/japan',
            parent_id: 'asia',
            slug: 'japan',
            name: 'Japan',
            iso_alpha2: ['JP'],
            source_size_hint_bytes: 250,
            catalog_synced_at: new Date('2026-01-04T00:00:00.000Z'),
            created_at: new Date('2026-01-04T00:00:00.000Z'),
          },
        ])
        .execute();
      const finland = await db
        .selectFrom('countries')
        .select('id')
        .where('slug', '=', 'finland')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('country_cache')
        .values({
          country_id: finland.id,
          update_state: 'update_available',
          versions_ready_count: 1,
          total_size_bytes: 450,
        })
        .execute();

      const nameSearch = await getCatalog(app, token, '?q=fin');
      expect(
        nameSearch.json<{ data: { slug: string }[]; meta: { total: number } }>(),
      ).toMatchObject({
        data: [{ slug: 'finland' }],
        meta: { total: 1 },
      });
      const isoSearch = await getCatalog(app, token, '?q=se');
      expect(isoSearch.json<{ data: { slug: string }[] }>().data.map(({ slug }) => slug)).toEqual([
        'sweden',
      ]);
      const subdivisionIsoSearch = await getCatalog(app, token, '?q=FI-01');
      expect(
        subdivisionIsoSearch.json<{ data: { slug: string }[] }>().data.map(({ slug }) => slug),
      ).toEqual(['finland']);
      const uncachedEurope = await getCatalog(app, token, '?continent=europe&cache=uncached');
      expect(
        uncachedEurope.json<{ data: { slug: string }[] }>().data.map(({ slug }) => slug),
      ).toEqual(['norway', 'sweden']);
      const available = await getCatalog(app, token, '?update=available');
      expect(available.json<{ data: { slug: string }[] }>().data.map(({ slug }) => slug)).toEqual([
        'finland',
      ]);
      const sourceSize = await getCatalog(app, token, '?sort=size&order=desc&limit=2');
      expect(sourceSize.json<{ data: { slug: string }[] }>().data.map(({ slug }) => slug)).toEqual([
        'norway',
        'finland',
      ]);
      const updatedDesc = await getCatalog(app, token, '?sort=updated&order=desc&limit=2');
      expect(updatedDesc.json<{ data: { slug: string }[] }>().data.map(({ slug }) => slug)).toEqual(
        ['japan', 'sweden'],
      );
      const createdDesc = await getCatalog(app, token, '?sort=created&order=desc&limit=2');
      expect(createdDesc.json<{ data: { slug: string }[] }>().data.map(({ slug }) => slug)).toEqual(
        ['japan', 'sweden'],
      );
      const noMatches = await getCatalog(app, token, '?q=no-such-region');
      expect(noMatches.json<{ meta: { total: number; totalPages: number } }>().meta).toMatchObject({
        total: 0,
        totalPages: 0,
      });
      const clamped = await getCatalog(app, token, '?page=0&limit=1000');
      expect(
        clamped.json<{ meta: { page: number; limit: number; totalPages: number } }>().meta,
      ).toEqual({
        page: 1,
        limit: 100,
        total: 4,
        totalPages: 1,
      });
      const invalidNumeric = await getCatalog(app, token, '?page=1e2&limit=0x10');
      expect(invalidNumeric.json<{ meta: { page: number; limit: number } }>().meta).toMatchObject({
        page: 1,
        limit: 50,
      });
      const wildcardLiteral = await getCatalog(app, token, '?q=%25');
      expect(wildcardLiteral.json<{ data: unknown[]; meta: { total: number } }>().meta.total).toBe(
        0,
      );
    });
  });

  it('searches partial names and ISO codes, with optional accent folding through the route', async () => {
    await withCatalogApp(async ({ app, token }) => {
      await app.db.db
        .insertInto('countries')
        .values({
          source_id: 'europe/aland',
          parent_id: 'europe',
          slug: 'aland-islands',
          name: 'Åland Islands',
          iso_alpha2: ['AX'],
          iso_other: ['AX-01'],
        })
        .execute();

      const partialName = await getCatalog(app, token, '?q=land');
      expect(
        partialName.json<{ data: { slug: string }[]; meta: { total: number } }>(),
      ).toMatchObject({ data: [{ slug: 'aland-islands' }], meta: { total: 1 } });

      const isoCode = await getCatalog(app, token, '?q=ax');
      expect(isoCode.json<{ data: { slug: string }[] }>().data.map(({ slug }) => slug)).toEqual([
        'aland-islands',
      ]);

      const unaccent = await sql<{ available: boolean }>`
        select to_regprocedure('unaccent(text)') is not null as available
      `.execute(app.db.db);
      const accentInsensitive = await getCatalog(app, token, '?q=aland');
      const accentResult = accentInsensitive.json<{
        data: { slug: string }[];
        meta: { total: number };
      }>();
      expect(accentResult.data.map(({ slug }) => slug)).toEqual(
        unaccent.rows[0]!.available ? ['aland-islands'] : [],
      );
      expect(accentResult.meta.total).toBe(unaccent.rows[0]!.available ? 1 : 0);
    });
  });

  it('returns validation errors for invalid filters, sort keys, unknown keys, and excessive search text', async () => {
    await withCatalogApp(async ({ app, token }) => {
      for (const query of [
        '?cache=maybe',
        '?update=never',
        '?sort=password_hash',
        '?q=anything&debug=1',
        `?q=${'a'.repeat(129)}`,
      ]) {
        const response = await getCatalog(app, token, query);
        expect(response.statusCode, query).toBe(400);
        expect(response.json<{ error: { code: string } }>().error.code, query).toBe(
          'VALIDATION_ERROR',
        );
      }
    });
  });

  it('returns null freshness for missing/malformed markers and exact decimal strings for large bytes', async () => {
    await withCatalogApp(async ({ app, token }) => {
      const db = app.db.db;
      const country = await db
        .insertInto('countries')
        .values({
          source_id: 'europe/large',
          parent_id: 'europe',
          slug: 'large',
          name: 'Large Region',
          source_size_hint_bytes: '9223372036854775807',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('country_cache')
        .values({ country_id: country.id, total_size_bytes: '9223372036854775807' })
        .execute();

      let response = await getCatalog(app, token);
      expect(response.statusCode).toBe(200);
      expect(
        response.json<{
          catalogSyncedAt: string | null;
          data: {
            sourceSizeHintBytes: number | string;
            cache: { totalSizeBytes: number | string };
          }[];
        }>(),
      ).toMatchObject({
        catalogSyncedAt: null,
        data: [
          {
            sourceSizeHintBytes: '9223372036854775807',
            cache: { totalSizeBytes: '9223372036854775807' },
          },
        ],
      });

      await db
        .insertInto('settings')
        .values({ key: 'source.catalogSyncedAt', value: { malformed: true } })
        .execute();
      response = await getCatalog(app, token);
      expect(response.json<{ catalogSyncedAt: string | null }>().catalogSyncedAt).toBeNull();
    });
  });

  it('returns a bounded page under the 300 ms target for a 400-row catalog', async () => {
    await withCatalogApp(async ({ app, token }) => {
      await sql`
        insert into countries (source_id, parent_id, slug, name, source_size_hint_bytes)
        select 'europe/region-' || n::text,
               'europe',
               'region-' || n::text,
               'Region ' || n::text,
               n
        from generate_series(1, 400) as series(n)
      `.execute(app.db.db);
      // Warm the pool and PostgreSQL plan/cache before measuring the requested workload.
      await getCatalog(app, token);
      const started = performance.now();
      const response = await getCatalog(app, token);
      const elapsedMs = performance.now() - started;
      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: unknown[]; meta: { total: number; limit: number } }>();
      expect(body.meta).toMatchObject({ total: 400, limit: 50 });
      expect(body.data).toHaveLength(50);
      expect(elapsedMs).toBeLessThan(300);
    });
  });
});
