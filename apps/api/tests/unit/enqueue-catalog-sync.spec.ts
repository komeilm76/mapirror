import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/schema';

const mocks = vi.hoisted(() => ({ withTransaction: vi.fn(), sql: vi.fn() }));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('kysely', () => ({ sql: mocks.sql }));

import { enqueueCatalogSyncJob } from '../../src/modules/jobs/enqueue-catalog-sync';

const JOB_ID = '00000000-0000-4000-8000-000000000001';

function makeSetup(active: { id: string } | undefined) {
  const activeQuery = {
    select: vi.fn(() => activeQuery),
    where: vi.fn(() => activeQuery),
    orderBy: vi.fn(() => activeQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve(active)),
  };
  const insertQuery = {
    values: vi.fn(() => insertQuery),
    returning: vi.fn(() => insertQuery),
    executeTakeFirstOrThrow: vi.fn(() => Promise.resolve({ id: JOB_ID })),
  };
  const database = {
    selectFrom: vi.fn(() => activeQuery),
    insertInto: vi.fn(() => insertQuery),
  };
  mocks.withTransaction.mockImplementation(
    (_database: unknown, callback: (trx: unknown) => Promise<unknown>) => callback(database),
  );
  return { database, activeQuery, insertQuery };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.mockImplementation(() => ({ execute: vi.fn(() => Promise.resolve({ rows: [] })) }));
});

describe('catalog sync enqueue helper', () => {
  it('returns an existing active job while holding the serialized transaction lock', async () => {
    const setup = makeSetup({ id: JOB_ID });
    await expect(enqueueCatalogSyncJob({} as unknown as Kysely<Database>)).resolves.toBe(JOB_ID);
    expect(setup.activeQuery.executeTakeFirst).toHaveBeenCalledOnce();
    expect(setup.database.insertInto).not.toHaveBeenCalled();
  });

  it('inserts one attributed catalog sync job when no active job exists', async () => {
    const setup = makeSetup(undefined);
    await expect(
      enqueueCatalogSyncJob({} as unknown as Kysely<Database>, { createdBy: 'admin-id' }),
    ).resolves.toBe(JOB_ID);
    expect(setup.database.insertInto).toHaveBeenCalledWith('jobs');
    expect(setup.insertQuery.values).toHaveBeenCalledWith({
      type: 'catalog_sync',
      payload: { source: 'geofabrik' },
      created_by: 'admin-id',
    });
  });

  it('uses a null creator for operator-invoked synchronization', async () => {
    const setup = makeSetup(undefined);
    await enqueueCatalogSyncJob({} as unknown as Kysely<Database>);
    expect(setup.insertQuery.values).toHaveBeenCalledWith(
      expect.objectContaining({ created_by: null }),
    );
  });
});
