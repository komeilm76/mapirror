import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import { freshDatabaseSkipReason, withFreshDatabase, dsnFor } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('GET /_public/api/countries', () => {
  it('filters and pages only published countries with ready versions, returning public-safe data', async () => {
    await withFreshDatabase(
      async (database, name) => {
        const countries = await database.db
          .insertInto('countries')
          .values([
            {
              source_id: 'europe/finland',
              parent_id: 'europe',
              slug: 'finland',
              name: 'Finland',
              iso_alpha2: ['FI'],
              iso_other: ['FI-01'],
            },
            {
              source_id: 'europe/norway',
              parent_id: 'europe',
              slug: 'norway',
              name: 'Norway',
              iso_alpha2: ['NO'],
            },
            {
              source_id: 'asia/japan',
              parent_id: 'asia',
              slug: 'japan',
              name: 'Japan',
              iso_alpha2: ['JP'],
            },
            {
              source_id: 'europe/sweden',
              parent_id: 'europe',
              slug: 'sweden',
              name: 'Sweden',
              iso_alpha2: ['SE'],
            },
            {
              source_id: 'europe/iceland',
              parent_id: 'europe',
              slug: 'iceland',
              name: 'Iceland',
              iso_alpha2: ['IS'],
            },
          ])
          .returning(['id', 'slug'])
          .execute();
        const countryId = (slug: string): string => {
          const country = countries.find((row) => row.slug === slug);
          if (country === undefined) throw new Error(`seed country ${slug} is missing`);
          return country.id;
        };
        await database.db
          .insertInto('country_cache')
          .values([
            { country_id: countryId('finland'), is_public: true },
            { country_id: countryId('norway'), is_public: true },
            { country_id: countryId('japan'), is_public: true },
            { country_id: countryId('sweden'), is_public: false },
            { country_id: countryId('iceland'), is_public: true },
          ])
          .execute();
        await database.db
          .insertInto('map_versions')
          .values([
            readyVersion(
              countryId('finland'),
              'finland',
              '261001',
              100,
              '2026-10-01T00:00:00.000Z',
            ),
            readyVersion(
              countryId('finland'),
              'finland',
              '261002',
              500,
              '2026-10-02T00:00:00.000Z',
            ),
            pendingVersion(countryId('finland'), '261003'),
            readyVersion(countryId('norway'), 'norway', '261003', 300, '2026-10-03T00:00:00.000Z'),
            readyVersion(countryId('japan'), 'japan', '261004', 200, '2026-10-04T00:00:00.000Z'),
            readyVersion(countryId('sweden'), 'sweden', '261002', 400, '2026-10-02T00:00:00.000Z'),
            pendingVersion(countryId('iceland'), '261001'),
          ])
          .execute();

        const app = await buildApp({
          config: parseEnv({ DATABASE_URL: dsnFor(name) }),
          database,
        });
        try {
          const all = await app.inject({ method: 'GET', url: '/_public/api/countries?limit=2' });
          expect(all.statusCode).toBe(200);
          const allBody = all.json<PublicCountriesBody>();
          expect(allBody.data.map(({ slug }) => slug)).toEqual(['finland', 'japan']);
          expect(allBody.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
          expect(allBody.license).toEqual({
            name: 'ODbL 1.0',
            attribution: '© OpenStreetMap contributors',
            url: 'https://www.openstreetmap.org/copyright',
          });
          expect(allBody.data[0]).toMatchObject({
            slug: 'finland',
            newestVersion: '261002',
            sizeBytes: 500,
            updatedAt: '2026-10-02T00:00:00.000Z',
            downloadUrl: '/_public/api/countries/finland/download?version=latest',
          });
          for (const forbidden of [
            'countryId',
            'sourceId',
            'storagePath',
            'isPublic',
            'publicSince',
          ]) {
            expect(allBody.data[0]).not.toHaveProperty(forbidden);
          }

          const nextPage = await app.inject({
            method: 'GET',
            url: '/_public/api/countries?page=2&limit=2',
          });
          expect(nextPage.json<PublicCountriesBody>().data.map(({ slug }) => slug)).toEqual([
            'norway',
          ]);

          const filtered = await app.inject({
            method: 'GET',
            url: '/_public/api/countries?q=fi&continent=europe',
          });
          expect(filtered.json<PublicCountriesBody>()).toMatchObject({
            data: [{ slug: 'finland' }],
            meta: { total: 1, totalPages: 1 },
          });

          const isoSearch = await app.inject({ method: 'GET', url: '/_public/api/countries?q=FI' });
          expect(isoSearch.json<PublicCountriesBody>().data.map(({ slug }) => slug)).toEqual([
            'finland',
          ]);

          const largest = await app.inject({
            method: 'GET',
            url: '/_public/api/countries?sort=size',
          });
          expect(largest.json<PublicCountriesBody>().data.map(({ slug }) => slug)).toEqual([
            'finland',
            'norway',
            'japan',
          ]);

          const mostRecentlyUpdated = await app.inject({
            method: 'GET',
            url: '/_public/api/countries?sort=updated',
          });
          expect(
            mostRecentlyUpdated.json<PublicCountriesBody>().data.map(({ slug }) => slug),
          ).toEqual(['japan', 'norway', 'finland']);

          for (const url of [
            '/_public/api/countries?order=desc',
            '/_public/api/countries?sort=created',
            '/_public/api/countries?unknown=true',
          ]) {
            const invalid = await app.inject({ method: 'GET', url });
            expect(invalid.statusCode).toBe(400);
            expect(invalid.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
          }
        } finally {
          await app.close();
        }
      },
      { prefix: 'publiccountries', migrate: true },
    );
  });
});

interface PublicCountriesBody {
  readonly data: Array<{
    readonly slug: string;
    readonly newestVersion: string;
    readonly sizeBytes: number | string;
    readonly updatedAt: string | null;
    readonly downloadUrl: string;
  }>;
  readonly meta: {
    readonly page: number;
    readonly limit: number;
    readonly total: number;
    readonly totalPages: number;
  };
  readonly license: { readonly name: string; readonly attribution: string; readonly url: string };
}

function readyVersion(
  countryId: string,
  slug: string,
  version: string,
  size: number,
  dataTimestamp: string,
) {
  return {
    country_id: countryId,
    version,
    origin: 'geofabrik_snapshot' as const,
    source_filename: `${slug}-${version}.osm.pbf`,
    file_size_bytes: size,
    checksum_md5: 'd41d8cd98f00b204e9800998ecf8427e',
    storage_path: `${slug}/${version}/${slug}-${version}.osm.pbf`,
    status: 'ready' as const,
    ready_at: new Date(dataTimestamp),
    data_timestamp: new Date(dataTimestamp),
  };
}

function pendingVersion(countryId: string, version: string) {
  return {
    country_id: countryId,
    version,
    origin: 'geofabrik_snapshot' as const,
    source_filename: `pending-${version}.osm.pbf`,
    file_size_bytes: 0,
    storage_path: `pending/${version}/pending-${version}.osm.pbf`,
    status: 'pending' as const,
  };
}
