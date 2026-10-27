import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  findCountryBySlug,
  listCatalogCountries,
  upsertCatalogCountry,
} from '../../src/db/repositories/catalog';
import {
  findCachedCountry,
  findCountryCache,
  listCachedCountries,
} from '../../src/db/repositories/cache';
import {
  findMapVersionById,
  findMapVersionByLabel,
  listMapVersions,
} from '../../src/db/repositories/map-versions';
import { withTransaction } from '../../src/db/transaction';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/** These repositories are measured against PostgreSQL so joins, ILIKE/array search, COUNT and UUIDs use real semantics. */
const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('catalog, cache and version repositories', () => {
  it('filters, searches, sorts, counts and paginates in PostgreSQL', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await seedCatalog(db);

        const partialName = await listCatalogCountries(db, { search: 'fin', limit: 10 });
        expect(partialName.rows.map(({ slug }) => slug)).toEqual(['finland']);
        expect(partialName.total).toBe('1');

        const isoCode = await listCatalogCountries(db, { search: 'se', limit: 10 });
        expect(isoCode.rows.map(({ slug }) => slug)).toEqual(['sweden']);
        expect(isoCode.total).toBe('1');

        // LIKE metacharacters in user text are literals, not a way to turn a search into "match everything".
        const literalWildcard = await listCatalogCountries(db, { search: '%', limit: 10 });
        expect(literalWildcard.rows).toEqual([]);
        expect(literalWildcard.total).toBe('0');

        const uncached = await listCatalogCountries(db, { cache: 'uncached', limit: 10 });
        expect(uncached.rows.map(({ slug }) => slug)).toEqual(['norway']);
        expect(uncached.total).toBe('1');

        const updates = await listCatalogCountries(db, {
          continent: 'europe',
          updateAvailable: true,
          limit: 10,
        });
        expect(updates.rows.map(({ slug }) => slug)).toEqual(['finland']);
        expect(updates.total).toBe('1');

        const firstPage = await listCatalogCountries(db, { page: 1, limit: 2, sort: 'name' });
        const secondPage = await listCatalogCountries(db, { page: 2, limit: 2, sort: 'name' });
        expect(firstPage.rows.map(({ slug }) => slug)).toEqual(['finland', 'norway']);
        expect(secondPage.rows.map(({ slug }) => slug)).toEqual(['sweden', 'united-states']);
        expect(firstPage.total).toBe('4');
        expect(secondPage.total).toBe('4');

        const bySize = await listCatalogCountries(db, {
          sort: 'sourceSizeHintBytes',
          order: 'desc',
          limit: 2,
        });
        expect(bySize.rows.map(({ slug }) => slug)).toEqual(['united-states', 'sweden']);

        const byCachedSize = await listCatalogCountries(db, {
          sort: 'totalSizeBytes',
          order: 'desc',
          limit: 10,
        });
        expect(byCachedSize.rows.map(({ slug }) => slug)).toEqual([
          'sweden',
          'finland',
          'united-states',
          'norway',
        ]);

        await sql`
          insert into countries (id, source_id, parent_id, slug, name, iso_alpha2, source_size_hint_bytes)
          values ('00000000-0000-4000-8000-000000000005', 'europe/aland', 'europe', 'aland-islands', 'Åland Islands', array['AX'], 10)
        `.execute(db);
        const unaccent = await sql<{ available: boolean }>`
          select to_regprocedure('unaccent(text)') is not null as available
        `.execute(db);
        const accentSearch = await listCatalogCountries(db, { search: 'aland', limit: 10 });
        expect(accentSearch.rows.map(({ slug }) => slug)).toEqual(
          unaccent.rows[0]!.available ? ['aland-islands'] : [],
        );
      },
      { migrate: true, prefix: 'catalogrepo' },
    );
  });

  it('keeps an enclosing transaction usable when optional accent folding is unavailable', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await sql`drop extension if exists unaccent`.execute(db);

        const page = await withTransaction(db, async (trx) => {
          await seedCatalog(trx);
          return listCatalogCountries(trx, { search: 'fin', limit: 10 });
        });

        expect(page.rows.map(({ slug }) => slug)).toEqual(['finland']);
        expect(page.total).toBe('1');
      },
      { migrate: true, prefix: 'accenttx' },
    );
  });

  it('provides cached-only list and detail queries without duplicating catalog rows', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await seedCatalog(db);

        const cached = await listCachedCountries(db, { search: 'fin', limit: 10 });
        expect(
          cached.rows.map(({ slug, cache_country_id }) => ({
            slug,
            cached: cache_country_id !== null,
          })),
        ).toEqual([{ slug: 'finland', cached: true }]);
        expect(cached.total).toBe('1');

        const uncachedCountryId = '00000000-0000-4000-8000-000000000003';
        const cachedCountry = await findCachedCountry(db, '00000000-0000-4000-8000-000000000001');
        expect(cachedCountry?.slug).toBe('finland');
        expect(cachedCountry?.total_size_bytes).toBe('100');
        expect(await findCachedCountry(db, uncachedCountryId)).toBeNull();

        const cache = await findCountryCache(db, '00000000-0000-4000-8000-000000000001');
        expect(cache?.update_state).toBe('update_available');
        expect(cache?.total_size_bytes).toBe('100');
      },
      { migrate: true, prefix: 'cacherepo' },
    );
  });

  it('upserts upstream facts but preserves the country slug already assigned to its source identity', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await seedCatalog(db);
        const syncedAt = new Date('2026-10-27T12:00:00.000Z');
        const country = await upsertCatalogCountry(
          db,
          {
            source: 'geofabrik',
            sourceId: 'europe/finland',
            parentId: 'europe',
            slug: 'finland-renamed',
            name: 'Finland (updated)',
            isoAlpha2: ['FI'],
            isoOther: [],
            sourcePbfUrl: 'https://example.invalid/finland-latest.osm.pbf',
            sourceSizeHintBytes: 99,
          },
          syncedAt,
        );

        expect(country.slug).toBe('finland');
        expect(country.name).toBe('Finland (updated)');
        expect(country.source_size_hint_bytes).toBe('99');
        expect(country.catalog_synced_at).toEqual(syncedAt);
        expect(await findCountryBySlug(db, 'finland')).toMatchObject({ id: country.id });
      },
      { migrate: true, prefix: 'catalogupsert' },
    );
  });

  it('lists ready versions ahead of pending versions and finds by id or country/version label', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await seedCatalog(db);
        const countryId = '00000000-0000-4000-8000-000000000001';
        const oldId = await insertVersion(db, countryId, '260101', 'ready', '2026-01-01T00:00:00Z');
        const newId = await insertVersion(db, countryId, '260102', 'ready', '2026-01-02T00:00:00Z');
        await insertVersion(db, countryId, '260103', 'pending', null);

        const versions = await listMapVersions(db, countryId);
        expect(versions.map(({ version }) => version)).toEqual(['260102', '260101', '260103']);
        expect((await findMapVersionById(db, newId))?.version).toBe('260102');
        expect((await findMapVersionByLabel(db, countryId, '260101'))?.id).toBe(oldId);
        expect(await findMapVersionByLabel(db, countryId, 'missing')).toBeNull();
      },
      { migrate: true, prefix: 'versionrepo' },
    );
  });
});

