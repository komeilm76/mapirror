import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database, Job } from '../../src/db/schema';
import {
  JobCancellationRequestedError,
  JobOwnershipLostError,
  monitorJobCancellation,
  requestJobCancellation,
} from '../../src/modules/jobs/cancellation';
import type { WorkerLog } from '../../src/modules/jobs/worker';

type CancellationRow = { status: Job['status']; type: Job['type'] } | undefined;

function makeDatabase(
  rows: unknown[] = [],
  counts = { queued: 0, downloaded: 0, failed: 0, skipped: 1, bytes: '0' },
) {
  const executeQuery = vi.fn(() => Promise.resolve({ rows: [] }));
  const executor = {
    transformQuery: vi.fn((node: unknown) => node),
    compileQuery: vi.fn((node: unknown) => node),
    executeQuery,
  };
  const selectQuery = {
    select: vi.fn(() => selectQuery),
    where: vi.fn(() => selectQuery),
    forUpdate: vi.fn(() => selectQuery),
    executeTakeFirst: vi.fn(() => {
      const row = rows.shift();
      return row instanceof Error ? Promise.reject(row) : Promise.resolve(row);
    }),
    executeTakeFirstOrThrow: vi.fn(() => Promise.resolve(counts)),
  };
  const itemUpdate = {
    set: vi.fn(() => itemUpdate),
    where: vi.fn(() => itemUpdate),
    returning: vi.fn(() => itemUpdate),
    executeTakeFirst: vi.fn(() => Promise.resolve({ run_id: 'run-id' })),
  };
  const runUpdate = {
    set: vi.fn(() => runUpdate),
    where: vi.fn(() => runUpdate),
    execute: vi.fn(() => Promise.resolve()),
  };
  const jobUpdate = {
    set: vi.fn(() => jobUpdate),
    where: vi.fn(() => jobUpdate),
    execute: vi.fn(() => Promise.resolve()),
  };
  const updateByTable: Record<string, unknown> = {
    jobs: jobUpdate,
    interval_run_items: itemUpdate,
    interval_runs: runUpdate,
  };
  const trx = {
    getExecutor: () => executor,
    selectFrom: vi.fn(() => selectQuery),
    updateTable: vi.fn((table: string) => updateByTable[table]),
  };
  const transactionBuilder = {
    execute: vi.fn((work: (transaction: typeof trx) => Promise<unknown>) => work(trx)),
  };
  const transaction = vi.fn(() => transactionBuilder);
  const database = {
    transaction,
    getExecutor: () => executor,
    selectFrom: trx.selectFrom,
  } as unknown as Kysely<Database>;
  return {
    database,
    transaction,
    trx,
    transactionBuilder,
    jobUpdate,
    itemUpdate,
    runUpdate,
    selectQuery,
    executeQuery,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'download',
    status: 'running',
    priority: 0,
    payload: {},
    result: null,
    created_by: null,
    created_at: new Date('2026-11-01T00:00:00.000Z'),
    run_after: new Date('2026-11-01T00:00:00.000Z'),
    started_at: new Date('2026-11-01T00:00:00.000Z'),
    finished_at: null,
    locked_by: 'worker-1',
    locked_at: new Date('2026-11-01T00:00:00.000Z'),
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

const log: WorkerLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => vi.useRealTimers());

describe('durable job cancellation requests', () => {
  it('rejects a blank id before opening a transaction', async () => {
    const { database, transaction } = makeDatabase();

    await expect(requestJobCancellation(database, '   ')).rejects.toThrow(
      'jobId must not be empty',
    );
    expect(transaction.mock.calls).toHaveLength(0);
  });

  it('returns not-found without updating any row', async () => {
    const setup = makeDatabase([undefined]);

    await expect(requestJobCancellation(setup.database, 'missing')).resolves.toEqual({
      found: false,
      status: null,
      accepted: false,
    });
    expect(setup.jobUpdate.set).not.toHaveBeenCalled();
  });

  it('cancels queued jobs immediately and releases their claim fields', async () => {
    const setup = makeDatabase([{ status: 'queued', type: 'import' } satisfies CancellationRow]);

    await expect(requestJobCancellation(setup.database, 'queued-job')).resolves.toEqual({
      found: true,
      status: 'canceled',
      accepted: true,
    });
    expect(setup.jobUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({
        cancel_requested: true,
        status: 'canceled',
        locked_by: null,
        locked_at: null,
      }),
    );
    expect(setup.jobUpdate.where).toHaveBeenCalledWith('status', '=', 'queued');
  });

  it('finalizes a queued download as skipped inside the same transaction', async () => {
    const setup = makeDatabase([{ status: 'queued', type: 'download' } satisfies CancellationRow]);

    await requestJobCancellation(setup.database, 'queued-download');

    expect(setup.itemUpdate.set).toHaveBeenCalledWith({
      status: 'skipped',
      bytes: 0n,
      version: null,
      error_code: null,
      error_message: 'The download was canceled.',
    });
    expect(setup.transactionBuilder.execute).toHaveBeenCalledTimes(1);
  });

  it('sets only the durable request bit for a running job', async () => {
    const setup = makeDatabase([{ status: 'running', type: 'download' } satisfies CancellationRow]);

    await expect(requestJobCancellation(setup.database, 'running-job')).resolves.toEqual({
      found: true,
      status: 'running',
      accepted: true,
    });
    expect(setup.jobUpdate.set).toHaveBeenCalledWith({ cancel_requested: true });
    expect(setup.jobUpdate.where).toHaveBeenCalledWith('status', '=', 'running');
    expect(setup.itemUpdate.set).not.toHaveBeenCalled();
  });

  it.each([
    ['succeeded', false],
    ['failed', false],
    ['canceled', true],
  ] as const)('does not change an already terminal %s job', async (status, accepted) => {
    const setup = makeDatabase([{ status, type: 'download' } satisfies CancellationRow]);

    await expect(requestJobCancellation(setup.database, 'terminal-job')).resolves.toEqual({
      found: true,
      status,
      accepted,
    });
    expect(setup.jobUpdate.set).not.toHaveBeenCalled();
  });
});

describe('worker-side cancellation monitor', () => {
  it('aborts immediately when the claimed job snapshot already carries a cancellation request', () => {
    const setup = makeDatabase();
    const ownership = new AbortController();
    const monitor = monitorJobCancellation(
      setup.database,
      makeJob({ cancel_requested: true }),
      'worker-1',
      ownership,
      { intervalMs: 25, log },
    );

    expect(monitor.requested()).toBe(true);
    expect(ownership.signal.reason).toBeInstanceOf(JobCancellationRequestedError);
    expect(setup.selectQuery.executeTakeFirst).not.toHaveBeenCalled();
  });

  it('observes the persisted request bit and aborts the cooperative handler', async () => {
    vi.useFakeTimers();
    const setup = makeDatabase([{ cancel_requested: true }]);
    const ownership = new AbortController();
    const monitor = monitorJobCancellation(setup.database, makeJob(), 'worker-1', ownership, {
      intervalMs: 25,
      log,
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(monitor.requested()).toBe(true);
    expect(ownership.signal.reason).toBeInstanceOf(JobCancellationRequestedError);
    await monitor.stop();
  });

  it('reports ownership loss when the worker no longer owns a running row', async () => {
    vi.useFakeTimers();
    const setup = makeDatabase([undefined]);
    const ownership = new AbortController();
    const monitor = monitorJobCancellation(setup.database, makeJob(), 'worker-1', ownership, {
      intervalMs: 25,
      log,
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(monitor.ownershipLost()).toBe(true);
    expect(ownership.signal.reason).toBeInstanceOf(JobOwnershipLostError);
    await monitor.stop();
  });

  it('logs a transient poll error, retries on the next interval, and stops future polls', async () => {
    vi.useFakeTimers();
    const transient = new Error('connection reset');
    const setup = makeDatabase([transient, { cancel_requested: false }]);
    const warning = vi.fn();
    const monitor = monitorJobCancellation(
      setup.database,
      makeJob(),
      'worker-1',
      new AbortController(),
      {
        intervalMs: 25,
        log: { ...log, warn: warning },
      },
    );

    await vi.advanceTimersByTimeAsync(25);
    expect(warning).toHaveBeenCalledWith(
      { err: transient, jobId: '00000000-0000-4000-8000-000000000001' },
      'job cancellation poll failed; worker will retry',
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(setup.selectQuery.executeTakeFirst).toHaveBeenCalledTimes(2);

    await monitor.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(setup.selectQuery.executeTakeFirst).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid poll interval %s',
    (intervalMs) => {
      const setup = makeDatabase();

      expect(() =>
        monitorJobCancellation(setup.database, makeJob(), 'worker-1', new AbortController(), {
          intervalMs,
          log,
        }),
      ).toThrow(RangeError);
    },
  );
});
