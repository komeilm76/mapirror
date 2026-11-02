import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database, Job } from '../../src/db/schema';
import {
  createCatalogSyncHandler,
  isCatalogSyncDue,
} from '../../src/modules/jobs/catalog-sync-handler';
import type { CatalogIndexSource } from '../../src/modules/geofabrik/source';
import type { JobHandlerContext } from '../../src/modules/jobs/worker';

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  insertAuditLog: vi.fn(),
  upsertCatalogCountry: vi.fn(),
  sqlExecute: vi.fn(),
}));

vi.mock('kysely', () => ({ sql: () => ({ execute: mocks.sqlExecute }) }));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/db/repositories/audit-logs', () => ({
  AUDIT_ACTIONS: { catalogSync: 'catalog.sync' },
  insertAuditLog: mocks.insertAuditLog,
}));
vi.mock('../../src/db/repositories/catalog', () => ({
  CATALOG_SYNCED_AT_SETTING: 'source.catalogSyncedAt',
  upsertCatalogCountry: mocks.upsertCatalogCountry,
}));

const REGIONS = [
  {
    id: 'europe/germany',
    parentId: 'europe',
    name: 'Germany',
    isoAlpha2: ['DE'],
    isoOther: [],
    pbfUrl: 'https://source.example/germany.pbf',
  },
  {
    id: 'europe/finland',
    parentId: 'europe',
    name: 'Finland',
    isoAlpha2: ['FI'],
    isoOther: [],
    pbfUrl: 'https://source.example/finland.pbf',
  },
];
const SYNCED_AT = new Date('2026-11-01T12:00:00.000Z');

function makeTransaction(existing: { source_id: string; slug: string }[] = [], creator?: string) {
  const countriesQuery = {
    select: vi.fn(() => countriesQuery),
    where: vi.fn(() => countriesQuery),
    execute: vi.fn(() => Promise.resolve(existing)),
  };
  const adminQuery = {
    select: vi.fn(() => adminQuery),
    where: vi.fn(() => adminQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve(creator ? { username: creator } : undefined)),
  };
  const selectFrom = vi.fn((table: string) =>
    table === 'countries' ? countriesQuery : adminQuery,
  );
  const conflict = {
    column: vi.fn(() => conflict),
    doUpdateSet: vi.fn(() => conflict),
  };
  const settingsInsert = {
    values: vi.fn(() => settingsInsert),
    onConflict: vi.fn((callback: (builder: typeof conflict) => unknown) => {
      callback(conflict);
      return settingsInsert;
    }),
    execute: vi.fn(() => Promise.resolve()),
  };
  const trx = {
    selectFrom,
    insertInto: vi.fn(() => settingsInsert),
  };
  return { trx, countriesQuery, adminQuery, settingsInsert, conflict };
}

function makeSource(listRegions = vi.fn(() => Promise.resolve(REGIONS))): CatalogIndexSource {
  return { id: 'geofabrik', listRegions };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-id',
    type: 'catalog_sync',
    status: 'running',
    priority: 0,
    payload: {},
    result: null,
    created_by: null,
    created_at: SYNCED_AT,
    run_after: SYNCED_AT,
    started_at: SYNCED_AT,
    finished_at: null,
    locked_by: 'worker-1',
    locked_at: SYNCED_AT,
    cancel_requested: false,
    attempts: 1,
    max_attempts: 4,
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
    reportProgress: vi.fn(() => Promise.resolve(undefined)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const { trx } = makeTransaction();
  mocks.withTransaction.mockImplementation(
    async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) => work(trx),
  );
  mocks.sqlExecute.mockResolvedValue({ rows: [{ acquired: true }] });
  mocks.upsertCatalogCountry.mockResolvedValue(undefined);
  mocks.insertAuditLog.mockResolvedValue(undefined);
});

