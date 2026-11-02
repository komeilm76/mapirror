import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database, Job } from '../../src/db/schema';
import { createDownloadHandler } from '../../src/modules/jobs/download-handler';
import type { MapSource, ResolvedDownload } from '../../src/modules/geofabrik/source';
import type { JobHandlerContext } from '../../src/modules/jobs/worker';
import type { CacheStorage, StorageFile } from '../../src/modules/storage/storage';

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  hashFile: vi.fn(),
  streamDownloadToPart: vi.fn(),
  writeAll: vi.fn(),
  createCacheStorage: vi.fn(),
  fetchGeofabrikMd5: vi.fn(),
}));

vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/lib/download', () => ({
  hashFile: mocks.hashFile,
  streamDownloadToPart: mocks.streamDownloadToPart,
  writeAll: mocks.writeAll,
}));
vi.mock('../../src/modules/storage/storage', () => ({
  createCacheStorage: mocks.createCacheStorage,
}));
vi.mock('../../src/modules/geofabrik/file-metadata', () => ({
  fetchGeofabrikMd5: mocks.fetchGeofabrikMd5,
}));

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const COUNTRY_ID = '00000000-0000-4000-8000-000000000002';
const PAYLOAD = Buffer.from('osm-pbf-data');
const MD5 = createHash('md5').update(PAYLOAD).digest('hex');
const RESOLVED: ResolvedDownload = {
  version: '261101',
  url: 'https://download.geofabrik.de/europe/finland-261101.osm.pbf',
  sizeBytes: PAYLOAD.length,
  dataTimestamp: new Date('2026-11-01T12:00:00.000Z'),
  checksumMd5: MD5,
  etag: '"snapshot"',
  lastModified: null,
};

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date('2026-11-01T12:00:00.000Z');
  return {
    id: JOB_ID,
    type: 'download',
    status: 'running',
    priority: 0,
    payload: { countryId: COUNTRY_ID, version: '261101' },
    result: null,
    created_by: null,
    created_at: now,
    run_after: now,
    started_at: now,
    finished_at: null,
    locked_by: 'worker-1',
    locked_at: now,
    cancel_requested: false,
    attempts: 1,
    max_attempts: 3,
    progress_bytes: '0',
    total_bytes: String(PAYLOAD.length),
    speed_bps: null,
    phase: null,
    error_code: null,
    error_message: null,
    ...overrides,
  };
}

function makeFile(relativePath: string) {
  const remove = vi.fn(() => Promise.resolve(true));
  const file: StorageFile = {
    relativePath,
    ensureParent: vi.fn(() => Promise.resolve()),
    size: vi.fn(() => Promise.resolve(BigInt(PAYLOAD.length))),
    open: vi.fn(),
    remove,
  };
  return { ...file, remove };
}

function makeDatabase(
  country: { id: string; slug: string; source_id: string } | null = {
    id: COUNTRY_ID,
    slug: 'finland',
    source_id: 'europe/finland',
  },
) {
  const countryQuery = {
    select: vi.fn(() => countryQuery),
    where: vi.fn(() => countryQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve(country ?? undefined)),
  };
  const versionQuery = {
    select: vi.fn(() => versionQuery),
    where: vi.fn(() => versionQuery),
    orderBy: vi.fn(() => versionQuery),
    limit: vi.fn(() => versionQuery),
    forUpdate: vi.fn(() => versionQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve(undefined)),
  };
  const updateQuery = {
    set: vi.fn((_values: unknown) => updateQuery),
    where: vi.fn(() => updateQuery),
    returning: vi.fn(() => updateQuery),
    execute: vi.fn(() => Promise.resolve()),
    executeTakeFirst: vi.fn(() => Promise.resolve({ id: 'version-row-id' })),
  };
  const insertQuery = {
    values: vi.fn(() => insertQuery),
    onConflict: vi.fn(
      (callback: (conflict: { column: (name: string) => { doNothing: () => void } }) => void) => {
        callback({ column: () => ({ doNothing: () => undefined }) });
        return insertQuery;
      },
    ),
    execute: vi.fn(() => Promise.resolve()),
  };
  const transaction = {
    selectFrom: vi.fn((table: string) => (table === 'countries' ? countryQuery : versionQuery)),
    updateTable: vi.fn(() => updateQuery),
    insertInto: vi.fn(() => insertQuery),
  };
  const updateTable = vi.fn((_table: string) => updateQuery);
  const database = {
    selectFrom: vi.fn(() => countryQuery),
    updateTable,
  } as unknown as Kysely<Database>;
  mocks.withTransaction.mockImplementation(
    async (_database: unknown, work: (trx: unknown) => Promise<unknown>) => work(transaction),
  );
  return {
    database,
    countryQuery,
    versionQuery,
    updateQuery,
    updateTable,
    insertQuery,
    transaction,
  };
}

