import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database, Job } from '../../src/db/schema';
import { createPruneHandler } from '../../src/modules/jobs/prune-handler';
import type { JobHandlerContext } from '../../src/modules/jobs/worker';
import type { CacheStorage } from '../../src/modules/storage/storage';

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  listActiveCountryJobs: vi.fn(),
  insertAuditLog: vi.fn(),
  withCacheCountryMutationLock: vi.fn(),
}));

vi.mock('kysely', () => ({
  sql: Object.assign(() => ({ as: () => ({}) }), { val: (value: unknown) => value }),
}));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/db/repositories/cache', () => ({
  listActiveCountryJobs: mocks.listActiveCountryJobs,
}));
vi.mock('../../src/db/repositories/audit-logs', () => ({
  AUDIT_ACTIONS: { versionPrune: 'version.prune' },
  insertAuditLog: mocks.insertAuditLog,
}));
vi.mock('../../src/modules/admin/cache-mutation-lock', () => ({
  withCacheCountryMutationLock: mocks.withCacheCountryMutationLock,
}));

const COUNTRY_ID = '00000000-0000-4000-8000-000000000002';
const JOB_ID = '00000000-0000-4000-8000-000000000001';

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date('2026-11-01T12:00:00.000Z');
  return {
    id: JOB_ID,
    type: 'prune',
    status: 'running',
    priority: 0,
    payload: { countryId: COUNTRY_ID, keep: 1 },
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
    total_bytes: null,
    speed_bps: null,
    phase: null,
    error_code: null,
    error_message: null,
    ...overrides,
  };
}