async function seedCatalog(db: Parameters<typeof findCountryBySlug>[0]): Promise<void> {
  await sql`
    insert into countries (id, source_id, parent_id, slug, name, iso_alpha2, source_size_hint_bytes)
    values
      ('00000000-0000-4000-8000-000000000001', 'europe/finland', 'europe', 'finland', 'Finland', array['FI'], 50),
      ('00000000-0000-4000-8000-000000000002', 'europe/sweden', 'europe', 'sweden', 'Sweden', array['SE'], 75),
      ('00000000-0000-4000-8000-000000000003', 'europe/norway', 'europe', 'norway', 'Norway', array['NO'], 25),
      ('00000000-0000-4000-8000-000000000004', 'north-america/united-states', 'north-america', 'united-states', 'United States', array['US'], 100)
  `.execute(db);
  await sql`
    insert into country_cache
      (country_id, update_state, available_version, available_size_bytes, versions_ready_count, total_size_bytes)
    values
      ('00000000-0000-4000-8000-000000000001', 'update_available', '261024', 60, 2, 100),
      ('00000000-0000-4000-8000-000000000002', 'up_to_date', null, null, 3, 250),
      ('00000000-0000-4000-8000-000000000004', 'unknown', null, null, 1, 75)
  `.execute(db);
}

async function insertVersion(
  db: Parameters<typeof findCountryBySlug>[0],
  countryId: string,
  version: string,
  status: 'ready' | 'pending',
  readyAt: string | null,
): Promise<string> {
  const row = await sql<{ id: string }>`
    insert into map_versions
      (country_id, version, origin, source_filename, file_size_bytes, checksum_md5, storage_path, status, ready_at)
    values
      (${countryId}::uuid, ${version}, 'geofabrik_snapshot', ${`finland-${version}.osm.pbf`}, 100,
       ${status === 'ready' ? 'd41d8cd98f00b204e9800998ecf8427e' : null},
       ${`finland/${version}/finland-${version}.osm.pbf`}, ${status}, ${readyAt})
    returning id
  `.execute(db);
  return row.rows[0]!.id;
}
