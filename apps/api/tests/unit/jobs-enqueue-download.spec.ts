import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database } from '../../src/db/schema';
import {
  enqueueDownloadJob,
  enqueueDownloadJobInTransaction,
  type EnqueueDownloadJobInput,
} from '../../src/modules/jobs/enqueue-download';

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  lockCountryCacheForEnqueue: vi.fn(),
}));

vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/db/repositories/cache', () => ({
  lockCountryCacheForEnqueue: mocks.lockCountryCacheForEnqueue,
}));

const INPUT: EnqueueDownloadJobInput = {
  countryId: '00000000-0000-4000-8000-000000000001',
  version: '20261031',
};

function makeExecutor(
  options: {
    readonly country?: unknown;
    readonly readyVersion?: unknown;
    readonly activeImport?: unknown;
    readonly jobId?: string;
  } = {},
) {
  const queryResults: Record<string, unknown[]> = {
    countries: [Object.hasOwn(options, 'country') ? options.country : { id: INPUT.countryId }],
    map_versions: [options.readyVersion],
    jobs: [options.activeImport],
  };
  const selectBuilders = new Map<string, ReturnType<typeof makeSelectBuilder>>();
  function makeSelectBuilder(table: string) {
    return {
      select: vi.fn(() => selectBuilders.get(table)),
      where: vi.fn(() => selectBuilders.get(table)),
      forKeyShare: vi.fn(() => selectBuilders.get(table)),
      executeTakeFirst: vi.fn(() => Promise.resolve(queryResults[table]?.shift())),
    };
  }
  for (const table of ['countries', 'map_versions', 'jobs']) {
    selectBuilders.set(table, makeSelectBuilder(table));
  }

  const insertBuilder = {
    values: vi.fn(() => insertBuilder),
    returning: vi.fn(() => insertBuilder),
    executeTakeFirstOrThrow: vi.fn(() =>
      Promise.resolve({ id: options.jobId ?? 'generated-job-id' }),
    ),
  };
  const selectFrom = vi.fn((table: string) => selectBuilders.get(table));
  const executor = {
    selectFrom,
    insertInto: vi.fn(() => insertBuilder),
  } as unknown as Kysely<Database>;
  return { executor, selectFrom, selectBuilders, insertBuilder };
}

function uniqueViolation(constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error('duplicate'), { code: '23505', constraint });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockCountryCacheForEnqueue.mockResolvedValue(undefined);
});

describe('download job enqueueing', () => {
  it.each([0, 11, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid retention snapshots (%s)',
    async (keepVersions) => {
      const { executor, selectFrom } = makeExecutor();

      await expect(
        enqueueDownloadJobInTransaction(executor, { ...INPUT, keepVersions }),
      ).rejects.toThrow('keepVersions must be an integer between 1 and 10.');
      expect(selectFrom.mock.calls).toHaveLength(0);
    },
  );

  it('takes the enqueue lock before checking that the catalog country exists', async () => {
    const { executor } = makeExecutor({ country: undefined });

    await expect(enqueueDownloadJobInTransaction(executor, INPUT)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.lockCountryCacheForEnqueue).toHaveBeenCalledWith(executor, INPUT.countryId);
  });

  it('rejects a ready exact version but permits the mutable latest label to bypass that lookup', async () => {
    const ready = makeExecutor({ readyVersion: { id: 'version-id' } });

    await expect(enqueueDownloadJobInTransaction(ready.executor, INPUT)).rejects.toMatchObject({
      code: 'VERSION_ALREADY_CACHED',
    });
    expect(ready.selectFrom.mock.calls).toHaveLength(2);

    const latest = makeExecutor();
    await expect(
      enqueueDownloadJobInTransaction(latest.executor, { ...INPUT, version: 'latest' }),
    ).resolves.toBe('generated-job-id');
    expect(latest.selectFrom.mock.calls).toHaveLength(2);
  });

  it('rejects an active import for the same country/version', async () => {
    const { executor, selectBuilders, insertBuilder } = makeExecutor({
      activeImport: { id: 'import-job' },
    });

    await expect(enqueueDownloadJobInTransaction(executor, INPUT)).rejects.toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
      details: { countryId: INPUT.countryId, version: INPUT.version, jobId: 'import-job' },
    });
    expect(selectBuilders.get('jobs')?.where).toHaveBeenCalledTimes(4);
    expect(insertBuilder.executeTakeFirstOrThrow).not.toHaveBeenCalled();
  });

  it('inserts only supplied optional fields and returns the generated job id', async () => {
    const { executor, insertBuilder } = makeExecutor({ jobId: 'new-job' });

    await expect(
      enqueueDownloadJobInTransaction(executor, {
        ...INPUT,
        origin: 'geofabrik_snapshot',
        onlyIfChanged: false,
        keepVersions: 5,
        createdBy: 'admin-id',
      }),
    ).resolves.toBe('new-job');
    expect(insertBuilder.values).toHaveBeenCalledWith({
      type: 'download',
      payload: {
        countryId: INPUT.countryId,
        version: INPUT.version,
        origin: 'geofabrik_snapshot',
        onlyIfChanged: false,
        keepVersions: 5,
      },
      created_by: 'admin-id',
    });
  });

  it('uses defaults without inventing origin, retention, change-check, or creator values', async () => {
    const { executor, insertBuilder } = makeExecutor();

    await enqueueDownloadJobInTransaction(executor, INPUT);

    expect(insertBuilder.values).toHaveBeenCalledWith({
      type: 'download',
      payload: { countryId: INPUT.countryId, version: INPUT.version },
    });
  });

  it('translates only the named active-download unique constraint', async () => {
    const { executor } = makeExecutor();
    const original = uniqueViolation('jobs_one_active_download');
    mocks.withTransaction.mockRejectedValueOnce(original);

    await expect(enqueueDownloadJob(executor, INPUT)).rejects.toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
      details: { countryId: INPUT.countryId, version: INPUT.version },
      cause: original,
    });
  });

  it.each([
    uniqueViolation('other_unique_constraint'),
    Object.assign(new Error('not a postgres error'), { code: '23505' }),
    new Error('database unavailable'),
  ])('preserves unrelated database errors', async (error) => {
    const { executor } = makeExecutor();
    mocks.withTransaction.mockRejectedValueOnce(error);

    await expect(enqueueDownloadJob(executor, INPUT)).rejects.toBe(error);
  });
});
