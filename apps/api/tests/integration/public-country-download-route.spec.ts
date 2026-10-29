import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { cacheCountryAdvisoryLockKey } from '../../src/db/repositories/cache';

import { buildApp, parseEnv } from '../../src/index';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const olderBytes = Buffer.from('older public map fixture\n');
const latestBytes = Buffer.from('latest public map fixture\n');
const olderMd5 = createHash('md5').update(olderBytes).digest('hex');
const latestMd5 = createHash('md5').update(latestBytes).digest('hex');

interface PublicDownloadHarness {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly cacheDir: string;
  readonly latestPath: string;
  readonly countryId: string;
}

async function withPublicDownloadApp(
  run: (harness: PublicDownloadHarness) => Promise<void>,
): Promise<void> {
  await withFreshDatabase(
    async (database, name) => {
      const countries = await database.db
        .insertInto('countries')
        .values([
          { source_id: 'europe/finland', slug: 'finland', name: 'Finland' },
          { source_id: 'europe/norway', slug: 'norway', name: 'Norway' },
          { source_id: 'europe/iceland', slug: 'iceland', name: 'Iceland' },
        ])
        .returning(['id', 'slug'])
        .execute();
      const countryId = (slug: string): string => {
        const row = countries.find((country) => country.slug === slug);
        if (row === undefined) throw new Error(`seed country ${slug} is missing`);
        return row.id;
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
            '261001',
            olderBytes,
            olderMd5,
            '2026-10-01T00:00:00.000Z',
          ),
          readyVersion(
            countryId('finland'),
            '261002',
            latestBytes,
            latestMd5,
            '2026-10-02T00:00:00.000Z',
          ),
          readyVersion(
            countryId('finland'),
            '261000-no-checksum',
            Buffer.from('no checksum'),
            null,
            '2026-09-30T00:00:00.000Z',
          ),
          { ...pendingVersion(countryId('finland')), version: '261003' },
          readyVersion(
            countryId('norway'),
            '261002',
            latestBytes,
            latestMd5,
            '2026-10-02T00:00:00.000Z',
          ),
          { ...pendingVersion(countryId('iceland')), version: '261001' },
        ])
        .execute();

      const cacheDir = await mkdtemp(join(tmpdir(), 'mapirror-public-stream-'));
      const latestPath = join(cacheDir, 'finland/261002/finland-261002.osm.pbf');
      const oldPath = join(cacheDir, 'finland/261001/finland-261001.osm.pbf');
      const noChecksumPath = join(
        cacheDir,
        'finland/261000-no-checksum/finland-261000-no-checksum.osm.pbf',
      );
      await Promise.all([
        writeFixture(latestPath, latestBytes),
        writeFixture(oldPath, olderBytes),
        writeFixture(noChecksumPath, Buffer.from('no checksum')),
      ]);
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name), CACHE_DIR: cacheDir }),
        database,
      });
      try {
        await run({ app, cacheDir, latestPath, countryId: countryId('finland') });
      } finally {
        await app.close();
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
    { prefix: 'publicstream', migrate: true },
  );
}

function readyVersion(
  countryId: string,
  version: string,
  bytes: Buffer,
  checksum: string | null,
  dataTimestamp: string,
) {
  return {
    country_id: countryId,
    version,
    origin: 'geofabrik_snapshot' as const,
    source_filename: `finland-${version}.osm.pbf`,
    data_timestamp: new Date(dataTimestamp),
    file_size_bytes: bytes.length,
    checksum_md5: checksum,
    storage_path: `finland/${version}/finland-${version}.osm.pbf`,
    status: 'ready' as const,
    ready_at: new Date(dataTimestamp),
  };
}

function pendingVersion(countryId: string) {
  return {
    country_id: countryId,
    origin: 'geofabrik_snapshot' as const,
    source_filename: 'pending.osm.pbf',
    file_size_bytes: 0,
    storage_path: 'finland/pending/pending.osm.pbf',
    status: 'pending' as const,
  };
}

async function writeFixture(path: string, bytes: Buffer): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
}

