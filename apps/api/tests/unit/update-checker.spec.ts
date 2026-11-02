import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database } from '../../src/db/schema';
import type { SourceRegionDetail } from '../../src/modules/geofabrik/source';
import {
  createUpdateChecker,
  UpdateCheckNotCachedError,
} from '../../src/modules/updates/update-check';

const mocks = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_COUNTRY_ID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-01T12:00:00.000Z');

function detail(overrides: Partial<SourceRegionDetail> = {}): SourceRegionDetail {
  return {
    version: '261101',
    dataTimestamp: new Date('2026-11-01T11:00:00.000Z'),
    sizeBytes: 200,
    etag: 'etag',
    lastModified: new Date('2026-11-01T11:00:00.000Z'),
    ...overrides,
  };
}

function makeDatabase(
  options: {
    readonly identity?: { readonly source: string; readonly source_id: string };
    readonly cachePresent?: boolean;
    readonly versions?: readonly {
      readonly version: string;
      readonly data_timestamp: Date | null;
      readonly file_size_bytes: string;
    }[];
  } = {},
) {
  const identityQuery = {
    innerJoin: vi.fn(() => identityQuery),
    select: vi.fn(() => identityQuery),
    where: vi.fn(() => identityQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve(options.identity)),
  };
  const updateQuery = {
    set: vi.fn(() => updateQuery),
    where: vi.fn(() => updateQuery),
    execute: vi.fn(() => Promise.resolve()),
  };
  const cacheQuery = {
    select: vi.fn(() => cacheQuery),
    where: vi.fn(() => cacheQuery),
    forUpdate: vi.fn(() => cacheQuery),
    executeTakeFirst: vi.fn(() =>
      Promise.resolve(options.cachePresent === false ? undefined : { country_id: COUNTRY_ID }),
    ),
  };
  const versionsQuery = {
    select: vi.fn(() => versionsQuery),
    where: vi.fn(() => versionsQuery),
    orderBy: vi.fn(() => versionsQuery),
    execute: vi.fn(() => Promise.resolve([...(options.versions ?? [])])),
  };
  const trx = {
    selectFrom: vi.fn((table: string) => (table === 'country_cache' ? cacheQuery : versionsQuery)),
    updateTable: vi.fn(() => updateQuery),
  };
  const database = {
    selectFrom: vi.fn(() => identityQuery),
    updateTable: vi.fn(() => updateQuery),
  } as unknown as Kysely<Database>;
  mocks.withTransaction.mockImplementation(
    async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) => work(trx),
  );
  return { database, identityQuery, updateQuery, cacheQuery, versionsQuery };
}

beforeEach(() => vi.clearAllMocks());