function makeDownloadFlow() {
  const setup = makeDatabase();
  const partFile = makeFile(`.partial/${JOB_ID}.part`);
  const storageFile = makeFile('finland/261101/finland-261101.osm.pbf');
  const storage = {
    partFile: vi.fn(() => partFile),
    versionFile: vi.fn(() => storageFile),
    versionFileAt: vi.fn(() => storageFile),
    installPart: vi.fn(() => Promise.resolve()),
  } as unknown as CacheStorage;
  mocks.createCacheStorage.mockReturnValue(storage);
  const handler = createDownloadHandler({ source: makeSource(), cacheDirectory: '/unused' });
  const context = {
    database: setup.database,
    signal: new AbortController().signal,
    reportProgress: vi.fn(() => Promise.resolve()),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as JobHandlerContext;
  return { setup, partFile, storageFile, storage, handler, context };
}

function makeSource(
  resolved: ResolvedDownload = RESOLVED,
): MapSource & { readonly resolveDownload: ReturnType<typeof vi.fn> } {
  return {
    id: 'geofabrik',
    listRegions: vi.fn(() => Promise.resolve([])),
    getRegionDetail: vi.fn(() => Promise.reject(new Error('not used'))),
    listSnapshots: vi.fn(() => Promise.resolve([])),
    resolveDownload: vi.fn(() => Promise.resolve(resolved)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.streamDownloadToPart.mockResolvedValue(undefined);
  mocks.hashFile.mockResolvedValue({ checksum: MD5, size: BigInt(PAYLOAD.length) });
});

describe('download handler', () => {
  it('streams, verifies, installs and finalizes a dated source snapshot', async () => {
    const setup = makeDatabase();
    const partFile = makeFile(`.partial/${JOB_ID}.part`);
    const storageFile = makeFile('finland/261101/finland-261101.osm.pbf');
    const installPart = vi.fn(() => Promise.resolve());
    const cacheStorage = {
      partFile: vi.fn(() => partFile),
      versionFile: vi.fn(() => storageFile),
      versionFileAt: vi.fn(() => storageFile),
      installPart,
    } as unknown as CacheStorage;
    mocks.createCacheStorage.mockReturnValue(cacheStorage);
    const source = makeSource();
    const reportProgress = vi.fn(() => Promise.resolve());
    const handler = createDownloadHandler({ source, cacheDirectory: '/unused' });
    const context = {
      database: setup.database,
      signal: new AbortController().signal,
      reportProgress,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as JobHandlerContext;

    await expect(handler(makeJob(), context)).resolves.toEqual({
      versionId: 'version-row-id',
      version: '261101',
    });
    expect(source.resolveDownload.mock.calls[0]).toEqual([
      'europe/finland',
      '261101',
      context.signal,
    ]);
    expect(setup.insertQuery.values).toHaveBeenCalledWith(
      expect.objectContaining({
        country_id: COUNTRY_ID,
        version: '261101',
        status: 'pending',
        checksum_md5: MD5,
      }),
    );
    expect(mocks.streamDownloadToPart).toHaveBeenCalledWith(
      expect.objectContaining({
        url: RESOLVED.url,
        expectedSize: BigInt(PAYLOAD.length),
        mutable: false,
        validator: '"snapshot"',
      }),
    );
    expect(mocks.hashFile).toHaveBeenCalledWith(partFile, context.signal);
    expect(installPart.mock.calls[0]).toEqual([partFile, storageFile]);
    expect(setup.updateQuery.set.mock.calls.map(([values]) => values)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'ready', checksum_md5: MD5 })]),
    );
    expect(reportProgress).toHaveBeenCalledTimes(3);
  });

  it('cleans a partial artifact and records an integrity failure when downloaded bytes do not match', async () => {
    const flow = makeDownloadFlow();
    mocks.hashFile.mockResolvedValue({ checksum: '0'.repeat(32), size: BigInt(PAYLOAD.length) });
    await expect(flow.handler(makeJob(), flow.context)).rejects.toMatchObject({
      name: 'DownloadHandlerError',
      code: 'DOWNLOAD_CHECKSUM_MISMATCH',
    });
    expect(flow.partFile.remove.mock.calls).toHaveLength(1);
    expect(flow.storageFile.remove.mock.calls).toHaveLength(0);
    expect(flow.setup.updateTable.mock.calls[0]?.[0]).toBe('map_versions');
    expect(flow.setup.updateQuery.set.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'failed',
      failure_reason: 'DOWNLOAD_CHECKSUM_MISMATCH',
    });
  });

  it('cleans up and translates disk-full errors to a safe storage failure', async () => {
    const flow = makeDownloadFlow();
    mocks.streamDownloadToPart.mockRejectedValue(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    );
    await expect(flow.handler(makeJob(), flow.context)).rejects.toMatchObject({
      name: 'DownloadHandlerError',
      code: 'DOWNLOAD_STORAGE_FAILED',
      message: 'The cache filesystem could not store the download.',
    });
    expect(flow.partFile.remove.mock.calls).toHaveLength(1);
    expect(flow.setup.updateQuery.set.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'failed',
      failure_reason: 'DISK_FULL',
    });
  });

  it('rejects unsafe source identities before reserving a version slot', async () => {
    const invalidSources = [
      { ...RESOLVED, url: 'ftp://download.example/finland.osm.pbf' },
      { ...RESOLVED, url: 'https://download.example/finland%2Fescape.osm.pbf' },
      { ...RESOLVED, version: '261102' },
      { ...RESOLVED, sizeBytes: -1 },
      { ...RESOLVED, checksumMd5: 'not-an-md5' },
    ];
    for (const resolved of invalidSources) {
      const setup = makeDatabase();
      const storage = { partFile: vi.fn(), versionFile: vi.fn() };
      mocks.createCacheStorage.mockReturnValue(storage);
      const handler = createDownloadHandler({
        source: makeSource(resolved),
        cacheDirectory: '/unused',
      });
      const context = {
        database: setup.database,
        signal: new AbortController().signal,
        reportProgress: vi.fn(() => Promise.resolve()),
      } as unknown as JobHandlerContext;
      await expect(handler(makeJob(), context)).rejects.toThrow();
      expect(mocks.withTransaction).not.toHaveBeenCalled();
    }
    expect(mocks.fetchGeofabrikMd5).not.toHaveBeenCalled();
  });

  it('removes the partial file and marks the pending row canceled when cancellation precedes setup', async () => {
    const setup = makeDatabase();
    const partFile = makeFile(`.partial/${JOB_ID}.part`);
    const partFileForJob = vi.fn((_jobId: string) => partFile);
    const storage = { partFile: partFileForJob, versionFile: vi.fn() };
    mocks.createCacheStorage.mockReturnValue(storage);
    const controller = new AbortController();
    controller.abort();
    const handler = createDownloadHandler({ source: makeSource(), cacheDirectory: '/unused' });
    const context = {
      database: setup.database,
      signal: controller.signal,
      reportProgress: vi.fn(() => Promise.resolve()),
    } as unknown as JobHandlerContext;

    await expect(handler(makeJob(), context)).rejects.toThrow();
    expect(partFileForJob.mock.calls[0]?.[0]).toBe(JOB_ID);
    expect(partFile.remove.mock.calls).toHaveLength(1);
    expect(setup.updateQuery.set.mock.calls.at(-1)?.[0]).toEqual({
      status: 'failed',
      failure_reason: 'CANCELED',
      ready_at: null,
    });
  });

  it('rejects malformed job inputs and handles missing countries before source access', async () => {
    const setup = makeDatabase(null);
    mocks.createCacheStorage.mockReturnValue({ partFile: vi.fn(), versionFile: vi.fn() });
    const source = makeSource();
    const handler = createDownloadHandler({ source, cacheDirectory: '/unused' });
    const context = {
      database: setup.database,
      signal: new AbortController().signal,
      reportProgress: vi.fn(() => Promise.resolve()),
    } as unknown as JobHandlerContext;

    await expect(handler(makeJob({ type: 'import' }), context)).rejects.toThrow(
      'download handler received a non-download job',
    );
    await expect(
      handler(makeJob({ payload: { countryId: 'invalid', version: '' } }), context),
    ).rejects.toThrow();
    await expect(handler(makeJob(), context)).rejects.toThrow('download country no longer exists');
    expect(source.resolveDownload.mock.calls).toHaveLength(0);
  });
});
