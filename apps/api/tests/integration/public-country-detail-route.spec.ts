import { describe, expect, it } from 'vitest';

import type { PublicCountryDetailResponse, PublicCountryVersionsResponse } from '@mapirror/shared';

import { buildApp, parseEnv } from '../../src/index';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('public country detail and versions routes', () => {
  it('returns only published ready versions, with identical not-found semantics and safe pagination', async () => {
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
            },
            {
              source_id: 'europe/norway',
              parent_id: 'europe',
              slug: 'norway',
              name: 'Norway',
              iso_alpha2: ['NO'],
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
            { country_id: countryId('norway'), is_public: false },
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
            readyVersion(countryId('norway'), 'norway', '261002', 300, '2026-10-02T00:00:00.000Z'),
            pendingVersion(countryId('iceland'), '261001'),
          ])
          .execute();

        const app = await buildApp({
          config: parseEnv({ DATABASE_URL: dsnFor(name) }),
          database,
        });
        try {
          const detail = await app.inject({ method: 'GET', url: '/_public/api/countries/finland' });
          expect(detail.statusCode).toBe(200);
          expect(detail.json<PublicCountryDetailResponse>()).toEqual({
            slug: 'finland',
            name: 'Finland',
            iso: ['FI'],
            versions: [
              {
                version: '261002',
                dataTimestamp: '2026-10-02T00:00:00.000Z',
                sizeBytes: 500,
                checksumMd5: 'd41d8cd98f00b204e9800998ecf8427e',
                downloadUrl: '/_public/api/countries/finland/download?version=261002',
                isLatest: true,
              },
              {
                version: '261001',
                dataTimestamp: '2026-10-01T00:00:00.000Z',
                sizeBytes: 100,
                checksumMd5: 'd41d8cd98f00b204e9800998ecf8427e',
                downloadUrl: '/_public/api/countries/finland/download?version=261001',
                isLatest: false,
              },
            ],
            latest: '261002',
            updatedAt: '2026-10-02T00:00:00.000Z',
            license: {
              name: 'ODbL 1.0',
              attribution: '© OpenStreetMap contributors',
              url: 'https://www.openstreetmap.org/copyright',
              source: 'Geofabrik GmbH',
              sourceUrl: 'https://download.geofabrik.de',
            },
          });
          for (const forbidden of [
            'countryId',
            'country_id',
            'storagePath',
            'storage_path',
            'jobId',
            'id',
          ]) {
            expect(detail.json()).not.toHaveProperty(`versions.0.${forbidden}`);
          }

          const firstPage = await app.inject({
            method: 'GET',
            url: '/_public/api/countries/finland/versions?limit=1',
          });
          expect(firstPage.statusCode).toBe(200);
          expect(firstPage.json<PublicCountryVersionsResponse>()).toMatchObject({
            data: [{ version: '261002', isLatest: true }],
            meta: { page: 1, limit: 1, total: 2, totalPages: 2 },
          });

          const secondPage = await app.inject({
            method: 'GET',
            url: '/_public/api/countries/finland/versions?page=2&limit=1',
          });
          expect(secondPage.json<PublicCountryVersionsResponse>()).toMatchObject({
            data: [{ version: '261001', isLatest: false }],
            meta: { page: 2, limit: 1, total: 2, totalPages: 2 },
          });

          const invalid = await app.inject({
            method: 'GET',
            url: '/_public/api/countries/finland/versions?sort=name',
          });
          expect(invalid.statusCode).toBe(400);
          expect(invalid.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');

          const hidden = await app.inject({ method: 'GET', url: '/_public/api/countries/norway' });
          const unknown = await app.inject({
            method: 'GET',
            url: '/_public/api/countries/unknown',
          });
          const malformed = await app.inject({
            method: 'GET',
            url: '/_public/api/countries/Not-A-Slug',
          });
          for (const response of [hidden, unknown, malformed]) {
            expect(response.statusCode).toBe(404);
            expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
          }
          expect(hidden.json<{ error: { message: string } }>().error.message).toBe(
            unknown.json<{ error: { message: string } }>().error.message,
          );

          for (const url of [
            '/_public/api/countries/norway/versions',
            '/_public/api/countries/iceland/versions',
            '/_public/api/countries/unknown/versions',
          ]) {
            const response = await app.inject({ method: 'GET', url });
            expect(response.statusCode).toBe(404);
            expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
          }
        } finally {
          await app.close();
        }
      },
      { prefix: 'publicdetail', migrate: true },
    );
  });
});

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
