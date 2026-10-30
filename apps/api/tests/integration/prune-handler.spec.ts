import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { startJobWorker } from '../../src/modules/jobs/worker';
import { createPruneHandler } from '../../src/modules/jobs/prune-handler';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';
import { getGeofabrikPbfFixture } from '../helpers/geofabrik-fixture-server';

const skipReason = await freshDatabaseSkipReason();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const artifact = getGeofabrikPbfFixture();
const checksum = createHash('md5').update(artifact).digest('hex');

async function waitForPruneJob(database: Parameters<typeof startJobWorker>[0]): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await database
      .selectFrom('jobs')
      .select('id')
      .where('type', '=', 'prune')
      .executeTakeFirst();
    if (job !== undefined) return job.id;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The successful interval download did not enqueue a prune job.');
}

async function waitForStatus(
  database: Parameters<typeof startJobWorker>[0],
  jobId: string,
  expected: 'succeeded' | 'failed',
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

describe.skipIf(skipReason !== null)('PostgreSQL retention prune worker', () => {
  it('enqueues prune after an interval update and keeps the newest ready version', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'mapirror-prune-'));
    try {
      await withFreshDatabase(
        async ({ db }) => {
          const country = await db
            .insertInto('countries')
            .values({
              source: 'geofabrik',
              source_id: 'europe/finland',
              slug: 'finland',
              name: 'Finland',
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await db.insertInto('country_cache').values({ country_id: country.id }).execute();

          const olderAt = new Date('2026-10-16T20:00:00.000Z');
          const newerAt = new Date('2026-10-23T20:00:00.000Z');
          const olderPath = 'finland/261016/finland-261016.osm.pbf';
          const newerPath = 'finland/261023/finland-261023.osm.pbf';
          for (const storagePath of [olderPath, newerPath]) {
            const filePath = join(cacheDirectory, storagePath);
            await mkdir(join(filePath, '..'), { recursive: true });
            await writeFile(filePath, artifact);
          }
          const versions = await db
            .insertInto('map_versions')
            .values([
              {
                country_id: country.id,
                version: '261016',
                origin: 'geofabrik_snapshot',
                source_url: 'https://download.geofabrik.de/europe/finland-261016.osm.pbf',
                source_filename: 'finland-261016.osm.pbf',
                data_timestamp: olderAt,
                file_size_bytes: BigInt(artifact.byteLength),
                checksum_md5: checksum,
                checksum_sha256: null,
                storage_path: olderPath,
                status: 'ready',
                failure_reason: null,
                job_id: null,
                uploaded_by: null,
                ready_at: olderAt,
              },
              {
                country_id: country.id,
                version: '261023',
                origin: 'geofabrik_snapshot',
                source_url: 'https://download.geofabrik.de/europe/finland-261023.osm.pbf',
                source_filename: 'finland-261023.osm.pbf',
                data_timestamp: newerAt,
                file_size_bytes: BigInt(artifact.byteLength),
                checksum_md5: checksum,
                checksum_sha256: null,
                storage_path: newerPath,
                status: 'ready',
                failure_reason: null,
                job_id: null,
                uploaded_by: null,
                ready_at: newerAt,
              },
            ])
            .returning(['id', 'version'])
            .execute();
          const newest = versions.find(({ version }) => version === '261023');
          if (newest === undefined)
            throw new Error('The newest cached test version was not inserted.');

          const interval = await db
            .insertInto('intervals')
            .values({
              name: 'Finland retention',
              frequency: 'daily',
              next_run_at: newerAt,
              keep_versions: 1,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const run = await db
            .insertInto('interval_runs')
            .values({
              interval_id: interval.id,
              triggered_by: 'schedule',
              status: 'running',
              countries_total: 1,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const download = await db
            .insertInto('jobs')
            .values({
              type: 'download',
              payload: {
                countryId: country.id,
                version: 'latest',
                onlyIfChanged: true,
                keepVersions: 1,
              },
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await db
            .insertInto('interval_run_items')
            .values({
              run_id: run.id,
              country_id: country.id,
              country_slug: 'finland',
              country_name: 'Finland',
              job_id: download.id,
            })
            .execute();

          const worker = startJobWorker(
            db,
            {
              download: async (_job, context) => {
                await context.reportProgress({
                  progressBytes: BigInt(artifact.byteLength),
                  totalBytes: BigInt(artifact.byteLength),
                  phase: 'downloading',
                });
                return { versionId: newest.id, version: newest.version };
              },
              prune: createPruneHandler({ cacheDirectory }),
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

          let pruneJobId: string;
          try {
            pruneJobId = await waitForPruneJob(db);
            await waitForStatus(db, pruneJobId, 'succeeded');
          } finally {
            await worker.stop();
          }

          expect(
            await db
              .selectFrom('map_versions')
              .select('version')
              .where('country_id', '=', country.id)
              .where('status', '=', 'ready')
              .orderBy('ready_at', 'desc')
              .execute(),
          ).toEqual([{ version: '261023' }]);
          await expect(stat(join(cacheDirectory, olderPath))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(Uint8Array.from(await readFile(join(cacheDirectory, newerPath)))).toEqual(
            artifact,
          );
          expect(
            await db
              .selectFrom('country_cache')
              .select(['versions_ready_count', 'total_size_bytes'])
              .where('country_id', '=', country.id)
              .executeTakeFirstOrThrow(),
          ).toEqual({ versions_ready_count: 1, total_size_bytes: String(artifact.byteLength) });
          expect(
            await db
              .selectFrom('audit_logs')
              .select(['actor_name', 'action', 'target_id', 'metadata'])
              .where('action', '=', 'version.prune')
              .executeTakeFirstOrThrow(),
          ).toMatchObject({ actor_name: 'system', target_id: country.id });
          expect(
            await db
              .selectFrom('jobs')
              .select('result')
              .where('id', '=', pruneJobId)
              .executeTakeFirstOrThrow(),
          ).toMatchObject({ result: { keep: 1, pruned: 1, retained: 1 } });
          expect(
            await db
              .selectFrom('interval_runs')
              .select(['status', 'countries_ok', 'bytes_downloaded'])
              .where('id', '=', run.id)
              .executeTakeFirstOrThrow(),
          ).toEqual({
            status: 'succeeded',
            countries_ok: 1,
            bytes_downloaded: String(artifact.byteLength),
          });
        },
        { migrate: true, prefix: 'prunechain' },
      );
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it('does not enqueue retention after an unchanged interval skip', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const country = await db
          .insertInto('countries')
          .values({
            source: 'geofabrik',
            source_id: 'europe/finland',
            slug: 'finland',
            name: 'Finland',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const interval = await db
          .insertInto('intervals')
          .values({
            name: 'Skipped retention',
            frequency: 'daily',
            next_run_at: new Date(),
            keep_versions: 2,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const run = await db
          .insertInto('interval_runs')
          .values({ interval_id: interval.id, triggered_by: 'schedule', countries_total: 1 })
          .returning('id')
          .executeTakeFirstOrThrow();
        const download = await db
          .insertInto('jobs')
          .values({
            type: 'download',
            payload: {
              countryId: country.id,
              version: 'latest',
              onlyIfChanged: true,
              keepVersions: 2,
            },
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await db
          .insertInto('interval_run_items')
          .values({
            run_id: run.id,
            country_id: country.id,
            country_slug: 'finland',
            country_name: 'Finland',
            job_id: download.id,
          })
          .execute();
        const worker = startJobWorker(
          db,
          {
            download: () =>
              Promise.resolve({ version: 'latest@2026-10-30T00-00-00Z', skipReason: 'unchanged' }),
            prune: () => Promise.resolve({ pruned: 1 }),
          },
          {
            concurrency: 1,
            pollIntervalMs: 5,
            heartbeatIntervalMs: 1_000,
            cancellationPollIntervalMs: 5,
            log,
          },
        );
        try {
          await waitForStatus(db, download.id, 'succeeded');
        } finally {
          await worker.stop();
        }
        expect(
          await db.selectFrom('jobs').select('id').where('type', '=', 'prune').execute(),
        ).toEqual([]);
      },
      { migrate: true, prefix: 'pruneskip' },
    );
  });
});
