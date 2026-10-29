import { describe, expect, it } from 'vitest';

import type { PublicCountriesResponse, PublicStatsResponse } from '@mapirror/shared';

import { buildApp, parseEnv } from '../../src/index';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('public country visibility matrix', () => {
  it('hides an unpublished country from every country-facing public read', async () => {
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
              source_id: 'europe/sweden',
              parent_id: 'europe',
              slug: 'sweden',
              name: 'Sweden',
              iso_alpha2: ['SE'],
            },
          ])
          .returning(['id', 'slug'])
          .execute();
        const countryId = (slug: string): string => {
          const country = countries.find((row) => row.slug === slug);
          if (country === undefined) throw new Error(`seed country ${slug} is missing`);
          return country.id;
        };
        const finlandId = countryId('finland');
        const swedenId = countryId('sweden');
        await database.db
          .insertInto('country_cache')
          .values([
            {
              country_id: finlandId,
              is_public: true,
              public_since: new Date('2026-10-20T12:00:00.000Z'),
            },
            { country_id: swedenId, is_public: false },
          ])
          .execute();
        await database.db
          .insertInto('map_versions')
          .values([
            readyVersion(finlandId, 'finland', 100),
            // A ready-version record is deliberately present for the private country: 404 must be caused by visibility,
            // not by the absence of a version or a broken cache file.
            readyVersion(swedenId, 'sweden', 9_000),
          ])
          .execute();

        const app = await buildApp({
          config: parseEnv({ DATABASE_URL: dsnFor(name) }),
          database,
        });
        try {
          const countriesResponse = await app.inject({
            method: 'GET',
            url: '/_public/api/countries?limit=100',
          });
          expect(countriesResponse.statusCode).toBe(200);
          const countriesBody = countriesResponse.json<PublicCountriesResponse>();
          expect(countriesBody.data.map(({ slug }) => slug)).toEqual(['finland']);
          expect(countriesBody.meta.total).toBe(1);

          const searchForPrivateCountry = await app.inject({
            method: 'GET',
            url: '/_public/api/countries?q=sweden',
          });
          expect(searchForPrivateCountry.statusCode).toBe(200);
          expect(searchForPrivateCountry.json<PublicCountriesResponse>()).toMatchObject({
            data: [],
            meta: { total: 0, totalPages: 0 },
          });

          const stats = await app.inject({ method: 'GET', url: '/_public/api/stats' });
          expect(stats.statusCode).toBe(200);
          expect(stats.json<PublicStatsResponse>()).toEqual({
            countries: 1,
            totalSizeBytes: 100,
            downloads30d: 0,
            totalDownloads: 0,
            lastPublishedAt: '2026-10-20T12:00:00.000Z',
          });

          const countryRoutes = [
            {
              name: 'detail',
              path: (slug: string) => `/_public/api/countries/${slug}`,
            },
            {
              name: 'version history',
              path: (slug: string) => `/_public/api/countries/${slug}/versions`,
            },
            {
              name: 'download',
              path: (slug: string) => `/_public/api/countries/${slug}/download?version=261029`,
            },
          ] as const;

          for (const route of countryRoutes) {
            const hidden = await app.inject({ method: 'GET', url: route.path('sweden') });
            const unknown = await app.inject({ method: 'GET', url: route.path('norway') });
            const malformed = await app.inject({ method: 'GET', url: route.path('Not-A-Slug') });
            const hiddenError = hidden.json<PublicErrorResponse>().error;
            expect(hidden.statusCode, `${route.name} should hide unpublished countries`).toBe(404);
            expect(hiddenError.code).toBe('NOT_FOUND');
            expect(hiddenError.requestId).toBeTruthy();

            for (const response of [unknown, malformed]) {
              expect(
                response.statusCode,
                `${route.name} should hide unknown or malformed slugs`,
              ).toBe(404);
              const error = response.json<PublicErrorResponse>().error;
              expect(error.code).toBe('NOT_FOUND');
              expect(error.requestId).toBeTruthy();
              // IDs are intentionally per-request; all other public error details are indistinguishable.
              expect(withoutRequestId(error)).toEqual(withoutRequestId(hiddenError));
            }
            expect(hiddenError.requestId).not.toBe(
              unknown.json<PublicErrorResponse>().error.requestId,
            );
            expect(hidden.body).not.toContain('sweden');
            expect(hidden.body).not.toContain('finland');
          }
        } finally {
          await app.close();
        }
      },
      { prefix: 'publicvisibility', migrate: true },
    );
  });
});

interface PublicErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly requestId: string;
  };
}

/** Removes the per-request identifier to compare the public-safe error envelope. */
function withoutRequestId(
  error: PublicErrorResponse['error'],
): Omit<PublicErrorResponse['error'], 'requestId'> {
  const { requestId: _requestId, ...publicError } = error;
  return publicError;
}

function readyVersion(countryId: string, slug: string, size: number) {
  return {
    country_id: countryId,
    version: '261029',
    origin: 'geofabrik_snapshot' as const,
    source_filename: `${slug}-261029.osm.pbf`,
    file_size_bytes: size,
    checksum_md5: 'd41d8cd98f00b204e9800998ecf8427e',
    storage_path: `${slug}/261029/${slug}-261029.osm.pbf`,
    status: 'ready' as const,
    ready_at: new Date('2026-10-29T12:00:00.000Z'),
    data_timestamp: new Date('2026-10-29T11:00:00.000Z'),
  };
}
