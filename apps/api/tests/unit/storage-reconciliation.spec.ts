import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db/schema';
import type { Kysely } from 'kysely';

const mocks = vi.hoisted(() => ({
  sqlExecute: vi.fn(),
  transaction: vi.fn(),
  lockKey: vi.fn((countryId: string) => `lock:${countryId}`),
}));
vi.mock('kysely', () => ({ sql: () => ({ execute: mocks.sqlExecute, as: vi.fn() }) }));
vi.mock('../../src/db/repositories/cache', () => ({ cacheCountryAdvisoryLockKey: mocks.lockKey }));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.transaction }));

import { StoragePathError, type CacheStorage } from '../../src/modules/storage/storage';
import {
  reconcileMissingReadyVersions,
  STALE_PART_RETENTION_MS,
  sweepStalePartFiles,
} from '../../src/modules/system/storage-reconciliation';

const ACTIVE_JOB = '00000000-0000-4000-8000-000000000001';
const STALE_JOB = '00000000-0000-4000-8000-000000000002';
const FALSE_JOB = '00000000-0000-4000-8000-000000000003';
const ERROR_JOB = '00000000-0000-4000-8000-000000000004';
const COUNTRY_ID = '00000000-0000-4000-8000-000000000005';
const NOW = new Date('2026-11-01T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

function staleTime(): Date {
  return new Date(NOW.getTime() - STALE_PART_RETENTION_MS - 1);
}

function makeReconciliationSetup(options: {
  locked?: boolean;
  country?: { id: string } | null;
  readyVersions?: Array<{ id: string; storage_path: string }>;
  sizes?: Array<bigint | Error>;
  remaining?: { ready_count: string; total_size_bytes: string };
  cache?: { is_public: boolean; public_since: Date | null } | null;
  unlockError?: Error;
  unlock?: boolean;
}) {
  let sizeIndex = 0;
  let sqlCallIndex = 0;
  const country = options.country === null ? undefined : (options.country ?? { id: COUNTRY_ID });
  const readyVersions = options.readyVersions ?? [
    { id: '00000000-0000-4000-8000-000000000006', storage_path: 'finland/261101/one.pbf' },
    { id: '00000000-0000-4000-8000-000000000007', storage_path: 'finland/261101/two.pbf' },
  ];
  const remaining = options.remaining ?? { ready_count: '1', total_size_bytes: '100' };
  const cache =
    options.cache === null ? undefined : (options.cache ?? { is_public: true, public_since: NOW });
  const updateQuery = {
    set: vi.fn(() => updateQuery),
    where: vi.fn(() => updateQuery),
    execute: vi.fn(() => Promise.resolve()),
  };
  const trx = {
    selectFrom: vi.fn((table: string) => {
      let selection: unknown;
      const query = {
        select: vi.fn((value: unknown) => {
          selection = value;
          return query;
        }),
        where: vi.fn(() => query),
        forUpdate: vi.fn(() => query),
        executeTakeFirst: vi.fn(() =>
          Promise.resolve(
            table === 'countries' ? country : table === 'country_cache' ? cache : undefined,
          ),
        ),
        executeTakeFirstOrThrow: vi.fn(() => Promise.resolve(remaining)),
        execute: vi.fn(() =>
          Promise.resolve(
            table === 'map_versions' && selection === 'country_id' ? [] : readyVersions,
          ),
        ),
      };
      return query;
    }),
    updateTable: vi.fn(() => updateQuery),
  };
  const connection = {};
  const database = {
    selectFrom: vi.fn(() => ({
      select: vi.fn(() => ({
        where: vi.fn(() => ({
          execute: vi.fn(() => Promise.resolve([{ country_id: COUNTRY_ID }])),
        })),
      })),
    })),
    connection: vi.fn(() => ({
      execute: (callback: (connection: object) => Promise<number>) => callback(connection),
    })),
  };
  mocks.transaction.mockImplementation(
    (_connection: unknown, callback: (trx: unknown) => Promise<number>) => callback(trx),
  );
  mocks.sqlExecute.mockImplementation(() => {
    const currentCall = sqlCallIndex++;
    if (currentCall % 2 === 0) {
      return { rows: [{ locked: options.locked ?? true }] };
    }
    if (options.unlockError) throw options.unlockError;
    return { rows: [{ unlocked: options.unlock ?? true }] };
  });
  const size = vi.fn(() => {
    const configuredSize = options.sizes?.[sizeIndex];
    sizeIndex += 1;
    const result = configuredSize ?? (sizeIndex === 1 ? 0n : 10n);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  });
  const storage = {
    versionFileAt: vi.fn(() => ({ size })),
  } as unknown as CacheStorage;
  const log = { info: vi.fn(), warn: vi.fn() };
  return { database, trx, updateQuery, storage, size, log, readyVersions };
}

describe('reconcileMissingReadyVersions', () => {
  it('marks missing and unsafe files failed, refreshes cache metadata and releases the lock', async () => {
    const setup = makeReconciliationSetup({
      sizes: [0n, new StoragePathError('unsafe path')],
    });
    const outcome = await reconcileMissingReadyVersions(
      setup.database as unknown as Kysely<Database>,
      setup.storage,
      setup.log,
    );
    expect(outcome).toBe(2);
    expect(setup.trx.updateTable).toHaveBeenCalledWith('map_versions');
    expect(setup.trx.updateTable).toHaveBeenCalledWith('country_cache');
    expect(setup.log.info).toHaveBeenCalledWith(
      { reconciled: 2 },
      'ready cache versions with missing files marked failed',
    );
    expect(mocks.sqlExecute).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed or out-of-range summaries and tolerates a missing cache row', async () => {
    for (const remaining of [
      { ready_count: '-1', total_size_bytes: '100' },
      { ready_count: '2147483648', total_size_bytes: '100' },
      { ready_count: '0', total_size_bytes: '-1' },
    ]) {
      const invalidSummary = makeReconciliationSetup({ sizes: [0n], remaining });
      await expect(
        reconcileMissingReadyVersions(
          invalidSummary.database as unknown as Kysely<Database>,
          invalidSummary.storage,
          invalidSummary.log,
        ),
      ).resolves.toBe(0);
      expect(invalidSummary.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ countryId: COUNTRY_ID }),
        'could not reconcile ready cache files; will retry later',
      );
    }

    const missingCache = makeReconciliationSetup({ sizes: [0n], cache: null });
    await expect(
      reconcileMissingReadyVersions(
        missingCache.database as unknown as Kysely<Database>,
        missingCache.storage,
        missingCache.log,
      ),
    ).resolves.toBe(1);
    expect(missingCache.trx.updateTable).toHaveBeenCalledTimes(1);
  });

  it('skips busy locks, missing countries and present files without changing summaries', async () => {
    const busy = makeReconciliationSetup({ locked: false });
    await expect(
      reconcileMissingReadyVersions(
        busy.database as unknown as Kysely<Database>,
        busy.storage,
        busy.log,
      ),
    ).resolves.toBe(0);
    expect(busy.trx.updateTable).not.toHaveBeenCalled();

    const absentCountry = makeReconciliationSetup({ country: null });
    await expect(
      reconcileMissingReadyVersions(
        absentCountry.database as unknown as Kysely<Database>,
        absentCountry.storage,
        absentCountry.log,
      ),
    ).resolves.toBe(0);
    expect(absentCountry.size).not.toHaveBeenCalled();

    const present = makeReconciliationSetup({ sizes: [10n, 20n] });
    await expect(
      reconcileMissingReadyVersions(
        present.database as unknown as Kysely<Database>,
        present.storage,
        present.log,
      ),
    ).resolves.toBe(0);
    expect(present.trx.updateTable).not.toHaveBeenCalled();
  });

  it('keeps a country private after all ready files disappear and logs lock-release failures safely', async () => {
    const setup = makeReconciliationSetup({
      readyVersions: [
        { id: '00000000-0000-4000-8000-000000000006', storage_path: 'finland/261101/one.pbf' },
      ],
      sizes: [0n],
      remaining: { ready_count: '0', total_size_bytes: '0' },
      unlock: false,
    });
    await expect(
      reconcileMissingReadyVersions(
        setup.database as unknown as Kysely<Database>,
        setup.storage,
        setup.log,
      ),
    ).resolves.toBe(1);
    expect(setup.log.warn).toHaveBeenCalledWith(
      { countryId: COUNTRY_ID },
      'cache reconciliation advisory lock was not held at release',
    );
  });

  it('catches unexpected storage and lock-release failures and retries on the next pass', async () => {
    const unexpected = makeReconciliationSetup({ sizes: [new Error('disk fault')] });
    await expect(
      reconcileMissingReadyVersions(
        unexpected.database as unknown as Kysely<Database>,
        unexpected.storage,
        unexpected.log,
      ),
    ).resolves.toBe(0);
    expect(unexpected.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ countryId: COUNTRY_ID }),
      'could not reconcile ready cache files; will retry later',
    );

    const releaseFails = makeReconciliationSetup({
      sizes: [0n, 10n],
      unlockError: new Error('unlock'),
    });
    await expect(
      reconcileMissingReadyVersions(
        releaseFails.database as unknown as Kysely<Database>,
        releaseFails.storage,
        releaseFails.log,
      ),
    ).resolves.toBe(1);
    expect(releaseFails.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ countryId: COUNTRY_ID }),
      'could not release cache reconciliation lock',
    );
  });
});

