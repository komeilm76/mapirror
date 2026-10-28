import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
const finlandPage = readFileSync(
  new URL('../../src/modules/geofabrik/fixtures/finland.html', import.meta.url),
  'utf8',
);

interface SourceServerOptions {
  readonly pageStatus?: number;
  readonly pbfStatus?: number;
}

async function withSourceServer(
  options: SourceServerOptions,
  run: (baseUrl: string, requests: string[]) => Promise<void>,
) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(`${request.method ?? 'GET'} ${path}`);
    if (path.endsWith('.html')) {
      response.writeHead(options.pageStatus ?? 200, { 'content-type': 'text/html; charset=utf-8' });
      response.end((options.pageStatus ?? 200) === 200 ? finlandPage : 'upstream unavailable');
      return;
    }
    response.writeHead(options.pbfStatus ?? 200, {
      'content-length': '100',
      etag: '"finland-pbf-v1"',
      'last-modified': 'Fri, 23 Oct 2026 20:20:51 GMT',
    });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

async function withDownloadApp(
  baseUrl: string,
  reserveBytes: string,
  run: (context: {
    app: FastifyInstance;
    token: string;
    adminId: string;
    countryId: string;
    database: FastifyInstance['db']['db'];
  }) => Promise<void>,
) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'download-api-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const token = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const country = await database.db
        .insertInto('countries')
        .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const cacheDir = await mkdtemp(join(tmpdir(), 'mapirror-download-api-'));
      const app = await buildApp({
        config: parseEnv({
          DATABASE_URL: dsnFor(name),
          GEOFABRIK_BASE_URL: baseUrl,
          CACHE_DIR: cacheDir,
          DISK_RESERVE_BYTES: reserveBytes,
        }),
        database,
      });
      try {
        await run({
          app,
          token: token.token,
          adminId: admin.id,
          countryId: country.id,
          database: app.db.db,
        });
      } finally {
        await app.close();
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
    { prefix: 'cachedownloadapi', migrate: true },
  );
}

function postDownload(
  app: FastifyInstance,
  token: string | undefined,
  countryId: string,
  version: string,
) {
  return app.inject({
    method: 'POST',
    url: '/_admin/api/cache/downloads',
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    payload: { countryId, version },
  });
}

function errorCode(response: InjectResponse): string {
  return response.json<{ error: { code: string } }>().error.code;
}

function readyVersion(
  countryId: string,
  version: string,
  origin: 'geofabrik_snapshot' | 'geofabrik_latest',
) {
  return {
    country_id: countryId,
    version,
    origin,
    source_filename: 'finland-261023.osm.pbf',
    data_timestamp: new Date('2026-10-23T20:20:51.000Z'),
    file_size_bytes: 100,
    checksum_md5: '0123456789abcdef0123456789abcdef',
    storage_path: `finland/${version}.osm.pbf`,
    status: 'ready' as const,
    ready_at: new Date('2026-10-24T00:00:00.000Z'),
  };
}