function makeContext(signal = new AbortController().signal): JobHandlerContext {
  return {
    database: {} as Kysely<Database>,
    signal,
    reportProgress: vi.fn(() => Promise.resolve()),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

type Version = {
  id: string;
  version: string;
  file_size_bytes: string;
  storage_path: string;
  ready_at: Date | null;
};

function makeVersion(id: string, size = '10', readyAt: Date | null = new Date()): Version {
  return {
    id,
    version: `2026110${id}`,
    file_size_bytes: size,
    storage_path: `finland/${id}.osm.pbf`,
    ready_at: readyAt,
  };
}

function makeTransaction(
  phase: 'snapshot' | 'commit',
  versions: Version[],
  current: Version[] = [],
) {
  let selectingTotals = false;
  const updateQuery = {
    set: vi.fn(() => updateQuery),
    where: vi.fn(() => updateQuery),
    execute: vi.fn(() => Promise.resolve()),
  };
  const deleteQuery = {
    where: vi.fn(() => deleteQuery),
    execute: vi.fn(() => Promise.resolve()),
  };
  const trx = {
    selectFrom: vi.fn((table: string) => {
      const query = {
        select: vi.fn((columns: unknown) => {
          selectingTotals = Array.isArray(columns) && typeof columns[0] !== 'string';
          return query;
        }),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        forUpdate: vi.fn(() => query),
        executeTakeFirst: vi.fn(() =>
          Promise.resolve(
            table === 'countries'
              ? { id: COUNTRY_ID, slug: 'finland' }
              : table === 'country_cache'
                ? { is_public: true, public_since: new Date('2026-01-01T00:00:00Z') }
                : undefined,
          ),
        ),
        execute: vi.fn(() => Promise.resolve(phase === 'snapshot' ? versions : current)),
        executeTakeFirstOrThrow: vi.fn(() =>
          Promise.resolve(
            selectingTotals
              ? { ready_count: 1, total_size_bytes: '10' }
              : { versions_ready_count: 1, total_size_bytes: '10' },
          ),
        ),
      };
      return query;
    }),
    updateTable: vi.fn(() => updateQuery),
    deleteFrom: vi.fn(() => deleteQuery),
  };
  return { trx, updateQuery, deleteQuery };
}

function makeStorage(sizes: Record<string, bigint>, removeResults: Record<string, boolean> = {}) {
  const files = new Map<string, ReturnType<typeof makeFile>>();
  const versionFileAt = vi.fn((path: string) => {
    let entry = files.get(path);
    if (!entry) {
      entry = makeFile(path, sizes[path] ?? 10n, removeResults[path] ?? true);
      files.set(path, entry);
    }
    return entry.file;
  });
  return { storage: { versionFileAt } as unknown as CacheStorage, versionFileAt, files };
}

function makeFile(path: string, actualSize: bigint, removeResult: boolean) {
  const file = {
    relativePath: path,
    size: vi.fn(() => Promise.resolve(actualSize)),
    remove: vi.fn(() => Promise.resolve(removeResult)),
  };
  return { file };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withCacheCountryMutationLock.mockImplementation(
    async (
      _database: unknown,
      _countryId: string,
      _logger: unknown,
      work: () => Promise<unknown>,
    ) => work(),
  );
  mocks.listActiveCountryJobs.mockResolvedValue([]);
  mocks.insertAuditLog.mockResolvedValue(undefined);
});

describe('prune handler', () => {
  it('rejects wrong job types, invalid payloads and cancellation before taking the lock', async () => {
    const handler = createPruneHandler({ cacheDirectory: '/unused' });
    await expect(handler(makeJob({ type: 'download' }), makeContext())).rejects.toThrow(
      'prune handler received a non-prune job',
    );
    await expect(
      handler(makeJob({ payload: { countryId: 'bad', keep: 0 } }), makeContext()),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(handler(makeJob(), makeContext(controller.signal))).rejects.toThrow();
    expect(mocks.withCacheCountryMutationLock).not.toHaveBeenCalled();
  });

  it('returns zero when the country disappeared and refuses to prune during an active import', async () => {
    const missing = makeTransaction('snapshot', []);
    missing.trx.selectFrom.mockImplementation((_table: string) => {
      const query = {
        select: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        forUpdate: vi.fn(() => query),
        executeTakeFirst: vi.fn(() => Promise.resolve(undefined)),
        execute: vi.fn(() => Promise.resolve([])),
        executeTakeFirstOrThrow: vi.fn(),
      };
      return query;
    });
    mocks.withTransaction.mockImplementationOnce(
      async (_db: unknown, work: (trx: unknown) => Promise<unknown>) => work(missing.trx),
    );
    const handler = createPruneHandler({ cacheDirectory: '/unused' });
    await expect(handler(makeJob(), makeContext())).resolves.toEqual({
      countryId: COUNTRY_ID,
      keep: 1,
      retained: 0,
      pruned: 0,
    });

    const snapshot = makeTransaction('snapshot', [makeVersion('1'), makeVersion('2')]);
    mocks.withTransaction.mockImplementationOnce(
      async (_db: unknown, work: (trx: unknown) => Promise<unknown>) => work(snapshot.trx),
    );
    mocks.listActiveCountryJobs.mockResolvedValueOnce([{ id: 'other-job', type: 'import' }]);
    await expect(handler(makeJob(), makeContext())).rejects.toThrow(
      'A download or import is active for this country; retention will retry later.',
    );
  });

  it('prunes only valid excess artifacts, refreshes the cache summary and audits the deletion', async () => {
    const versions = [
      makeVersion('1'),
      makeVersion('2'),
      makeVersion('3'),
      makeVersion('4', '10', null),
      makeVersion('5', '10'),
    ];
    const deletable = [versions[1]!, versions[2]!];
    const snapshot = makeTransaction('snapshot', versions);
    const commit = makeTransaction('commit', [], deletable);
    mocks.withTransaction
      .mockImplementationOnce(async (_db: unknown, work: (trx: unknown) => Promise<unknown>) =>
        work(snapshot.trx),
      )
      .mockImplementationOnce(async (_db: unknown, work: (trx: unknown) => Promise<unknown>) =>
        work(commit.trx),
      );
    mocks.listActiveCountryJobs.mockResolvedValue([]);
    const storage = makeStorage(
      {
        [versions[0]!.storage_path]: 10n,
        [versions[1]!.storage_path]: 10n,
        [versions[2]!.storage_path]: 10n,
        [versions[4]!.storage_path]: 0n,
      },
      { [versions[1]!.storage_path]: false },
    );
    const handler = createPruneHandler({
      cacheDirectory: '/unused',
      cacheStorage: storage.storage,
    });

    await expect(handler(makeJob(), makeContext())).resolves.toEqual({
      countryId: COUNTRY_ID,
      keep: 1,
      retained: 1,
      pruned: 2,
    });
    expect(commit.deleteQuery.execute).toHaveBeenCalledOnce();
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'version.prune',
        targetId: COUNTRY_ID,
      }),
    );
    expect(commit.updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        versions_ready_count: 1,
        total_size_bytes: '10',
        update_state: 'unknown',
      }),
    );
    expect(storage.files.get(versions[1]!.storage_path)?.file.remove).toHaveBeenCalledOnce();
  });
});