describe('sweepStalePartFiles', () => {
  it('removes only stale unowned UUID part files and logs safe cleanup failures', async () => {
    const jobsQuery = {
      select: vi.fn(() => jobsQuery),
      where: vi.fn(() => jobsQuery),
      execute: vi.fn(() => Promise.resolve([{ id: ACTIVE_JOB }])),
    };
    const database = { selectFrom: vi.fn(() => jobsQuery) } as unknown as Kysely<Database>;
    const entries = [
      { kind: 'file', relativePath: `.partial/${STALE_JOB}.part`, modifiedAt: staleTime() },
      { kind: 'file', relativePath: `.partial/${ACTIVE_JOB}.part`, modifiedAt: staleTime() },
      { kind: 'file', relativePath: `.partial/${FALSE_JOB}.part`, modifiedAt: staleTime() },
      { kind: 'file', relativePath: `.partial/${ERROR_JOB}.part`, modifiedAt: staleTime() },
      { kind: 'file', relativePath: `.partial/${STALE_JOB}.part`, modifiedAt: NOW },
      { kind: 'directory', relativePath: `.partial/${STALE_JOB}.part`, modifiedAt: staleTime() },
      { kind: 'file', relativePath: '.partial/not-a-uuid.part', modifiedAt: staleTime() },
      {
        kind: 'file',
        relativePath: `.partial/${STALE_JOB}.part`,
        modifiedAt: new Date(Number.NaN),
      },
    ] as const;
    const remove = vi.fn((jobId: string) => {
      if (jobId === ERROR_JOB) return Promise.reject(new Error('filesystem unavailable'));
      return Promise.resolve(jobId === STALE_JOB);
    });
    const partFile = vi.fn((jobId: string) => ({ remove: () => remove(jobId) }));
    const storage = {
      listEntries: vi.fn(() => Promise.resolve([...entries])),
      partFile,
    } as unknown as CacheStorage;
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(sweepStalePartFiles(database, storage, log, NOW)).resolves.toBe(1);
    expect(partFile.mock.calls).toEqual([[STALE_JOB], [FALSE_JOB], [ERROR_JOB]]);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith({ removed: 1 }, 'stale cache part files removed');
  });

  it('does not emit a removal summary when nothing was removed', async () => {
    const query = {
      select: vi.fn(() => query),
      where: vi.fn(() => query),
      execute: vi.fn(() => Promise.resolve([])),
    };
    const database = { selectFrom: vi.fn(() => query) } as unknown as Kysely<Database>;
    const storage = {
      listEntries: vi.fn(() => Promise.resolve([])),
      partFile: vi.fn(),
    } as unknown as CacheStorage;
    const log = { info: vi.fn(), warn: vi.fn() };
    await expect(sweepStalePartFiles(database, storage, log, NOW)).resolves.toBe(0);
    expect(log.info).not.toHaveBeenCalled();
  });
});
