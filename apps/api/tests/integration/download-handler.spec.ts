import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ResolvedDownload, MapSource } from '../../src/modules/geofabrik/source';
import { createDownloadHandler } from '../../src/modules/jobs/download-handler';
import { startJobWorker } from '../../src/modules/jobs/worker';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const payloadBytes = new TextEncoder().encode('map data bytes; exact and verifiable\n');
const md5 = createHash('md5').update(payloadBytes).digest('hex');

function source(
  checksumMd5: string | null = md5,
  overrides: Partial<ResolvedDownload> = {},
): MapSource {
  const resolved: ResolvedDownload = {
    version: '261023',
    url: 'https://download.geofabrik.de/europe/test-261023.osm.pbf',
    sizeBytes: payloadBytes.byteLength,
    dataTimestamp: new Date('2026-10-23T20:20:51.000Z'),
    checksumMd5,
    etag: '"immutable-test-snapshot"',
    lastModified: null,
    ...overrides,
  };
  return {
    id: 'geofabrik',
    listRegions: () => Promise.resolve([]),
    getRegionDetail: () => Promise.reject(new Error('not used')),
    listSnapshots: () => Promise.resolve([]),
    resolveDownload: () => Promise.resolve(resolved),
  };
}

function bytesResponse(
  bytes: Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(bytes, {
    status,
    headers: {
      'content-length': String(bytes.byteLength),
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

async function withWorkspace<T>(run: (cacheDirectory: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'mapirror-download-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(skipReason !== null)('PostgreSQL download handler', () => {
  it('streams byte-identical data, verifies MD5, installs atomically, and publishes the ready version', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withWorkspace(async (cacheDirectory) => {
          const country = await db
            .insertInto('countries')
            .values({ source: 'geofabrik', source_id: 'europe/test', slug: 'test', name: 'Test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const job = await db
            .insertInto('jobs')
            .values({ type: 'download', payload: { countryId: country.id, version: '261023' } })
            .returningAll()
            .executeTakeFirstOrThrow();
          const handler = createDownloadHandler({
            source: source(null),
            cacheDirectory,
            fetchImpl: (url) =>
              Promise.resolve(
                String(url).endsWith('.md5')
                  ? new Response(`${md5}  test-261023.osm.pbf\n`)
                  : bytesResponse(payloadBytes),
              ),
          });
          const worker = startJobWorker(
            db,
            { download: handler },
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
            await waitForStatus(db, job.id, 'succeeded');
          } finally {
            await worker.stop();
          }

          const version = await db
            .selectFrom('map_versions')
            .selectAll()
            .where('country_id', '=', country.id)
            .executeTakeFirstOrThrow();
          expect(version).toMatchObject({
            version: '261023',
            origin: 'geofabrik_snapshot',
            source_filename: 'test-261023.osm.pbf',
            file_size_bytes: String(payloadBytes.byteLength),
            checksum_md5: md5,
            status: 'ready',
            storage_path: 'test/261023/test-261023.osm.pbf',
          });
          expect(
            Uint8Array.from(await readFile(join(cacheDirectory, version.storage_path))),
          ).toEqual(payloadBytes);
          await expect(
            stat(join(cacheDirectory, '.partial', `${job.id}.part`)),
          ).rejects.toMatchObject({
            code: 'ENOENT',
          });
          const summary = await db
            .selectFrom('country_cache')
            .select(['versions_ready_count', 'total_size_bytes'])
            .where('country_id', '=', country.id)
            .executeTakeFirstOrThrow();
          expect(summary).toEqual({
            versions_ready_count: 1,
            total_size_bytes: String(payloadBytes.byteLength),
          });
        });
      },
      { migrate: true, prefix: 'jobdownload' },
    );
  });

  it('resumes a valid partial file with Range and preserves byte identity', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withWorkspace(async (cacheDirectory) => {
          const country = await db
            .insertInto('countries')
            .values({ source: 'geofabrik', source_id: 'europe/test', slug: 'test', name: 'Test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const job = await db
            .insertInto('jobs')
            .values({ type: 'download', payload: { countryId: country.id, version: '261023' } })
            .returningAll()
            .executeTakeFirstOrThrow();
          const partialDirectory = join(cacheDirectory, '.partial');
          await mkdir(partialDirectory, { recursive: true });
          const prefix = payloadBytes.slice(0, 11);
          await writeFile(join(partialDirectory, `${job.id}.part`), prefix);
          let rangeHeader: string | null = null;
          let ifRangeHeader: string | null = null;
          const handler = createDownloadHandler({
            source: source(),
            cacheDirectory,
            fetchImpl: (_url, init) => {
              const headers = new Headers(init?.headers);
              rangeHeader = headers.get('range');
              ifRangeHeader = headers.get('if-range');
              return Promise.resolve(
                bytesResponse(payloadBytes.slice(prefix.byteLength), 206, {
                  'content-range': `bytes ${prefix.byteLength}-${payloadBytes.byteLength - 1}/${payloadBytes.byteLength}`,
                }),
              );
            },
          });
          const worker = startJobWorker(
            db,
            { download: handler },
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
            await waitForStatus(db, job.id, 'succeeded');
          } finally {
            await worker.stop();
          }
          const installed = await readFile(join(cacheDirectory, 'test/261023/test-261023.osm.pbf'));
          expect(Uint8Array.from(installed)).toEqual(payloadBytes);
          expect(rangeHeader).toBe(`bytes=${prefix.byteLength}-`);
          expect(ifRangeHeader).toBe('"immutable-test-snapshot"');
        });
      },
      { migrate: true, prefix: 'jobresume' },
    );
  });

  it('restarts from zero when a range request receives a full 200 response', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withWorkspace(async (cacheDirectory) => {
          const country = await db
            .insertInto('countries')
            .values({ source: 'geofabrik', source_id: 'europe/test', slug: 'test', name: 'Test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const job = await db
            .insertInto('jobs')
            .values({ type: 'download', payload: { countryId: country.id, version: '261023' } })
            .returningAll()
            .executeTakeFirstOrThrow();
          await mkdir(join(cacheDirectory, '.partial'), { recursive: true });
          await writeFile(
            join(cacheDirectory, '.partial', `${job.id}.part`),
            payloadBytes.slice(0, 8),
          );
          const handler = createDownloadHandler({
            source: source(),
            cacheDirectory,
            fetchImpl: () => Promise.resolve(bytesResponse(payloadBytes)),
          });
          const worker = startJobWorker(
            db,
            { download: handler },
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
            await waitForStatus(db, job.id, 'succeeded');
          } finally {
            await worker.stop();
          }
          expect(
            Uint8Array.from(
              await readFile(join(cacheDirectory, 'test/261023/test-261023.osm.pbf')),
            ),
          ).toEqual(payloadBytes);
        });
      },
      { migrate: true, prefix: 'jobrange200' },
    );
  });

  it('rejects and cancels a 206 response whose Content-Range does not start at the local offset', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withWorkspace(async (cacheDirectory) => {
          const country = await db
            .insertInto('countries')
            .values({ source: 'geofabrik', source_id: 'europe/test', slug: 'test', name: 'Test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const job = await db
            .insertInto('jobs')
            .values({
              type: 'download',
              payload: { countryId: country.id, version: '261023' },
              max_attempts: 1,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const prefix = payloadBytes.slice(0, 8);
          const partialDirectory = join(cacheDirectory, '.partial');
          await mkdir(partialDirectory, { recursive: true });
          const partialPath = join(partialDirectory, `${job.id}.part`);
          await writeFile(partialPath, prefix);
          let responseCanceled = false;
          let closeTimer: ReturnType<typeof setTimeout> | undefined;
          const handler = createDownloadHandler({
            source: source(),
            cacheDirectory,
            fetchImpl: () =>
              Promise.resolve(
                new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(payloadBytes.slice(prefix.byteLength));
                      closeTimer = setTimeout(() => controller.close(), 25);
                    },
                    cancel() {
                      responseCanceled = true;
                      if (closeTimer !== undefined) clearTimeout(closeTimer);
                    },
                  }),
                  {
                    status: 206,
                    headers: {
                      'content-length': String(payloadBytes.byteLength - prefix.byteLength),
                      'content-range': `bytes 0-${payloadBytes.byteLength - prefix.byteLength - 1}/${payloadBytes.byteLength}`,
                    },
                  },
                ),
              ),
          });
          const worker = startJobWorker(
            db,
            { download: handler },
            {
              concurrency: 1,
              pollIntervalMs: 5,
              heartbeatIntervalMs: 1_000,
              cancellationPollIntervalMs: 5,
              log,
            },
          );
          try {
            await waitForStatus(db, job.id, 'failed');
          } finally {
            await worker.stop();
          }
          expect(responseCanceled).toBe(true);
          expect(Uint8Array.from(await readFile(partialPath))).toEqual(prefix);
          await expect(
            stat(join(cacheDirectory, 'test/261023/test-261023.osm.pbf')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        });
      },
      { migrate: true, prefix: 'jobbadrange' },
    );
  });

  it('stores latest with a database-valid immutable timestamp and refuses weak-validator resume', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withWorkspace(async (cacheDirectory) => {
          const country = await db
            .insertInto('countries')
            .values({ source: 'geofabrik', source_id: 'europe/test', slug: 'test', name: 'Test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const job = await db
            .insertInto('jobs')
            .values({ type: 'download', payload: { countryId: country.id, version: 'latest' } })
            .returningAll()
            .executeTakeFirstOrThrow();
          const partialDirectory = join(cacheDirectory, '.partial');
          await mkdir(partialDirectory, { recursive: true });
          await writeFile(join(partialDirectory, `${job.id}.part`), payloadBytes.slice(0, 8));
          let rangeHeader: string | null = null;
          const handler = createDownloadHandler({
            source: source(md5, {
              url: 'https://download.geofabrik.de/europe/test-latest.osm.pbf',
              etag: 'W/"weak-latest-tag"',
              lastModified: null,
            }),
            cacheDirectory,
            fetchImpl: (_url, init) => {
              rangeHeader = new Headers(init?.headers).get('range');
              return Promise.resolve(bytesResponse(payloadBytes));
            },
          });
          const worker = startJobWorker(
            db,
            { download: handler },
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
            await waitForStatus(db, job.id, 'succeeded');
          } finally {
            await worker.stop();
          }
          const version = await db
            .selectFrom('map_versions')
            .select(['version', 'origin', 'storage_path'])
            .where('job_id', '=', job.id)
            .executeTakeFirstOrThrow();
          expect(version).toEqual({
            version: 'latest@2026-10-23T20-20-51Z',
            origin: 'geofabrik_latest',
            storage_path: 'test/latest@2026-10-23T20-20-51Z/test-latest.osm.pbf',
          });
          expect(rangeHeader).toBeNull();
          expect(
            Uint8Array.from(await readFile(join(cacheDirectory, version.storage_path))),
          ).toEqual(payloadBytes);
        });
      },
      { migrate: true, prefix: 'joblatest' },
    );
  });

  it('rejects a bad MD5 and removes the partial artifact before the worker records terminal failure', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withWorkspace(async (cacheDirectory) => {
          const country = await db
            .insertInto('countries')
            .values({ source: 'geofabrik', source_id: 'europe/test', slug: 'test', name: 'Test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const job = await db
            .insertInto('jobs')
            .values({
              type: 'download',
              payload: { countryId: country.id, version: '261023' },
              max_attempts: 1,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const handler = createDownloadHandler({
            source: source('0'.repeat(32)),
            cacheDirectory,
            fetchImpl: () => Promise.resolve(bytesResponse(payloadBytes)),
          });
          const worker = startJobWorker(
            db,
            { download: handler },
            {
              concurrency: 1,
              pollIntervalMs: 5,
              heartbeatIntervalMs: 1_000,
              cancellationPollIntervalMs: 5,
              log,
            },
          );
          try {
            await waitForStatus(db, job.id, 'failed');
          } finally {
            await worker.stop();
          }
          const failed = await db
            .selectFrom('jobs')
            .select(['error_code', 'error_message'])
            .where('id', '=', job.id)
            .executeTakeFirstOrThrow();
          expect(failed).toEqual({
            error_code: 'JOB_HANDLER_FAILED',
            error_message: 'The job handler failed.',
          });
          expect(
            await db
              .selectFrom('map_versions')
              .select('status')
              .where('country_id', '=', country.id)
              .executeTakeFirst(),
          ).toEqual({ status: 'failed' });
          await expect(
            db
              .selectFrom('country_cache')
              .select(['versions_ready_count', 'total_size_bytes'])
              .where('country_id', '=', country.id)
              .executeTakeFirstOrThrow(),
          ).resolves.toEqual({ versions_ready_count: 0, total_size_bytes: '0' });
          await expect(
            stat(join(cacheDirectory, '.partial', `${job.id}.part`)),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(
            stat(join(cacheDirectory, 'test/261023/test-261023.osm.pbf')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        });
      },
      { migrate: true, prefix: 'jobchecksum' },
    );
  });

  it('cooperatively cancels a stream and removes the partial file before canceled is persisted', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withWorkspace(async (cacheDirectory) => {
          const country = await db
            .insertInto('countries')
            .values({ source: 'geofabrik', source_id: 'europe/test', slug: 'test', name: 'Test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const job = await db
            .insertInto('jobs')
            .values({ type: 'download', payload: { countryId: country.id, version: '261023' } })
            .returningAll()
            .executeTakeFirstOrThrow();
          const handler = createDownloadHandler({
            source: source(),
            cacheDirectory,
            fetchImpl: () =>
              Promise.resolve(
                new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(payloadBytes.slice(0, 9));
                    },
                  }),
                  { status: 200 },
                ),
              ),
          });
          const worker = startJobWorker(
            db,
            { download: handler },
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
            await waitForFileSize(join(cacheDirectory, '.partial', `${job.id}.part`), 9);
            await db
              .updateTable('jobs')
              .set({ cancel_requested: true })
              .where('id', '=', job.id)
              .execute();
            await waitForStatus(db, job.id, 'canceled');
            await expect(
              stat(join(cacheDirectory, '.partial', `${job.id}.part`)),
            ).rejects.toMatchObject({ code: 'ENOENT' });
          } finally {
            await worker.stop();
          }
        });
      },
      { migrate: true, prefix: 'jobcancel' },
    );
  });

  it('logs incomplete cleanup when a pre-canceled job finds a symlinked partial directory', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withWorkspace(async (cacheDirectory) => {
          const country = await db
            .insertInto('countries')
            .values({ source: 'geofabrik', source_id: 'europe/test', slug: 'test', name: 'Test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const job = await db
            .insertInto('jobs')
            .values({ type: 'download', payload: { countryId: country.id, version: '261023' } })
            .returningAll()
            .executeTakeFirstOrThrow();
          await db
            .insertInto('map_versions')
            .values({
              country_id: country.id,
              version: '261023',
              origin: 'geofabrik_snapshot',
              source_url: 'https://download.geofabrik.de/europe/test-261023.osm.pbf',
              source_filename: 'test-261023.osm.pbf',
              data_timestamp: null,
              file_size_bytes: 0n,
              checksum_md5: md5,
              checksum_sha256: null,
              storage_path: 'test/261023/test-261023.osm.pbf',
              status: 'pending',
              failure_reason: null,
              job_id: job.id,
              uploaded_by: null,
            })
            .execute();
          await db.insertInto('country_cache').values({ country_id: country.id }).execute();
          const partialDirectory = join(cacheDirectory, '.partial');
          const externalDirectory = join(cacheDirectory, 'external');
          await mkdir(externalDirectory, { recursive: true });
          const externalPartPath = join(externalDirectory, `${job.id}.part`);
          await writeFile(externalPartPath, payloadBytes.slice(0, 7));
          await symlink(externalDirectory, partialDirectory, 'dir');
          const partialPath = join(partialDirectory, `${job.id}.part`);
          const cleanupWarn = vi.fn();
          const controller = new AbortController();
          controller.abort(new Error('canceled before handler start'));
          const handler = createDownloadHandler({ source: source(), cacheDirectory });

          await expect(
            handler(job, {
              database: db,
              signal: controller.signal,
              reportProgress: () => Promise.resolve(),
              log: { info: vi.fn(), warn: cleanupWarn, error: vi.fn() },
            }),
          ).rejects.toThrow('canceled before handler start');
          await expect(stat(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(stat(externalPartPath)).resolves.toMatchObject({ size: 7 });
          expect(cleanupWarn).toHaveBeenCalledWith(
            { jobId: job.id, storagePath: `.partial/${job.id}.part` },
            'download partial download cleanup incomplete; orphan file may remain',
          );
          await expect(
            db
              .selectFrom('map_versions')
              .select(['status', 'failure_reason'])
              .where('job_id', '=', job.id)
              .executeTakeFirstOrThrow(),
          ).resolves.toEqual({ status: 'failed', failure_reason: 'CANCELED' });
        });
      },
      { migrate: true, prefix: 'jobprecancel' },
    );
  });

  it('cleans a partial file after a real writer reports ENOSPC', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        await withWorkspace(async (cacheDirectory) => {
          const country = await db
            .insertInto('countries')
            .values({ source: 'geofabrik', source_id: 'europe/test', slug: 'test', name: 'Test' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const job = await db
            .insertInto('jobs')
            .values({
              type: 'download',
              payload: { countryId: country.id, version: '261023' },
              max_attempts: 1,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const noSpace = Object.assign(new Error('simulated filesystem full'), { code: 'ENOSPC' });
          const handler = createDownloadHandler({
            source: source(),
            cacheDirectory,
            fetchImpl: () => Promise.resolve(bytesResponse(payloadBytes)),
            writeChunk: () => Promise.reject(noSpace),
          });
          const worker = startJobWorker(
            db,
            { download: handler },
            {
              concurrency: 1,
              pollIntervalMs: 5,
              heartbeatIntervalMs: 1_000,
              cancellationPollIntervalMs: 5,
              log,
            },
          );
          try {
            await waitForStatus(db, job.id, 'failed');
          } finally {
            await worker.stop();
          }
          expect(
            await db
              .selectFrom('map_versions')
              .select('failure_reason')
              .where('job_id', '=', job.id)
              .executeTakeFirst(),
          ).toEqual({ failure_reason: 'DISK_FULL' });
          await expect(
            stat(join(cacheDirectory, '.partial', `${job.id}.part`)),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(
            stat(join(cacheDirectory, 'test/261023/test-261023.osm.pbf')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        });
      },
      { migrate: true, prefix: 'jobdiskfull' },
    );
  });
});

async function waitForStatus(
  database: Parameters<typeof startJobWorker>[0],
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
  throw new Error(`Job ${jobId} did not reach ${expected} before the test deadline.`);
}

async function waitForFileSize(path: string, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).size >= expected) return;
    } catch {
      // The handler has not created the .part file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The partial file was not written before the test deadline.');
}
