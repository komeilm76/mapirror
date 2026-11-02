import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database } from '../../src/db/schema';
import {
  JOB_REAPER_INTERVAL_MS,
  STALE_JOB_AGE_MS,
  reapStaleJobs,
  startJobReaper,
} from '../../src/modules/jobs/reaper';
import type { WorkerLog } from '../../src/modules/jobs/worker';

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  finalizeIntervalRunItem: vi.fn(),
  tryAcquireJobLock: vi.fn(),
  releaseJobLock: vi.fn(),
}));

vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/modules/intervals/run-items', () => ({
  finalizeIntervalRunItem: mocks.finalizeIntervalRunItem,
}));
vi.mock('../../src/modules/jobs/lock', () => ({
  tryAcquireJobLock: mocks.tryAcquireJobLock,
  releaseJobLock: mocks.releaseJobLock,
}));

const quietLog: WorkerLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function job(id: string, attempts = 1, maxAttempts = 4) {
  return { id, attempts, max_attempts: maxAttempts };
}

function makeDatabase(candidates: ReturnType<typeof job>[] = [], recovered: unknown[] = []) {
  const candidateQuery = {
    select: vi.fn(() => candidateQuery),
    where: vi.fn((_column: unknown, ..._args: unknown[]) => candidateQuery),
    orderBy: vi.fn(() => candidateQuery),
    execute: vi.fn(() => Promise.resolve(candidates)),
  };
  const updateQuery = {
    set: vi.fn((_values: unknown) => updateQuery),
    where: vi.fn(() => updateQuery),
    returning: vi.fn(() => updateQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve(recovered.shift())),
  };
  const session = {
    selectFrom: vi.fn(() => candidateQuery),
    updateTable: vi.fn(() => updateQuery),
  };
  const connection = vi.fn(() => ({
    execute: (work: (connection: typeof session) => Promise<unknown>) => work(session),
  }));
  const database = { connection } as unknown as Kysely<Database>;
  return { database, connection, session, candidateQuery, updateQuery };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(
    async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
      work(setup?.session),
  );
  mocks.finalizeIntervalRunItem.mockResolvedValue(undefined);
  mocks.releaseJobLock.mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

let setup: ReturnType<typeof makeDatabase> | undefined;

describe('stale worker recovery pass', () => {
  it('uses the documented defaults and returns a zero summary when there are no candidates', async () => {
    setup = makeDatabase();

    await expect(reapStaleJobs(setup.database)).resolves.toEqual({
      examined: 0,
      requeued: 0,
      failed: 0,
      lockBusy: 0,
    });
    expect(setup.connection.mock.calls).toHaveLength(1);
    expect(setup.candidateQuery.where).toHaveBeenNthCalledWith(1, 'status', '=', 'running');
    expect(setup.candidateQuery.where.mock.calls[1]?.[0]).toBe('locked_at');
  });

  it('rejects unsafe stale ages and invalid clocks before opening a session', async () => {
    setup = makeDatabase();

    await expect(reapStaleJobs(setup.database, { staleAfterMs: 0 })).rejects.toThrow(RangeError);
    await expect(reapStaleJobs(setup.database, { staleAfterMs: 1.5 })).rejects.toThrow(RangeError);
    await expect(reapStaleJobs(setup.database, { now: new Date(Number.NaN) })).rejects.toThrow(
      RangeError,
    );
    expect(setup.connection.mock.calls).toHaveLength(0);
  });

  it('requeues retryable jobs, fails exhausted jobs, skips busy locks, and preserves fresh heartbeats', async () => {
    setup = makeDatabase(
      [job('busy'), job('heartbeat'), job('retry', 2, 4), job('exhausted', 4, 4)],
      [undefined, { id: 'retry' }, { id: 'exhausted' }],
    );
    mocks.tryAcquireJobLock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(setup?.session),
    );

    await expect(
      reapStaleJobs(setup.database, {
        now: new Date('2026-11-01T12:00:00.000Z'),
        staleAfterMs: 30_000,
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 1_000,
      }),
    ).resolves.toEqual({ examined: 4, requeued: 1, failed: 1, lockBusy: 1 });

    expect(setup.updateQuery.executeTakeFirst).toHaveBeenCalledTimes(3);
    expect(setup.updateQuery.set.mock.calls[0]?.[0]).toMatchObject({
      status: 'queued',
      error_code: 'WORKER_LOST',
      error_message: 'The worker stopped before this job completed.',
      locked_by: null,
      locked_at: null,
    });
    const failedUpdate = setup.updateQuery.set.mock.calls[2]?.[0] as
      { status?: string; error_code?: string; finished_at?: unknown } | undefined;
    expect(failedUpdate).toMatchObject({ status: 'failed', error_code: 'WORKER_LOST' });
    expect(failedUpdate).toHaveProperty('finished_at');
    expect(mocks.finalizeIntervalRunItem).toHaveBeenCalledWith(setup.session, 'exhausted', {
      status: 'failed',
      errorCode: 'WORKER_LOST',
      errorMessage: 'The worker stopped before this job completed.',
    });
    expect(mocks.releaseJobLock).toHaveBeenCalledTimes(3);
  });

  it('releases an acquired lock even when recovery fails', async () => {
    setup = makeDatabase([job('recovery-error')]);
    mocks.tryAcquireJobLock.mockResolvedValue(true);
    const failure = new Error('transaction failed');
    mocks.withTransaction.mockRejectedValue(failure);

    await expect(reapStaleJobs(setup.database)).rejects.toBe(failure);
    expect(mocks.releaseJobLock).toHaveBeenCalledWith(setup.session, 'recovery-error');
  });
});

