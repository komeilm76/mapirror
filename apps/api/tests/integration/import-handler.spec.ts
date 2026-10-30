import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/db/schema';
import { createImportHandler } from '../../src/modules/jobs/import-handler';
import { createCacheStorage, type CacheStorage } from '../../src/modules/storage/storage';
import { createUploadStorage } from '../../src/modules/storage/upload-storage';
import { startJobWorker } from '../../src/modules/jobs/worker';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';
import {
  GEOFABRIK_PBF_FIXTURE_MD5,
  getGeofabrikPbfFixture,
} from '../helpers/geofabrik-fixture-server';

const skipReason = await freshDatabaseSkipReason();
const payloadBytes = getGeofabrikPbfFixture();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function withStorageRoots<T>(
  run: (temporaryDirectory: string, cacheDirectory: string) => Promise<T>,
): Promise<T> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mapirror-import-handler-tmp-'));
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'mapirror-import-handler-cache-'));
  try {
    return await run(temporaryDirectory, cacheDirectory);
  } finally {
    await Promise.all([
      rm(temporaryDirectory, { recursive: true, force: true }),
      rm(cacheDirectory, { recursive: true, force: true }),
    ]);
  }
}

async function seedImport(
  database: Kysely<Database>,
  temporaryDirectory: string,
  options: { readonly maxAttempts?: number; readonly bytes?: Buffer } = {},
): Promise<{
  readonly countryId: string;
  readonly jobId: string;
  readonly uploadId: string;
  readonly tempPath: string;
}> {
  const bytes = options.bytes ?? payloadBytes;
  const country = await database
    .insertInto('countries')
    .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const storage = createUploadStorage(temporaryDirectory);
  const staged = storage.file(randomUUID());
  const file = await staged.openForWrite();
  await file.writeFile(bytes);
  await file.close();

  const session = await database
    .insertInto('upload_sessions')
    .values({
      country_id: country.id,
      version: '261030',
      original_name: 'finland.osm.pbf',
      temp_path: staged.relativePath,
      size_bytes: bytes.byteLength,
      status: 'received',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const job = await database
    .insertInto('jobs')
    .values({
      type: 'import',
      payload: {
        uploadId: session.id,
        countryId: country.id,
        version: '261030',
        replace: false,
      },
      max_attempts: options.maxAttempts ?? 3,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await database
    .updateTable('upload_sessions')
    .set({ job_id: job.id })
    .where('id', '=', session.id)
    .execute();
  return {
    countryId: country.id,
    jobId: job.id,
    uploadId: session.id,
    tempPath: staged.relativePath,
  };
}

async function waitForStatus(
  database: Kysely<Database>,
  jobId: string,
  expected: 'succeeded' | 'failed' | 'canceled',
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await database
      .selectFrom('jobs')
      .select('status')
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (job?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Import job ${jobId} did not reach ${expected} before the test deadline.`);
}

describe.skipIf(skipReason !== null)('PostgreSQL import handler', () => {
  it('checksums, atomically installs, then publishes the ready version and installed session', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withStorageRoots(async (temporaryDirectory, cacheDirectory) => {
          const seeded = await seedImport(db, temporaryDirectory);
          const worker = startJobWorker(
            db,
            {
              import: createImportHandler({
                config: { tmpDir: temporaryDirectory, cacheDir: cacheDirectory },
              }),
            },
            {
              concurrency: 1,
              pollIntervalMs: 5,
              heartbeatIntervalMs: 1_000,
              cancellationPollIntervalMs: 5,
              retryBaseDelayMs: 5,
              retryMaxDelayMs: 5,
              log,
            },
          );
          try {
            await waitForStatus(db, seeded.jobId, 'succeeded');
          } finally {
            await worker.stop();
          }

          const version = await db
            .selectFrom('map_versions')
            .selectAll()
            .where('country_id', '=', seeded.countryId)
            .executeTakeFirstOrThrow();
          expect(version).toMatchObject({
            version: '261030',
            origin: 'upload',
            source_filename: 'finland.osm.pbf',
            file_size_bytes: String(payloadBytes.byteLength),
            checksum_md5: GEOFABRIK_PBF_FIXTURE_MD5,
            status: 'ready',
            job_id: seeded.jobId,
            storage_path: `finland/261030/upload-${seeded.uploadId}.osm.pbf`,
          });
          await expect(readFile(join(cacheDirectory, version.storage_path))).resolves.toEqual(
            payloadBytes,
          );
          await expect(readFile(join(temporaryDirectory, seeded.tempPath))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          await expect(
            readFile(join(cacheDirectory, '.partial', `${seeded.jobId}.part`)),
          ).rejects.toMatchObject({
            code: 'ENOENT',
          });
          const session = await db
            .selectFrom('upload_sessions')
            .select(['status', 'checksum_md5'])
            .where('id', '=', seeded.uploadId)
            .executeTakeFirstOrThrow();
          expect(session).toEqual({ status: 'installed', checksum_md5: GEOFABRIK_PBF_FIXTURE_MD5 });
          const summary = await db
            .selectFrom('country_cache')
            .select(['versions_ready_count', 'total_size_bytes'])
            .where('country_id', '=', seeded.countryId)
            .executeTakeFirstOrThrow();
          expect(summary).toEqual({
            versions_ready_count: 1,
            total_size_bytes: String(payloadBytes.byteLength),
          });
        });
      },
      { migrate: true, prefix: 'jobimport' },
    );
  });

  it('leaves no ready version when cache installation fails and cleans before terminal failure', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withStorageRoots(async (temporaryDirectory, cacheDirectory) => {
          const seeded = await seedImport(db, temporaryDirectory, { maxAttempts: 1 });
          const realCache = createCacheStorage(cacheDirectory);
          const failingCache: CacheStorage = {
            ...realCache,
            installPart: () => Promise.reject(new Error('simulated atomic install failure')),
          };
          const worker = startJobWorker(
            db,
            {
              import: createImportHandler({
                config: { tmpDir: temporaryDirectory, cacheDir: cacheDirectory },
                cacheStorage: failingCache,
              }),
            },
            {
              concurrency: 1,
              pollIntervalMs: 5,
              heartbeatIntervalMs: 1_000,
              cancellationPollIntervalMs: 5,
              retryBaseDelayMs: 5,
              retryMaxDelayMs: 5,
              log,
            },
          );
          try {
            await waitForStatus(db, seeded.jobId, 'failed');
          } finally {
            await worker.stop();
          }

          const versions = await db
            .selectFrom('map_versions')
            .select(['status', 'failure_reason'])
            .where('country_id', '=', seeded.countryId)
            .execute();
          expect(versions).toEqual([{ status: 'failed', failure_reason: 'IMPORT_FAILED' }]);
          const session = await db
            .selectFrom('upload_sessions')
            .select('status')
            .where('id', '=', seeded.uploadId)
            .executeTakeFirstOrThrow();
          expect(session.status).toBe('failed');
          await expect(readFile(join(temporaryDirectory, seeded.tempPath))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          await expect(
            readFile(join(cacheDirectory, '.partial', `${seeded.jobId}.part`)),
          ).rejects.toMatchObject({
            code: 'ENOENT',
          });
          const readyCount = await db
            .selectFrom('map_versions')
            .select((expression) => expression.fn.countAll().as('count'))
            .where('country_id', '=', seeded.countryId)
            .where('status', '=', 'ready')
            .executeTakeFirstOrThrow();
          expect(Number(readyCount.count)).toBe(0);
        });
      },
      { migrate: true, prefix: 'jobimportfail' },
    );
  });
});
