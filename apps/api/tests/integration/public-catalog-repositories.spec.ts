import { describe, expect, it } from 'vitest';

import {
  findPublicCountryBySlug,
  listPublicCountries,
  listPublicCountryVersions,
} from '../../src/db/repositories/public-catalog';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('public catalog repository', () => {
  it('applies the publication and ready-version guard to every read projection', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const countries = await db
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
            {
              source_id: 'asia/japan',
              parent_id: 'asia',
              slug: 'japan',
              name: 'Japan',
              iso_alpha2: ['JP'],
            },
          ])
          .returning(['id', 'slug'])
          .execute();
        const countryId = (slug: string): string => {
          const country = countries.find((row) => row.slug === slug);
          if (country === undefined) throw new Error(`seed country ${slug} is missing`);
          return country.id;
        };

        await db
          .insertInto('country_cache')
          .values([
            { country_id: countryId('finland'), is_public: true },
            { country_id: countryId('norway'), is_public: false },
            { country_id: countryId('sweden'), is_public: true },
            // The service should prevent this state, but public reads defend against inconsistent persisted data too.
            { country_id: countryId('iceland'), is_public: true },
          ])
          .execute();

        await db
          .insertInto('map_versions')
          .values([
            readyVersion(countryId('finland'), 'finland', '261001', '2026-10-01T00:00:00.000Z'),
            readyVersion(countryId('finland'), 'finland', '261002', '2026-10-02T00:00:00.000Z'),
            nonReadyVersion(countryId('finland'), 'finland', '261003', 'pending'),
            nonReadyVersion(countryId('finland'), 'finland', '261004', 'failed'),
            readyVersion(countryId('norway'), 'norway', '261002', '2026-10-02T00:00:00.000Z'),
            readyVersion(countryId('sweden'), 'sweden', '261001', '2026-10-01T00:00:00.000Z'),
            nonReadyVersion(countryId('iceland'), 'iceland', '261002', 'pending'),
            readyVersion(countryId('japan'), 'japan', '261002', '2026-10-02T00:00:00.000Z'),
          ])
          .execute();

        const page = await listPublicCountries(db, { limit: 10 });
        expect(page.total).toBe('2');
        expect(page.rows.map(({ slug }) => slug)).toEqual(['finland', 'sweden']);
        expect(page.rows[0]).toMatchObject({
          country_id: countryId('finland'),
          name: 'Finland',
          continent: 'europe',
          iso_alpha2: ['FI'],
          newest_version: '261002',
          newest_size_bytes: '100',
        });
        expect(page.rows[0]).not.toHaveProperty('storage_path');
        expect(page.rows[0]).not.toHaveProperty('is_public');

        const firstCountryPage = await listPublicCountries(db, { limit: 1 });
        const secondCountryPage = await listPublicCountries(db, { limit: 1, offset: 1 });
        expect(firstCountryPage).toMatchObject({ total: '2', rows: [{ slug: 'finland' }] });
        expect(secondCountryPage).toMatchObject({ total: '2', rows: [{ slug: 'sweden' }] });

        await expect(findPublicCountryBySlug(db, 'finland')).resolves.toMatchObject({
          country_id: countryId('finland'),
          newest_version: '261002',
        });
        for (const hiddenSlug of ['norway', 'iceland', 'japan', 'unknown']) {
          await expect(findPublicCountryBySlug(db, hiddenSlug)).resolves.toBeNull();
        }

        const finlandVersions = await listPublicCountryVersions(db, countryId('finland'), {
          limit: 10,
        });
        expect(finlandVersions.total).toBe('2');
        expect(finlandVersions.rows.map(({ version }) => version)).toEqual(['261002', '261001']);
        expect(finlandVersions.rows[0]).toMatchObject({
          file_size_bytes: '100',
          checksum_md5: 'd41d8cd98f00b204e9800998ecf8427e',
        });
        expect(finlandVersions.rows[0]).not.toHaveProperty('id');
        expect(finlandVersions.rows[0]).not.toHaveProperty('storage_path');

        for (const hiddenSlug of ['norway', 'iceland', 'japan']) {
          const hiddenVersions = await listPublicCountryVersions(db, countryId(hiddenSlug), {
            limit: 10,
          });
          expect(hiddenVersions).toEqual({ rows: [], total: '0' });
        }
      },
      { migrate: true, prefix: 'publiccatalog' },
    );
  });
});

function readyVersion(countryId: string, slug: string, version: string, dataTimestamp: string) {
  return {
    country_id: countryId,
    version,
    origin: 'geofabrik_snapshot' as const,
    source_filename: `${slug}-${version}.osm.pbf`,
    file_size_bytes: 100,
    checksum_md5: 'd41d8cd98f00b204e9800998ecf8427e',
    storage_path: `${slug}/${version}/${slug}-${version}.osm.pbf`,
    status: 'ready' as const,
    data_timestamp: new Date(dataTimestamp),
    ready_at: new Date(dataTimestamp),
  };
}

function nonReadyVersion(
  countryId: string,
  slug: string,
  version: string,
  status: 'pending' | 'failed',
) {
  return {
    country_id: countryId,
    version,
    origin: 'geofabrik_snapshot' as const,
    source_filename: `${slug}-${version}.osm.pbf`,
    file_size_bytes: 0,
    storage_path: `${slug}/${version}/${slug}-${version}.osm.pbf`,
    status,
  };
}
