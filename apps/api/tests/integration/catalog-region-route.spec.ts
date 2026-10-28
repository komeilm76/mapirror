import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';
import { withGeofabrikFixtureServer } from '../helpers/geofabrik-fixture-server';

const skipReason = await freshDatabaseSkipReason();
const readyAt = new Date('2026-10-24T06:00:00.000Z');
const checksum = '0123456789abcdef0123456789abcdef';

async function withRegionApp(
  baseUrl: string,
  run: (context: { app: FastifyInstance; token: string; countryId: string }) => Promise<void>,
) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'region-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const token = await issueToken(database.db, admin.id, { ttlHours: 12 });
      await database.db
        .insertInto('countries')
        .values({ source_id: 'europe', slug: 'europe', name: 'Europe' })
        .execute();
      const finland = await database.db
        .insertInto('countries')
        .values({
          source_id: 'europe/finland',
          parent_id: 'europe',
          slug: 'finland',
          name: 'Finland',
          iso_alpha2: ['FI'],
          iso_other: ['FI-01'],
          source_pbf_url: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf',
          source_size_hint_bytes: 773_465_008,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await database.db
        .insertInto('map_versions')
        .values([
          {
            country_id: finland.id,
            version: '261023',
            origin: 'geofabrik_snapshot',
            source_filename: 'finland-261023.osm.pbf',
            data_timestamp: readyAt,
            file_size_bytes: 773_465_008,
            checksum_md5: checksum,
            storage_path: 'finland/261023.osm.pbf',
            status: 'ready',
            ready_at: readyAt,
          },
          {
            country_id: finland.id,
            version: '260101',
            origin: 'geofabrik_snapshot',
            source_filename: 'finland-260101.osm.pbf',
            data_timestamp: new Date('2026-01-01T00:00:00.000Z'),
            file_size_bytes: 99,
            checksum_md5: 'invalid',
            checksum_sha256: 'b'.repeat(64),
            storage_path: 'finland/260101.osm.pbf',
            status: 'ready',
            ready_at: new Date('2026-01-02T00:00:00.000Z'),
          },
          {
            country_id: finland.id,
            version: 'upload-a',
            origin: 'upload',
            source_filename: 'custom.osm.pbf',
            file_size_bytes: 123,
            checksum_md5: 'invalid',
            checksum_sha256: 'a'.repeat(64),
            storage_path: 'finland/upload-a.osm.pbf',
            status: 'ready',
            ready_at: readyAt,
          },
        ])
        .execute();

      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name), GEOFABRIK_BASE_URL: baseUrl }),
        database,
      });
      try {
        await run({ app, token: token.token, countryId: finland.id });
      } finally {
        await app.close();
      }
    },
    { prefix: 'catalogregion', migrate: true },
  );
}

async function withSourceServer(
  pageStatus: number,
  run: (baseUrl: string, requestedPaths: string[]) => Promise<void>,
) {
  await withGeofabrikFixtureServer(
    { statusByPath: { '/europe/finland.html': pageStatus } },
    ({ baseUrl, requests }) =>
      run(
        baseUrl,
        requests.map((request) => request.replace(/^[^ ]+ /u, '')),
      ),
  );
}

function getRegion(app: FastifyInstance, token: string, slug: string) {
  return app.inject({
    method: 'GET',
    url: `/_admin/api/catalog/regions/${slug}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function getSnapshots(app: FastifyInstance, token: string, slug: string) {
  return app.inject({
    method: 'GET',
    url: `/_admin/api/catalog/regions/${slug}/snapshots`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe.skipIf(skipReason !== null)('admin catalog region routes', () => {
  it('looks up a local slug, returns the parent chain and cached versions, and lists current snapshots', async () => {
    await withSourceServer(200, async (baseUrl, requestedPaths) => {
      await withRegionApp(baseUrl, async ({ app, token, countryId }) => {
        const detail = await getRegion(app, token, 'finland');
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({
          country: {
            countryId,
            sourceId: 'europe/finland',
            slug: 'finland',
            name: 'Finland',
            parentChain: [{ sourceId: 'europe', slug: 'europe', name: 'Europe' }],
            iso: ['FI', 'FI-01'],
            pbfUrl: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf',
            sizeHintBytes: 773_465_008,
          },
          source: {
            version: '261023',
            sizeBytes: 773_500_000,
            dataTimestamp: '2026-10-23T20:20:51.000Z',
          },
          sourceReachable: true,
          cachedVersions: [
            {
              version: '261023',
              origin: 'geofabrik_snapshot',
              sizeBytes: 773_465_008,
              checksumMd5: checksum,
            },
            { version: '260101', origin: 'geofabrik_snapshot', sizeBytes: 99, checksumMd5: null },
            { version: 'upload-a', origin: 'upload', sizeBytes: 123, checksumMd5: null },
          ],
        });

        const snapshots = await getSnapshots(app, token, 'finland');
        expect(snapshots.statusCode).toBe(200);
        const snapshotBody = snapshots.json<{
          data: { version: string }[];
          fetchedAt: string;
          latest: { version: string; sizeBytes: number | string } | null;
          sourceReachable: boolean;
        }>();
        expect(snapshotBody).toMatchObject({
          data: [
            {
              version: '261023',
              sizeBytes: 773_500_000,
              checksumMd5: checksum,
              cached: true,
              dataTimestamp: '2026-10-23T20:20:51.000Z',
            },
            { version: '261016', sizeBytes: 796_917_760, cached: false },
          ],
          latest: { version: '261023', sizeBytes: 773_500_000 },
          sourceReachable: true,
        });
        expect(snapshotBody.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT/u);
        expect(requestedPaths).toEqual(['/europe/finland.html', '/europe/finland.html']);
      });
    });
  });

  it('reports a source outage and offers only ready cached source snapshots', async () => {
    await withSourceServer(503, async (baseUrl) => {
      await withRegionApp(baseUrl, async ({ app, token }) => {
        const snapshots = await getSnapshots(app, token, 'finland');
        expect(snapshots.statusCode).toBe(200);
        const snapshotBody = snapshots.json<{
          data: {
            version: string;
            sizeBytes: number | string;
            checksumMd5: string | null;
            cached: boolean;
          }[];
          latest: { version: string; sizeBytes: number | string } | null;
          sourceReachable: boolean;
        }>();
        expect(snapshotBody).toMatchObject({
          data: [
            {
              version: '261023',
              sizeBytes: 773_465_008,
              checksumMd5: checksum,
              cached: true,
            },
            {
              version: '260101',
              sizeBytes: 99,
              checksumMd5: null,
              cached: true,
            },
          ],
          latest: null,
          sourceReachable: false,
        });
        expect(snapshotBody.data.map((entry) => entry.version)).not.toContain('upload-a');

        const detail = await getRegion(app, token, 'finland');
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({
          source: { version: null, sizeBytes: null, dataTimestamp: null },
          sourceReachable: false,
          cachedVersions: [
            { version: '261023' },
            { version: '260101', checksumMd5: null },
            { version: 'upload-a' },
          ],
        });
      });
    });
  });

  it('validates local slugs and returns 404 for a valid but unknown slug', async () => {
    await withSourceServer(200, async (baseUrl) => {
      await withRegionApp(baseUrl, async ({ app, token }) => {
        const invalid = await getRegion(app, token, 'Finland');
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');

        const missing = await getSnapshots(app, token, 'missing-region');
        expect(missing.statusCode).toBe(404);
        expect(missing.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
      });
    });
  });
});
