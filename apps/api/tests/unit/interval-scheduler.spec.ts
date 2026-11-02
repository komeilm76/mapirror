import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database, Interval } from '../../src/db/schema';
import {
  INTERVAL_SCHEDULER_INTERVAL_MS,
  scheduleDueIntervalsOnce,
  startIntervalScheduler,
} from '../../src/modules/intervals/scheduler';
import type { IntervalSchedulerLog } from '../../src/modules/intervals/scheduler';

const mocks = vi.hoisted(() => ({
  sqlExecute: vi.fn(),
  withTransaction: vi.fn(),
  lockCountryCacheForEnqueue: vi.fn(),
  enqueueDownloadJob: vi.fn(),
}));

vi.mock('kysely', () => ({ sql: () => ({ execute: mocks.sqlExecute }) }));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/db/repositories/cache', () => ({
  lockCountryCacheForEnqueue: mocks.lockCountryCacheForEnqueue,
}));
vi.mock('../../src/modules/jobs/enqueue-download', () => ({
  enqueueDownloadJobInTransaction: mocks.enqueueDownloadJob,
}));

const NOW = new Date('2026-11-01T12:00:00.000Z');
const BASE_INTERVAL = {
  id: 'interval-1',
  name: 'Daily refresh',
  frequency: 'daily' as const,
  time_of_day: '12:30',
  weekday: null,
  day_of_month: null,
  enabled: true,
  next_run_at: NOW,
  last_run_at: null,
  last_status: null,
  only_if_changed: true,
  keep_versions: 3,
  created_by: null,
  created_at: NOW,
  updated_at: NOW,
};
const BASE_COUNTRY = {
  country_id: 'country-1',
  country_slug: 'finland',
  country_name: 'Finland',
};

function makeSchedule(overrides: Partial<Interval> = {}): Interval {
  return { ...BASE_INTERVAL, ...overrides };
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies IntervalSchedulerLog;
}

function makeDatabase(
  intervals: Interval[],
  options: {
    readonly activeRuns?: Record<string, unknown>;
    readonly memberships?: Record<string, { country_id: string }[]>;
    readonly countries?: Record<string, (typeof BASE_COUNTRY)[]>;
    readonly failActiveRunFor?: string;
  } = {},
) {
  let selectedInterval: Interval | undefined;
  const intervalQuery = {
    selectAll: vi.fn(() => intervalQuery),
    where: vi.fn(() => intervalQuery),
    orderBy: vi.fn(() => intervalQuery),
    limit: vi.fn(() => intervalQuery),
    forUpdate: vi.fn(() => intervalQuery),
    skipLocked: vi.fn(() => intervalQuery),
    executeTakeFirst: vi.fn(() => {
      selectedInterval = intervals.shift();
      return Promise.resolve(selectedInterval);
    }),
  };
  const activeRunQuery = {
    select: vi.fn(() => activeRunQuery),
    where: vi.fn(() => activeRunQuery),
    executeTakeFirst: vi.fn(() => {
      if (selectedInterval?.id === options.failActiveRunFor) {
        return Promise.reject(new Error('active-run query failed'));
      }
      return Promise.resolve(options.activeRuns?.[selectedInterval?.id ?? '']);
    }),
  };
  let membershipSelect = false;
  const intervalCountriesQuery = {
    select: vi.fn(() => intervalCountriesQuery),
    where: vi.fn(() => intervalCountriesQuery),
    orderBy: vi.fn(() => intervalCountriesQuery),
    innerJoin: vi.fn(() => {
      membershipSelect = true;
      return intervalCountriesQuery;
    }),
    execute: vi.fn(() =>
      Promise.resolve(
        membershipSelect
          ? (options.countries?.[selectedInterval?.id ?? ''] ?? [])
          : (options.memberships?.[selectedInterval?.id ?? ''] ?? []),
      ),
    ),
  };
  let runNumber = 0;
  const runInsert = {
    values: vi.fn(() => runInsert),
    returning: vi.fn(() => runInsert),
    executeTakeFirstOrThrow: vi.fn(() => Promise.resolve({ id: `run-${++runNumber}` })),
  };
  const itemInsert = {
    values: vi.fn(() => itemInsert),
    execute: vi.fn(() => Promise.resolve()),
  };
  const intervalUpdate = {
    set: vi.fn((_values: unknown) => intervalUpdate),
    where: vi.fn(() => intervalUpdate),
    execute: vi.fn(() => Promise.resolve()),
    executeTakeFirst: vi.fn(() => Promise.resolve(undefined)),
  };
  const trx = {
    selectFrom: vi.fn((table: string) => {
      if (table === 'intervals') return intervalQuery;
      if (table === 'interval_runs') return activeRunQuery;
      return intervalCountriesQuery;
    }),
    insertInto: vi.fn((table: string) => (table === 'interval_runs' ? runInsert : itemInsert)),
    updateTable: vi.fn(() => intervalUpdate),
  };
  const withTransaction = vi.fn(
    async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) => work(trx),
  );
  const database = {} as Kysely<Database>;
  return {
    database,
    trx,
    intervalQuery,
    activeRunQuery,
    intervalCountriesQuery,
    runInsert,
    itemInsert,
    intervalUpdate,
    withTransaction,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sqlExecute.mockResolvedValue({
    rows: [{ database_now: NOW, schedule_now: NOW, acquired: true }],
  });
  mocks.lockCountryCacheForEnqueue.mockResolvedValue(undefined);
  mocks.enqueueDownloadJob.mockResolvedValue('download-job-1');
  mocks.withTransaction.mockImplementation(
    async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) => work({}),
  );
});