describe('periodic stale-job reaper', () => {
  it('enforces the five-minute recovery bound and retry delay validation', () => {
    const currentSetup = makeDatabase();
    setup = currentSetup;

    expect(() =>
      startJobReaper(currentSetup.database, {
        pollIntervalMs: 30_000,
        staleAfterMs: 4 * 60_000 + 31_000,
        log: quietLog,
      }),
    ).toThrow('job reaper interval plus stale age must not exceed five minutes');
    expect(() =>
      startJobReaper(currentSetup.database, {
        retryBaseDelayMs: -1,
        log: quietLog,
      }),
    ).toThrow(RangeError);
    expect(JOB_REAPER_INTERVAL_MS + STALE_JOB_AGE_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it('runs immediately, logs a non-empty pass, then stops and drains its timer', async () => {
    vi.useFakeTimers();
    setup = makeDatabase([job('still-owned')]);
    mocks.tryAcquireJobLock.mockResolvedValue(false);
    const info = vi.fn();
    const reaper = startJobReaper(setup.database, {
      pollIntervalMs: 25,
      staleAfterMs: 30,
      log: { ...quietLog, info },
    });

    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info).toHaveBeenCalledWith(
      { examined: 1, requeued: 0, failed: 0, lockBusy: 1 },
      'stale job recovery pass completed',
    );
    const passesBeforeStop = setup.candidateQuery.execute.mock.calls.length;
    await reaper.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(setup.candidateQuery.execute).toHaveBeenCalledTimes(passesBeforeStop);
  });

  it('logs a failed pass and continues until shutdown', async () => {
    vi.useFakeTimers();
    setup = makeDatabase();
    const currentSetup = setup;
    currentSetup.connection.mockImplementationOnce(() => ({
      execute: () => Promise.reject(new Error('database offline')),
    }));
    const error = vi.fn<(fields: unknown, message: string) => void>();
    const reaper = startJobReaper(setup.database, {
      pollIntervalMs: 25,
      log: { ...quietLog, error },
    });

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    const errorFields = error.mock.calls[0]?.[0] as { err?: unknown } | undefined;
    expect(errorFields?.err).toBeInstanceOf(Error);
    expect(error.mock.calls[0]?.[1]).toBe('stale job recovery pass failed');
    await reaper.stop();
  });
});