describe('catalog sync job handler', () => {
  it('sorts source records, keeps assigned slugs, upserts the catalog and audits the transaction', async () => {
    const listRegions = vi.fn(() => Promise.resolve(REGIONS));
    const source = makeSource(listRegions);
    const tx = makeTransaction([{ source_id: 'europe/finland', slug: 'finland-custom' }]);
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) => work(tx.trx),
    );
    const handler = createCatalogSyncHandler({ source, now: () => SYNCED_AT });

    await expect(handler(makeJob(), makeContext())).resolves.toEqual({
      source: 'geofabrik',
      syncedCount: 2,
    });

    expect(listRegions).toHaveBeenCalledTimes(1);
    expect(mocks.sqlExecute).toHaveBeenCalledTimes(1);
    expect(
      mocks.upsertCatalogCountry.mock.calls.map(
        ([, row]) => (row as { sourceId: string }).sourceId,
      ),
    ).toEqual(['europe/finland', 'europe/germany']);
    expect(mocks.upsertCatalogCountry).toHaveBeenCalledWith(
      tx.trx,
      expect.objectContaining({ sourceId: 'europe/finland', slug: 'finland-custom' }),
      SYNCED_AT,
    );
    expect(tx.settingsInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'source.catalogSyncedAt',
        value: JSON.stringify(SYNCED_AT.toISOString()),
        updated_at: SYNCED_AT,
      }),
    );
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      tx.trx,
      expect.objectContaining({
        actorId: null,
        actorName: 'system',
        action: 'catalog.sync',
        metadata: {
          source: 'geofabrik',
          regionCount: 2,
          slugResolutions: [{ sourceId: 'europe/finland', slug: 'finland-custom' }],
        },
      }),
    );
  });

  it('attributes a manual catalog sync to its creator', async () => {
    const tx = makeTransaction([], 'operator');
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) => work(tx.trx),
    );
    const handler = createCatalogSyncHandler({ source: makeSource(), now: () => SYNCED_AT });

    await handler(makeJob({ created_by: 'admin-id' }), makeContext());

    expect(tx.trx.selectFrom).toHaveBeenCalledWith('admins');
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      tx.trx,
      expect.objectContaining({ actorId: 'admin-id', actorName: 'operator' }),
    );
  });

  it('rejects invalid jobs, source mismatch, and a pre-canceled worker before opening a transaction', async () => {
    const listRegions = vi.fn(() => Promise.resolve(REGIONS));
    const handler = createCatalogSyncHandler({ source: makeSource(listRegions) });

    await expect(handler(makeJob({ type: 'download' }), makeContext())).rejects.toThrow(
      'catalog sync handler received a non-catalog job',
    );
    await expect(
      handler(makeJob({ payload: { unexpected: true } }), makeContext()),
    ).rejects.toThrow();
    const mismatchedSource = {
      id: 'different-source',
      listRegions: vi.fn(() => Promise.resolve(REGIONS)),
    } as unknown as CatalogIndexSource;
    const mismatchHandler = createCatalogSyncHandler({ source: mismatchedSource });
    await expect(
      mismatchHandler(makeJob({ payload: { source: 'geofabrik' } }), makeContext()),
    ).rejects.toThrow('catalog sync source does not match its handler');
    const controller = new AbortController();
    controller.abort(new Error('already canceled'));
    await expect(handler(makeJob(), makeContext(controller.signal))).rejects.toThrow(
      'already canceled',
    );
    expect(listRegions).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it('stops after source cancellation and rejects an invalid injected clock', async () => {
    const controller = new AbortController();
    const listRegions = vi.fn(() => {
      controller.abort(new Error('source canceled'));
      return Promise.resolve(REGIONS);
    });
    const handler = createCatalogSyncHandler({ source: makeSource(listRegions) });
    await expect(handler(makeJob(), makeContext(controller.signal))).rejects.toThrow(
      'source canceled',
    );
    expect(mocks.withTransaction).not.toHaveBeenCalled();

    const invalidClock = createCatalogSyncHandler({
      source: makeSource(),
      now: () => new Date(Number.NaN),
    });
    await expect(invalidClock(makeJob(), makeContext())).rejects.toThrow(RangeError);
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it('waits for a contended catalog lock but wakes promptly on cancellation', async () => {
    const controller = new AbortController();
    mocks.sqlExecute.mockImplementationOnce(() => {
      setTimeout(() => controller.abort(new Error('lock wait canceled')), 0);
      return Promise.resolve({ rows: [{ acquired: false }] });
    });
    const handler = createCatalogSyncHandler({ source: makeSource() });

    await expect(handler(makeJob(), makeContext(controller.signal))).rejects.toThrow(
      'lock wait canceled',
    );
    expect(mocks.sqlExecute).toHaveBeenCalledTimes(1);
    expect(mocks.upsertCatalogCountry).not.toHaveBeenCalled();
  });

  it('checks cancellation between country writes and rejects a broken clock only before transactions', async () => {
    const controller = new AbortController();
    mocks.upsertCatalogCountry.mockImplementationOnce(() => {
      controller.abort(new Error('canceled during upsert'));
      return Promise.resolve();
    });
    const handler = createCatalogSyncHandler({ source: makeSource(), now: () => SYNCED_AT });

    await expect(handler(makeJob(), makeContext(controller.signal))).rejects.toThrow(
      'canceled during upsert',
    );
    expect(mocks.upsertCatalogCountry).toHaveBeenCalledTimes(1);
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });
});

describe('catalog sync freshness policy', () => {
  function makeDatabase(active: unknown, marker: unknown) {
    const activeQuery = {
      select: vi.fn(() => activeQuery),
      where: vi.fn(() => activeQuery),
      executeTakeFirst: vi.fn(() => Promise.resolve(active)),
    };
    const markerQuery = {
      select: vi.fn(() => markerQuery),
      where: vi.fn(() => markerQuery),
      executeTakeFirst: vi.fn(() => Promise.resolve(marker)),
    };
    const selectFrom = vi.fn((table: string) => (table === 'jobs' ? activeQuery : markerQuery));
    return {
      database: { selectFrom } as unknown as Kysely<Database>,
      selectFrom,
      activeQuery,
      markerQuery,
    };
  }

  it('validates its TTL and clock before reading, and suppresses work while a sync is active', async () => {
    const setup = makeDatabase({ id: 'active' }, undefined);

    await expect(isCatalogSyncDue(setup.database, 0)).rejects.toThrow(RangeError);
    await expect(isCatalogSyncDue(setup.database, 1.5)).rejects.toThrow(RangeError);
    await expect(isCatalogSyncDue(setup.database, 1, new Date(Number.NaN))).rejects.toThrow(
      RangeError,
    );
    expect(setup.selectFrom).not.toHaveBeenCalled();

    await expect(isCatalogSyncDue(setup.database, 60, SYNCED_AT)).resolves.toBe(false);
    expect(setup.selectFrom).toHaveBeenCalledTimes(1);
    expect(setup.markerQuery.executeTakeFirst).not.toHaveBeenCalled();
  });

  it('requests a sync when the marker is absent or invalid and applies the TTL boundary exactly', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    for (const marker of [
      undefined,
      { value: null },
      { value: 'not-a-date' },
      { value: '2026-11-01' },
    ]) {
      const setup = makeDatabase(undefined, marker);
      await expect(isCatalogSyncDue(setup.database, 60, now)).resolves.toBe(true);
    }

    const atBoundary = makeDatabase(undefined, { value: '2026-11-01T11:00:00.000Z' });
    await expect(isCatalogSyncDue(atBoundary.database, 60, now)).resolves.toBe(true);
    const fresh = makeDatabase(undefined, { value: '2026-11-01T11:30:00.000Z' });
    await expect(isCatalogSyncDue(fresh.database, 60, now)).resolves.toBe(false);
    const future = makeDatabase(undefined, { value: '2026-11-01T12:30:00.000Z' });
    await expect(isCatalogSyncDue(future.database, 60, now)).resolves.toBe(false);
  });
});