afterEach(() => vi.useRealTimers());

describe('one interval scheduling pass', () => {
  it('returns zeros when no enabled interval is due', async () => {
    const setup = makeDatabase([]);
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(setup.trx),
    );
    const log = makeLog();

    await expect(scheduleDueIntervalsOnce(setup.database, log)).resolves.toEqual({
      scheduled: 0,
      overlaps: 0,
      empty: 0,
      failed: 0,
    });
    expect(setup.intervalQuery.executeTakeFirst).toHaveBeenCalledTimes(1);
    expect(setup.intervalQuery.skipLocked).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('records an overlap, advances the occurrence, and emits a warning', async () => {
    const interval = makeSchedule();
    const setup = makeDatabase([interval], { activeRuns: { [interval.id]: { id: 'active-run' } } });
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(setup.trx),
    );
    const log = makeLog();

    await expect(scheduleDueIntervalsOnce(setup.database, log)).resolves.toEqual({
      scheduled: 0,
      overlaps: 1,
      empty: 0,
      failed: 0,
    });
    const update = setup.intervalUpdate.set.mock.calls[0]?.[0] as
      { next_run_at?: unknown } | undefined;
    expect(update?.next_run_at).toBeInstanceOf(Date);
    expect(log.warn).toHaveBeenCalledWith(
      { code: 'SKIPPED_OVERLAP', intervalId: interval.id, activeRunId: 'active-run' },
      'interval occurrence skipped because its previous run is still active',
    );
  });

  it('records an empty successful run and advances the next occurrence', async () => {
    const interval = makeSchedule();
    const setup = makeDatabase([interval]);
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(setup.trx),
    );
    const log = makeLog();

    await expect(scheduleDueIntervalsOnce(setup.database, log)).resolves.toEqual({
      scheduled: 0,
      overlaps: 0,
      empty: 1,
      failed: 0,
    });
    expect(setup.runInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        interval_id: interval.id,
        triggered_by: 'schedule',
        countries_total: 0,
        status: 'succeeded',
        finished_at: NOW,
      }),
    );
    const update = setup.intervalUpdate.set.mock.calls[0]?.[0] as
      { next_run_at?: unknown } | undefined;
    expect(update?.next_run_at).toBeInstanceOf(Date);
    expect(log.info).toHaveBeenCalledWith(
      { intervalId: interval.id, runId: 'run-1' },
      'empty interval occurrence recorded as succeeded',
    );
  });

  it('locks current membership and creates run items and latest download jobs for countries', async () => {
    const interval = makeSchedule({ created_by: 'admin-id' });
    const setup = makeDatabase([interval], {
      memberships: { [interval.id]: [{ country_id: 'country-1' }, { country_id: 'country-2' }] },
      countries: { [interval.id]: [BASE_COUNTRY] },
    });
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(setup.trx),
    );
    const log = makeLog();

    await expect(scheduleDueIntervalsOnce(setup.database, log)).resolves.toEqual({
      scheduled: 1,
      overlaps: 0,
      empty: 0,
      failed: 0,
    });
    expect(mocks.lockCountryCacheForEnqueue.mock.calls).toEqual([
      [setup.trx, 'country-1'],
      [setup.trx, 'country-2'],
    ]);
    expect(mocks.enqueueDownloadJob).toHaveBeenCalledWith(setup.trx, {
      countryId: 'country-1',
      version: 'latest',
      origin: 'geofabrik_latest',
      onlyIfChanged: true,
      keepVersions: 3,
      createdBy: 'admin-id',
    });
    expect(setup.itemInsert.values).toHaveBeenCalledWith({
      run_id: 'run-1',
      country_id: 'country-1',
      country_slug: 'finland',
      country_name: 'Finland',
      job_id: 'download-job-1',
    });
    expect(log.info).toHaveBeenCalledWith(
      { intervalId: interval.id, runId: 'run-1', countryCount: 1 },
      'interval run and country download jobs scheduled',
    );
  });

  it('isolates a failed claimed occurrence for this pass and continues with later due rows', async () => {
    const failed = makeSchedule({ id: 'failed-interval' });
    const healthy = makeSchedule({ id: 'healthy-interval' });
    const setup = makeDatabase([failed, healthy], { failActiveRunFor: failed.id });
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(setup.trx),
    );
    const log = makeLog();

    await expect(scheduleDueIntervalsOnce(setup.database, log)).resolves.toEqual({
      scheduled: 0,
      overlaps: 0,
      empty: 1,
      failed: 1,
    });
    const warning = log.warn.mock.calls[0]?.[0] as
      { err?: unknown; intervalId?: string } | undefined;
    expect(warning?.err).toBeInstanceOf(Error);
    expect(warning?.intervalId).toBe(failed.id);
    expect(log.warn.mock.calls[0]?.[1]).toBe(
      'interval scheduling transaction rolled back; occurrence remains due for retry',
    );
    expect(setup.intervalQuery.where).toHaveBeenCalledWith('id', 'not in', [failed.id]);
    expect(setup.intervalQuery.executeTakeFirst).toHaveBeenCalledTimes(3);
  });

  it('stops before claiming work when its signal is already aborted and propagates an unclaimed error', async () => {
    const setup = makeDatabase([makeSchedule()]);
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(setup.trx),
    );
    const log = makeLog();
    const controller = new AbortController();
    controller.abort();

    await expect(scheduleDueIntervalsOnce(setup.database, log, controller.signal)).resolves.toEqual(
      {
        scheduled: 0,
        overlaps: 0,
        empty: 0,
        failed: 0,
      },
    );
    expect(setup.intervalQuery.executeTakeFirst).not.toHaveBeenCalled();

    mocks.withTransaction.mockRejectedValueOnce(new Error('clock unavailable'));
    await expect(scheduleDueIntervalsOnce(setup.database, log)).rejects.toThrow(
      'clock unavailable',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('periodic interval scheduler', () => {
  it('validates the poll cadence before starting and stops an immediate polling loop', async () => {
    const setup = makeDatabase([]);
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(setup.trx),
    );
    const log = makeLog();

    expect(() => startIntervalScheduler(setup.database, { pollIntervalMs: 0, log })).toThrow(
      RangeError,
    );
    expect(() => startIntervalScheduler(setup.database, { pollIntervalMs: 1.5, log })).toThrow(
      RangeError,
    );
    expect(INTERVAL_SCHEDULER_INTERVAL_MS).toBe(30_000);

    vi.useFakeTimers();
    const scheduler = startIntervalScheduler(setup.database, { pollIntervalMs: 25, log });
    await vi.waitFor(() =>
      expect(setup.intervalQuery.executeTakeFirst.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    await scheduler.stop();
    const passesAtStop = setup.intervalQuery.executeTakeFirst.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(setup.intervalQuery.executeTakeFirst).toHaveBeenCalledTimes(passesAtStop);
  });

  it('logs pass failures and retries on the next tick', async () => {
    vi.useFakeTimers();
    const setup = makeDatabase([]);
    mocks.withTransaction.mockRejectedValueOnce(new Error('database unavailable'));
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(setup.trx),
    );
    const log = makeLog();
    const scheduler = startIntervalScheduler(setup.database, { pollIntervalMs: 25, log });

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    const errorContext = log.error.mock.calls[0]?.[0] as { err?: unknown } | undefined;
    expect(errorContext?.err).toBeInstanceOf(Error);
    expect(log.error.mock.calls[0]?.[1]).toBe(
      'interval scheduler pass failed; scheduler will retry',
    );
    await scheduler.stop();
  });
});