describe('createUpdateChecker', () => {
  it('validates cache state, compares fresh source data, and reuses a detached region detail', async () => {
    const setup = makeDatabase({
      identity: { source: 'geofabrik', source_id: 'europe/finland' },
      versions: [
        {
          version: 'latest@2026-10-31T10-00-00Z',
          data_timestamp: new Date('2026-10-31T10:00:00Z'),
          file_size_bytes: '100',
        },
      ],
    });
    const sourceDetail = detail();
    const getRegionDetail = vi.fn(() => Promise.resolve(sourceDetail));
    const checker = createUpdateChecker({
      database: setup.database,
      source: { id: 'geofabrik' as const, getRegionDetail },
      now: () => new Date(NOW),
    });

    const first = await checker.check(COUNTRY_ID);
    const second = await checker.check(OTHER_COUNTRY_ID);
    expect(first.state).toBe('update_available');
    expect(first.source).toEqual({
      version: '261101',
      dataTimestamp: sourceDetail.dataTimestamp,
      sizeBytes: 200,
    });
    expect(first.cached.version).toBe('latest@2026-10-31T10-00-00Z');
    expect(first.checkedAt).toEqual(NOW);
    expect(second.state).toBe('update_available');
    expect(getRegionDetail).toHaveBeenCalledOnce();
    expect(setup.updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({ update_state: 'update_available' }),
    );

    sourceDetail.dataTimestamp!.setUTCFullYear(2020);
    expect(first.source?.dataTimestamp).toEqual(new Date('2026-11-01T11:00:00.000Z'));
  });

  it('fails closed for missing cache rows and mismatched or unavailable sources', async () => {
    const absent = makeDatabase();
    const unusedSource = { id: 'geofabrik' as const, getRegionDetail: vi.fn() };
    const absentChecker = createUpdateChecker({ database: absent.database, source: unusedSource });
    await expect(absentChecker.check(COUNTRY_ID)).rejects.toBeInstanceOf(UpdateCheckNotCachedError);
    expect(unusedSource.getRegionDetail).not.toHaveBeenCalled();

    const mismatch = makeDatabase({ identity: { source: 'other', source_id: 'region' } });
    const log = { warn: vi.fn() };
    const mismatchChecker = createUpdateChecker({
      database: mismatch.database,
      source: { id: 'geofabrik' as const, getRegionDetail: vi.fn() },
      now: () => new Date(NOW),
      log,
    });
    await expect(mismatchChecker.check(COUNTRY_ID)).resolves.toMatchObject({
      state: 'unknown',
      source: null,
      reason: 'The map source could not be checked.',
    });
    expect(log.warn).toHaveBeenCalledOnce();

    const failed = makeDatabase({ identity: { source: 'geofabrik', source_id: 'region' } });
    const failingSource = vi.fn(() => Promise.reject(new Error('private provider details')));
    const failedChecker = createUpdateChecker({
      database: failed.database,
      source: { id: 'geofabrik' as const, getRegionDetail: failingSource },
      now: () => new Date(NOW),
      log,
    });
    await expect(failedChecker.check(COUNTRY_ID)).resolves.toMatchObject({
      state: 'unknown',
      source: null,
    });
    expect(log.warn).toHaveBeenLastCalledWith(
      { countryId: COUNTRY_ID, sourceErrorName: 'Error' },
      'Update check could not read source details',
    );
  });

  it('persists unknown for absent cached versions and sanitizes malformed upstream facts', async () => {
    const setup = makeDatabase({
      identity: { source: 'geofabrik', source_id: 'region' },
      versions: [],
    });
    const checker = createUpdateChecker({
      database: setup.database,
      source: {
        id: 'geofabrik' as const,
        getRegionDetail: vi.fn(() =>
          Promise.resolve(
            detail({
              version: 'latest',
              dataTimestamp: new Date(Number.NaN),
              sizeBytes: -1,
            }),
          ),
        ),
      },
      now: () => new Date(NOW),
    });
    await expect(checker.check(COUNTRY_ID)).resolves.toMatchObject({
      state: 'unknown',
      reason: 'The map source returned incomplete version details.',
      source: { version: null, dataTimestamp: null, sizeBytes: null },
      cached: { version: null, dataTimestamp: null, sizeBytes: null },
    });
  });

  it('expires source details after the bounded TTL', async () => {
    const setup = makeDatabase({ identity: { source: 'geofabrik', source_id: 'region' } });
    let clock = NOW.getTime();
    const getRegionDetail = vi.fn(() => Promise.resolve(detail()));
    const checker = createUpdateChecker({
      database: setup.database,
      source: { id: 'geofabrik', getRegionDetail },
      sourceDetailTtlMs: 1,
      now: () => new Date(clock),
    });
    await checker.check(COUNTRY_ID);
    clock += 2;
    await checker.check(OTHER_COUNTRY_ID);
    expect(getRegionDetail).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid TTL or clocks and rechecks a cache row removed before persistence', async () => {
    const setup = makeDatabase({
      identity: { source: 'geofabrik', source_id: 'region' },
      cachePresent: false,
    });
    const source = {
      id: 'geofabrik' as const,
      getRegionDetail: vi.fn(() => Promise.resolve(detail())),
    };
    expect(() =>
      createUpdateChecker({ database: setup.database, source, sourceDetailTtlMs: 0 }),
    ).toThrow(RangeError);
    const checker = createUpdateChecker({
      database: setup.database,
      source,
      now: () => new Date(Number.NaN),
    });
    await expect(checker.check(COUNTRY_ID)).rejects.toThrow(
      'update-check clock returned an invalid date',
    );

    const validClockChecker = createUpdateChecker({
      database: setup.database,
      source,
      now: () => new Date(NOW),
    });
    await expect(validClockChecker.check(COUNTRY_ID)).rejects.toBeInstanceOf(
      UpdateCheckNotCachedError,
    );
  });
});