async function tryExclusiveCountryLock(
  app: Awaited<ReturnType<typeof buildApp>>,
  countryId: string,
): Promise<boolean> {
  return app.db.db.connection().execute(async (connection) => {
    const lockKey = cacheCountryAdvisoryLockKey(countryId);
    const result = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as locked
    `.execute(connection);
    const locked = result.rows[0]?.locked === true;
    if (locked) {
      await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.execute(connection);
    }
    return locked;
  });
}

function publicDownloadUrl(slug = 'finland', version?: string): string {
  return `/_public/api/countries/${slug}/download${version === undefined ? '' : `?version=${encodeURIComponent(version)}`}`;
}

describe.skipIf(skipReason !== null)('public country download stream', () => {
  it('streams latest by default and an exact version with their different cache policies', async () => {
    await withPublicDownloadApp(async ({ app }) => {
      const latest = await app.inject({ method: 'GET', url: publicDownloadUrl() });
      expect(latest.statusCode).toBe(200);
      expect(latest.body).toBe(latestBytes.toString());
      expect(latest.headers).toMatchObject({
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        'content-disposition': 'attachment; filename="finland-261002.osm.pbf"',
        'content-length': String(latestBytes.length),
        'content-type': 'application/x-protobuf',
        etag: `"md5:${latestMd5}"`,
        'last-modified': new Date('2026-10-02T00:00:00.000Z').toUTCString(),
        'x-checksum-md5': latestMd5,
      });

      const explicit = await app.inject({
        method: 'GET',
        url: publicDownloadUrl('finland', '261001'),
      });
      expect(explicit.statusCode).toBe(200);
      expect(explicit.body).toBe(olderBytes.toString());
      expect(explicit.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(explicit.headers.etag).toBe(`"md5:${olderMd5}"`);
    });
  });

  it('supports single, open-ended, and suffix byte ranges; ignores malformed and multi-range values', async () => {
    await withPublicDownloadApp(async ({ app }) => {
      const cases = [
        {
          range: 'bytes=2-7',
          expected: latestBytes.subarray(2, 8),
          contentRange: `bytes 2-7/${latestBytes.length}`,
        },
        {
          range: 'bytes=4-',
          expected: latestBytes.subarray(4),
          contentRange: `bytes 4-${latestBytes.length - 1}/${latestBytes.length}`,
        },
        {
          range: 'bytes=-5',
          expected: latestBytes.subarray(-5),
          contentRange: `bytes ${latestBytes.length - 5}-${latestBytes.length - 1}/${latestBytes.length}`,
        },
      ];
      for (const testCase of cases) {
        const response = await app.inject({
          method: 'GET',
          url: publicDownloadUrl(),
          headers: { range: testCase.range },
        });
        expect(response.statusCode, testCase.range).toBe(206);
        expect(response.body, testCase.range).toBe(testCase.expected.toString());
        expect(response.headers['content-range'], testCase.range).toBe(testCase.contentRange);
        expect(response.headers['content-length'], testCase.range).toBe(
          String(testCase.expected.length),
        );
      }

      for (const range of [
        'items=0-1',
        'bytes=999999-',
        'bytes=8-2',
        'bytes=0-1,4-5',
        'bytes=-0',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: publicDownloadUrl(),
          headers: { range },
        });
        expect(response.statusCode, range).toBe(200);
        expect(response.body, range).toBe(latestBytes.toString());
        expect(response.headers['content-range'], range).toBeUndefined();
      }
    });
  });

  it('applies If-Range, If-None-Match, wildcard and HEAD without sending a body', async () => {
    await withPublicDownloadApp(async ({ app }) => {
      const ranged = await app.inject({
        method: 'GET',
        url: publicDownloadUrl(),
        headers: { range: 'bytes=0-3', 'if-range': `"md5:${latestMd5}"` },
      });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.body).toBe(latestBytes.subarray(0, 4).toString());

      const rangedByDate = await app.inject({
        method: 'GET',
        url: publicDownloadUrl(),
        headers: {
          range: 'bytes=0-3',
          'if-range': new Date('2026-10-02T00:00:00.000Z').toUTCString(),
        },
      });
      expect(rangedByDate.statusCode).toBe(206);
      expect(rangedByDate.body).toBe(latestBytes.subarray(0, 4).toString());

      const staleDate = await app.inject({
        method: 'GET',
        url: publicDownloadUrl(),
        headers: {
          range: 'bytes=0-3',
          'if-range': new Date('2026-10-01T00:00:00.000Z').toUTCString(),
        },
      });
      expect(staleDate.statusCode).toBe(200);
      expect(staleDate.body).toBe(latestBytes.toString());

      const ignoredRange = await app.inject({
        method: 'GET',
        url: publicDownloadUrl(),
        headers: { range: 'bytes=0-3', 'if-range': '"different-representation"' },
      });
      expect(ignoredRange.statusCode).toBe(200);
      expect(ignoredRange.body).toBe(latestBytes.toString());

      const notModified = await app.inject({
        method: 'GET',
        url: publicDownloadUrl(),
        headers: { 'if-none-match': `"other", W/"md5:${latestMd5}"` },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe('');
      expect(notModified.headers['content-length']).toBeUndefined();
      expect(notModified.headers.etag).toBe(`"md5:${latestMd5}"`);

      const wildcard = await app.inject({
        method: 'GET',
        url: publicDownloadUrl('finland', '261000-no-checksum'),
        headers: { 'if-none-match': '*' },
      });
      expect(wildcard.statusCode).toBe(304);
      expect(wildcard.headers.etag).toBeUndefined();

      const head = await app.inject({ method: 'HEAD', url: publicDownloadUrl() });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers['content-length']).toBe(String(latestBytes.length));
    });
  });

  it('holds the shared cache lock until an active public transfer closes', async () => {
    const largeBytes = Buffer.alloc(16 * 1024 * 1024, 0x5a);
    await withPublicDownloadApp(async ({ app, countryId, latestPath }) => {
      await writeFile(latestPath, largeBytes);
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      let clientResponse: IncomingMessage | undefined;
      try {
        const responseStarted = new Promise<void>((resolve, reject) => {
          const client = get(new URL(publicDownloadUrl(), address), (response) => {
            clientResponse = response;
            response.once('data', () => {
              response.pause();
              resolve();
            });
          });
          client.once('error', reject);
        });
        await responseStarted;
        expect(await tryExclusiveCountryLock(app, countryId)).toBe(false);

        const responseClosed = new Promise<void>((resolve) => {
          clientResponse?.once('close', resolve);
        });
        clientResponse?.destroy();
        await responseClosed;

        let lockReleased = false;
        for (let attempt = 0; attempt < 50 && !lockReleased; attempt += 1) {
          lockReleased = await tryExclusiveCountryLock(app, countryId);
          if (!lockReleased) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(lockReleased).toBe(true);
      } finally {
        clientResponse?.destroy();
      }
    });
  });

  it('hides unpublished, unknown, and non-ready versions, and maps a missing file to 410', async () => {
    await withPublicDownloadApp(async ({ app, latestPath }) => {
      const hidden = await app.inject({ method: 'GET', url: publicDownloadUrl('norway') });
      const unknown = await app.inject({ method: 'GET', url: publicDownloadUrl('unknown') });
      expect(hidden.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(hidden.json<{ error: { code: string; message: string } }>().error).toMatchObject({
        code: 'NOT_FOUND',
        message: unknown.json<{ error: { message: string } }>().error.message,
      });

      for (const version of ['261003', 'not-cached']) {
        const response = await app.inject({
          method: 'GET',
          url: publicDownloadUrl('finland', version),
        });
        expect(response.statusCode).toBe(404);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
      }
      const pendingOnly = await app.inject({ method: 'GET', url: publicDownloadUrl('iceland') });
      expect(pendingOnly.statusCode).toBe(404);

      await rm(latestPath);
      const missing = await app.inject({ method: 'GET', url: publicDownloadUrl() });
      expect(missing.statusCode).toBe(410);
      expect(missing.json<{ error: { code: string } }>().error.code).toBe('VERSION_FILE_MISSING');
      expect(missing.body).not.toContain('finland/261002');
    });
  });
});
