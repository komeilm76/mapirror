import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const bytes = Buffer.from('verified cached map stream\n');
const checksum = createHash('md5').update(bytes).digest('hex');

interface StreamHarness {
  readonly app: FastifyInstance;
  readonly token: string;
  readonly countryId: string;
  readonly versionId: string;
  readonly filePath: string;
  readonly cacheDir: string;
}

async function withStreamApp(run: (harness: StreamHarness) => Promise<void>): Promise<void> {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'version-stream-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const token = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const country = await database.db
        .insertInto('countries')
        .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await database.db
        .insertInto('country_cache')
        .values({ country_id: country.id, versions_ready_count: 1, total_size_bytes: bytes.length })
        .execute();
      const version = await database.db
        .insertInto('map_versions')
        .values({
          country_id: country.id,
          version: '261023',
          origin: 'geofabrik_snapshot',
          source_filename: 'finland-261023.osm.pbf',
          data_timestamp: new Date('2026-10-23T20:20:51.000Z'),
          file_size_bytes: bytes.length,
          checksum_md5: checksum,
          storage_path: 'finland/261023/finland-261023.osm.pbf',
          status: 'ready',
          ready_at: new Date('2026-10-24T00:00:00.000Z'),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const cacheDir = await mkdtemp(join(tmpdir(), 'mapirror-version-stream-'));
      const filePath = join(cacheDir, 'finland/261023/finland-261023.osm.pbf');
      await mkdir(join(cacheDir, 'finland/261023'), { recursive: true });
      await writeFile(filePath, bytes);
      const app = await buildApp({
        config: parseEnv({
          DATABASE_URL: dsnFor(name),
          CACHE_DIR: cacheDir,
          IP_HASH_SALT: 'integration-test-salt',
        }),
        database,
      });
      try {
        await run({
          app,
          token: token.token,
          countryId: country.id,
          versionId: version.id,
          filePath,
          cacheDir,
        });
      } finally {
        await app.close();
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
    { prefix: 'versionstream', migrate: true },
  );
}

function streamUrl(countryId: string, versionId: string): string {
  return `/_admin/api/cache/${countryId}/versions/${versionId}/download`;
}

function getStream(
  app: FastifyInstance,
  token: string | undefined,
  countryId: string,
  versionId: string,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'GET',
    url: streamUrl(countryId, versionId),
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
  });
}

