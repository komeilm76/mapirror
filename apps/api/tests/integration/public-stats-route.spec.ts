import { describe, expect, it } from 'vitest';

import type { PublicStatsResponse } from '@mapirror/shared';

import { buildApp, parseEnv } from '../../src/index';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('GET /_public/api/stats', () => {
  it('aggregates published ready data and public-channel events without exposing identifiers', async () => {
    await withFreshDatabase(
      async (database, name) => {
        const countries = await database.db
          .insertInto('countries')
          .values([
            { source_id: 'europe/finland', slug: 'finland', name: 'Finland' },
            { source_id: 'europe/norway', slug: 'norway', name: 'Norway' },
            { source_id: 'europe/sweden', slug: 'sweden', name: 'Sweden' },
          ])
          .returning(['id', 'slug'])
          .execute();
        const countryId = (slug: string): string => {
          const row = countries.find((country) => country.slug === slug);
          if (row === undefined) throw new Error(`seed country ${slug} is missing`);
          return row.id;
        };
        const publishedAt = new Date('2026-10-20T12:00:00.000Z');
        await database.db
          .insertInto('country_cache')
          .values([
            { country_id: countryId('finland'), is_public: true, public_since: publishedAt },
            {
              country_id: countryId('norway'),
              is_public: true,
              public_since: new Date('2026-10-25T12:00:00Z'),
            },
            { country_id: countryId('sweden'), is_public: false, public_since: null },
          ])
          .execute();
        const versions = await database.db
          .insertInto('map_versions')
          .values([
            readyVersion(countryId('finland'), '261001', 100),
            readyVersion(countryId('finland'), '261002', 200),
            readyVersion(countryId('norway'), '261003', 300),
            readyVersion(countryId('sweden'), '261004', 9_000),
            { ...readyVersion(countryId('finland'), '261005', 8_000), status: 'failed' },
          ])
          .returning(['id', 'version', 'country_id'])
          .execute();
        const versionId = (version: string): string => {
          const row = versions.find((candidate) => candidate.version === version);
          if (row === undefined) throw new Error(`seed version ${version} is missing`);
          return row.id;
        };
        const now = Date.now();
        await database.db
          .insertInto('download_events')
          .values([
            {
              country_id: countryId('finland'),
              version_id: versionId('261002'),
              channel: 'public',
              bytes_sent: 200,
              ip_hash: 'a'.repeat(64),
              created_at: new Date(now - 5 * 24 * 60 * 60 * 1_000),
            },
            {
              country_id: countryId('norway'),
              version_id: versionId('261003'),
              channel: 'public',
              bytes_sent: 300,
              ip_hash: null,
              created_at: new Date(now - 35 * 24 * 60 * 60 * 1_000),
            },
            {
              country_id: countryId('sweden'),
              version_id: versionId('261004'),
              channel: 'admin',
              bytes_sent: 9_000,
              ip_hash: 'b'.repeat(64),
              created_at: new Date(now - 2 * 24 * 60 * 60 * 1_000),
            },
          ])
          .execute();

        const app = await buildApp({
          config: parseEnv({ DATABASE_URL: dsnFor(name) }),
          database,
        });
        try {
          const response = await app.inject({ method: 'GET', url: '/_public/api/stats' });
          expect(response.statusCode).toBe(200);
          expect(response.headers['cache-control']).toBe('no-store');
          const body = response.json<PublicStatsResponse>();
          expect(body).toEqual({
            countries: 2,
            totalSizeBytes: 600,
            downloads30d: 1,
            totalDownloads: 2,
            lastPublishedAt: '2026-10-25T12:00:00.000Z',
          });
          expect(body).not.toHaveProperty('ipHash');
          expect(body).not.toHaveProperty('countryId');

          const unsupportedFilter = await app.inject({
            method: 'GET',
            url: '/_public/api/stats?period=30d',
          });
          expect(unsupportedFilter.statusCode).toBe(400);
        } finally {
          await app.close();
        }
      },
      { prefix: 'publicstats', migrate: true },
    );
  });

  it('returns zeroes and a null publication time when nothing is publicly downloadable', async () => {
    await withFreshDatabase(
      async (database, name) => {
        const app = await buildApp({
          config: parseEnv({ DATABASE_URL: dsnFor(name) }),
          database,
        });
        try {
          const response = await app.inject({ method: 'GET', url: '/_public/api/stats' });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({
            countries: 0,
            totalSizeBytes: 0,
            downloads30d: 0,
            totalDownloads: 0,
            lastPublishedAt: null,
          });
        } finally {
          await app.close();
        }
      },
      { prefix: 'publicstats-empty', migrate: true },
    );
  });
});

function readyVersion(countryId: string, version: string, size: number) {
  const readyAt = new Date('2026-10-26T12:00:00.000Z');
  return {
    country_id: countryId,
    version,
    origin: 'geofabrik_snapshot' as const,
    source_filename: `${version}.osm.pbf`,
    file_size_bytes: size,
    checksum_md5: 'a'.repeat(32),
    storage_path: `fixture/${version}.osm.pbf`,
    status: 'ready' as const,
    ready_at: readyAt,
  };
}