describe.skipIf(skipReason !== null)('POST /_admin/api/cache/downloads', () => {
  it('resolves latest and dated versions, preflights, and enqueues attributed durable jobs', async () => {
    await withSourceServer({}, async (baseUrl, requests) => {
      await withDownloadApp(baseUrl, '0', async ({ app, token, adminId, countryId, database }) => {
        const latest = await postDownload(app, token, countryId, 'latest');
        expect(latest.statusCode).toBe(202);
        const latestBody = latest.json<{ jobId: string; resolvedVersion: string | null }>();
        expect(latestBody).toMatchObject({ resolvedVersion: '261023' });

        const dated = await postDownload(app, token, countryId, '261016');
        expect(dated.statusCode).toBe(202);
        expect(dated.json()).toMatchObject({ resolvedVersion: '261016' });

        const jobs = await database
          .selectFrom('jobs')
          .select(['id', 'type', 'status', 'payload', 'created_by'])
          .where('type', '=', 'download')
          .orderBy('created_at')
          .execute();
        expect(jobs).toHaveLength(2);
        expect(jobs).toMatchObject([
          {
            id: latestBody.jobId,
            status: 'queued',
            payload: { countryId, version: 'latest', origin: 'geofabrik_latest' },
            created_by: adminId,
          },
          {
            status: 'queued',
            payload: { countryId, version: '261016', origin: 'geofabrik_snapshot' },
            created_by: adminId,
          },
        ]);
        expect(requests).toEqual([
          'GET /europe/finland.html',
          'HEAD /europe/finland-latest.osm.pbf',
          'GET /europe/finland.html',
          'HEAD /europe/finland-261016.osm.pbf',
        ]);
      });
    });
  });

  it('rejects ready cached versions and maps the PostgreSQL active-download constraint to 409', async () => {
    await withSourceServer({}, async (baseUrl) => {
      await withDownloadApp(baseUrl, '0', async ({ app, token, countryId, database }) => {
        await database
          .insertInto('map_versions')
          .values([
            readyVersion(countryId, '261023', 'geofabrik_snapshot'),
            readyVersion(countryId, 'latest@2026-10-23T20-20-51Z', 'geofabrik_latest'),
          ])
          .execute();

        const cachedDated = await postDownload(app, token, countryId, '261023');
        expect(cachedDated.statusCode).toBe(409);
        expect(errorCode(cachedDated)).toBe('VERSION_ALREADY_CACHED');
        const cachedLatest = await postDownload(app, token, countryId, 'latest');
        expect(cachedLatest.statusCode).toBe(409);
        expect(errorCode(cachedLatest)).toBe('VERSION_ALREADY_CACHED');

        const accepted = await postDownload(app, token, countryId, '261016');
        expect(accepted.statusCode).toBe(202);
        const duplicate = await postDownload(app, token, countryId, '261016');
        expect(duplicate.statusCode).toBe(409);
        expect(errorCode(duplicate)).toBe('JOB_ALREADY_RUNNING');
        expect(
          await database
            .selectFrom('jobs')
            .select('id')
            .where('type', '=', 'download')
            .where('status', 'in', ['queued', 'running'])
            .execute(),
        ).toHaveLength(1);
      });
    });
  });

  it('returns SOURCE_VERSION_GONE for an absent page snapshot or a deleted PBF and enqueues nothing', async () => {
    await withSourceServer({}, async (baseUrl) => {
      await withDownloadApp(baseUrl, '0', async ({ app, token, countryId, database }) => {
        const absent = await postDownload(app, token, countryId, '000000');
        expect(absent.statusCode).toBe(410);
        expect(errorCode(absent)).toBe('SOURCE_VERSION_GONE');
        expect(
          await database.selectFrom('jobs').select('id').where('type', '=', 'download').execute(),
        ).toEqual([]);
      });
    });

    await withSourceServer({ pbfStatus: 404 }, async (baseUrl) => {
      await withDownloadApp(baseUrl, '0', async ({ app, token, countryId, database }) => {
        const deleted = await postDownload(app, token, countryId, '261023');
        expect(deleted.statusCode).toBe(410);
        expect(errorCode(deleted)).toBe('SOURCE_VERSION_GONE');
        expect(
          await database.selectFrom('jobs').select('id').where('type', '=', 'download').execute(),
        ).toEqual([]);
      });
    });
  });

  it('maps upstream failures to SOURCE_UNAVAILABLE but still rejects a cached explicit version offline', async () => {
    await withSourceServer({ pageStatus: 503 }, async (baseUrl) => {
      await withDownloadApp(baseUrl, '0', async ({ app, token, countryId, database }) => {
        const unavailable = await postDownload(app, token, countryId, 'latest');
        expect(unavailable.statusCode).toBe(502);
        expect(errorCode(unavailable)).toBe('SOURCE_UNAVAILABLE');

        await database
          .insertInto('map_versions')
          .values(readyVersion(countryId, '261023', 'geofabrik_snapshot'))
          .execute();
        const cached = await postDownload(app, token, countryId, '261023');
        expect(cached.statusCode).toBe(409);
        expect(errorCode(cached)).toBe('VERSION_ALREADY_CACHED');
        expect(
          await database.selectFrom('jobs').select('id').where('type', '=', 'download').execute(),
        ).toEqual([]);
      });
    });
  });

  it('returns disk capacity details and performs the preflight before any enqueue', async () => {
    await withSourceServer({}, async (baseUrl) => {
      await withDownloadApp(
        baseUrl,
        '9007199254740991',
        async ({ app, token, countryId, database }) => {
          const response = await postDownload(app, token, countryId, 'latest');
          expect(response.statusCode).toBe(503);
          const error = response.json<{
            error: { code: string; details: Record<string, number | string> };
          }>().error;
          expect(error.code).toBe('DISK_FULL');
          expect(error.details.requiredBytes).toBe(110);
          expect(typeof error.details.freeBytes).toBe('number');
          expect(error.details.reserveBytes).toBe(9007199254740991);
          expect(typeof error.details.shortfallBytes).toBe('number');
          expect(
            await database.selectFrom('jobs').select('id').where('type', '=', 'download').execute(),
          ).toEqual([]);
        },
      );
    });
  });

  it('requires admin auth and validates the country id and dated version shape', async () => {
    await withSourceServer({}, async (baseUrl) => {
      await withDownloadApp(baseUrl, '0', async ({ app, token, countryId }) => {
        const anonymous = await postDownload(app, undefined, countryId, 'latest');
        expect(anonymous.statusCode).toBe(401);
        const invalidVersion = await postDownload(app, token, countryId, '20261023');
        expect(invalidVersion.statusCode).toBe(400);
        expect(errorCode(invalidVersion)).toBe('VALIDATION_ERROR');
        const invalidCountry = await postDownload(app, token, 'not-a-uuid', 'latest');
        expect(invalidCountry.statusCode).toBe(400);
        expect(errorCode(invalidCountry)).toBe('VALIDATION_ERROR');
      });
    });
  });
});