describe.skipIf(skipReason !== null)('admin cached-version download stream', () => {
  it('streams the verified file with public-compatible headers and records the admin channel', async () => {
    await withStreamApp(async ({ app, token, countryId, versionId }) => {
      const response = await getStream(app, token, countryId, versionId, {
        'user-agent': 'integration-test-client',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(bytes.toString());
      expect(response.headers).toMatchObject({
        'accept-ranges': 'bytes',
        'cache-control': 'private, no-store',
        'content-disposition': 'attachment; filename="finland-261023.osm.pbf"',
        'content-length': String(bytes.length),
        'content-type': 'application/x-protobuf',
        etag: `"md5:${checksum}"`,
        'x-checksum-md5': checksum,
      });

      const events = await app.db.db
        .selectFrom('download_events')
        .select(['country_id', 'version_id', 'channel', 'bytes_sent', 'ip_hash', 'user_agent'])
        .execute();
      expect(events).toEqual([
        {
          country_id: countryId,
          version_id: versionId,
          channel: 'admin',
          bytes_sent: String(bytes.length),
          ip_hash: createHash('sha256').update(`127.0.0.1integration-test-salt`).digest('hex'),
          user_agent: 'integration-test-client',
        },
      ]);
    });
  });

  it('supports a single byte range and records only the streamed portion', async () => {
    await withStreamApp(async ({ app, token, countryId, versionId }) => {
      const response = await getStream(app, token, countryId, versionId, { range: 'bytes=2-7' });

      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toBe(`bytes 2-7/${bytes.length}`);
      expect(response.headers['content-length']).toBe('6');
      expect(response.body).toBe(bytes.subarray(2, 8).toString());
      const event = await app.db.db
        .selectFrom('download_events')
        .select(['channel', 'bytes_sent'])
        .executeTakeFirstOrThrow();
      expect(event).toEqual({ channel: 'admin', bytes_sent: '6' });
    });
  });

  it('answers HEAD and a matching If-None-Match without recording a download', async () => {
    await withStreamApp(async ({ app, token, countryId, versionId }) => {
      const head = await app.inject({
        method: 'HEAD',
        url: streamUrl(countryId, versionId),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers['content-length']).toBe(String(bytes.length));

      const notModified = await getStream(app, token, countryId, versionId, {
        'if-none-match': `W/"md5:${checksum}"`,
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe('');
      expect(await app.db.db.selectFrom('download_events').selectAll().execute()).toEqual([]);
    });
  });

  it('requires admin authentication and hides missing or non-ready versions', async () => {
    await withStreamApp(async ({ app, token, countryId, versionId }) => {
      expect((await getStream(app, undefined, countryId, versionId)).statusCode).toBe(401);
      const unknown = await getStream(
        app,
        token,
        countryId,
        '00000000-0000-4000-8000-000000000000',
      );
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    });
  });

  it('returns 410 when the ready row exists but its safe storage file is gone', async () => {
    await withStreamApp(async ({ app, token, countryId, versionId, filePath }) => {
      await rm(filePath);
      const response = await getStream(app, token, countryId, versionId);
      expect(response.statusCode).toBe(410);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VERSION_FILE_MISSING');
      expect(await app.db.db.selectFrom('download_events').selectAll().execute()).toEqual([]);
    });
  });

  it('holds the shared country lock until a slow client closes its response', async () => {
    const slowBytes = Buffer.alloc(16 * 1024 * 1024, 0x5a);
    const slowChecksum = createHash('md5').update(slowBytes).digest('hex');
    await withFreshDatabase(
      async (database, name) => {
        const admin = await database.db
          .insertInto('admins')
          .values({ username: 'slow-stream-admin', password_hash: 'unused' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const token = await issueToken(database.db, admin.id, { ttlHours: 12 });
        const country = await database.db
          .insertInto('countries')
          .values({ source_id: 'europe/test', slug: 'test', name: 'Test' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await database.db.insertInto('country_cache').values({ country_id: country.id }).execute();
        const version = await database.db
          .insertInto('map_versions')
          .values({
            country_id: country.id,
            version: '261023',
            origin: 'geofabrik_snapshot',
            source_filename: 'test-261023.osm.pbf',
            file_size_bytes: slowBytes.length,
            checksum_md5: slowChecksum,
            storage_path: 'test/261023/test-261023.osm.pbf',
            status: 'ready',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const cacheDir = await mkdtemp(join(tmpdir(), 'mapirror-slow-stream-'));
        const filePath = join(cacheDir, 'test/261023/test-261023.osm.pbf');
        await mkdir(join(cacheDir, 'test/261023'), { recursive: true });
        await writeFile(filePath, slowBytes);
        const app = await buildApp({
          config: parseEnv({ DATABASE_URL: dsnFor(name), CACHE_DIR: cacheDir }),
          database,
        });
        const address = await app.listen({ port: 0, host: '127.0.0.1' });
        const base = new URL(address);
        let clientResponse: IncomingMessage | undefined;
        try {
          const responseStarted = new Promise<void>((resolve, reject) => {
            const client = get(
              new URL(streamUrl(country.id, version.id), base),
              { headers: { authorization: `Bearer ${token.token}` } },
              (response) => {
                clientResponse = response;
                response.once('data', () => {
                  response.pause();
                  resolve();
                });
              },
            );
            client.once('error', reject);
          });
          await responseStarted;
          let deleteFinished = false;
          const deletion = app
            .inject({
              method: 'DELETE',
              url: `/_admin/api/cache/${country.id}?confirm=test`,
              headers: { authorization: `Bearer ${token.token}` },
            })
            .then((response) => {
              deleteFinished = true;
              return response;
            });
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(deleteFinished).toBe(false);
          clientResponse?.destroy();
          const deleted = await deletion;
          expect(deleted.statusCode).toBe(204);
          await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
          const event = await app.db.db
            .selectFrom('download_events')
            .select(['country_id', 'version_id', 'channel', 'bytes_sent', 'ip_hash'])
            .executeTakeFirstOrThrow();
          expect(event.country_id).toBe(country.id);
          // P2-API-08 removes the version before this assertion; the event survives with SET NULL semantics.
          expect(event.version_id).toBeNull();
          expect(event.channel).toBe('admin');
          expect(event.ip_hash === null || typeof event.ip_hash === 'string').toBe(true);
          if (event.ip_hash !== null) expect(event.ip_hash).toHaveLength(64);
          const storedSalt = await app.db.db
            .selectFrom('settings')
            .select('value')
            .where('key', '=', 'privacy.ipHashSalt')
            .executeTakeFirstOrThrow();
          expect(typeof storedSalt.value).toBe('string');
          expect((storedSalt.value as string).length).toBe(64);
          expect(BigInt(event.bytes_sent)).toBeGreaterThan(0n);
          expect(BigInt(event.bytes_sent)).toBeLessThan(BigInt(slowBytes.length));
        } finally {
          clientResponse?.destroy();
          await app.close();
          await rm(cacheDir, { recursive: true, force: true });
        }
      },
      { prefix: 'slowstream', migrate: true },
    );
  });
});
