import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database, Job } from '../../src/db/schema';
import {
  claimNextJob,
  startJobWorker,
  type JobHandlers,
  type WorkerLog,
} from '../../src/modules/jobs/worker';

const mocks = vi.hoisted(() => ({
  sqlExecute: vi.fn(),
  withTransaction: vi.fn(),
  tryAcquireJobLock: vi.fn(),
  releaseJobLock: vi.fn(),
  monitorJobCancellation: vi.fn(),
  createJobProgressReporter: vi.fn(),
  finalizeIntervalRunItem: vi.fn(),
}));

vi.mock('kysely', () => ({
  sql: Object.assign(() => ({ execute: mocks.sqlExecute }), { val: (value: unknown) => value }),
}));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/modules/intervals/run-items', () => ({
  finalizeIntervalRunItem: mocks.finalizeIntervalRunItem,
}));
vi.mock('../../src/modules/jobs/cancellation', () => ({
  JobOwnershipLostError: class extends Error {
    constructor(jobId: string) {
      super(`ownership lost for ${jobId}`);
    }
  },
  monitorJobCancellation: mocks.monitorJobCancellation,
}));
vi.mock('../../src/modules/jobs/lock', () => ({
  releaseJobLock: mocks.releaseJobLock,
  tryAcquireJobLock: mocks.tryAcquireJobLock,
}));
vi.mock('../../src/modules/jobs/progress', () => ({
  createJobProgressReporter: mocks.createJobProgressReporter,
}));

const log = {
  info: vi.fn<(context: object, message: string) => void>(),
  warn: vi.fn<(context: object, message: string) => void>(),
  error: vi.fn<(context: object, message: string) => void>(),
} satisfies WorkerLog;

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date('2026-11-01T12:00:00.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'update_check',
    status: 'running',
    priority: 0,
    payload: {},
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

function makeSession(heartbeatResult: unknown = { id: 'job-id', progress_bytes: '0' }) {
  const jobUpdate = {
    set: vi.fn((_values: unknown) => jobUpdate),
    where: vi.fn((_column: unknown, ..._values: unknown[]) => jobUpdate),
    returning: vi.fn((_columns: unknown) => jobUpdate),
    executeTakeFirst: vi.fn(() => Promise.resolve(heartbeatResult)),
    execute: vi.fn(() => Promise.resolve()),
  };
  const runItemQuery = {
    select: vi.fn(() => runItemQuery),
    where: vi.fn(() => runItemQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve({ run_id: 'run-id' })),
  };
  const pruneInsert = {
    values: vi.fn(() => pruneInsert),
    execute: vi.fn(() => Promise.resolve()),
  };
  const session = { updateTable: vi.fn(() => jobUpdate) };
  const trx = {
    updateTable: vi.fn(() => jobUpdate),
    selectFrom: vi.fn(() => runItemQuery),
    insertInto: vi.fn(() => pruneInsert),
  };
  return { session, jobUpdate, trx, runItemQuery, pruneInsert };
}

function makeDatabase(
  jobRows: (Job | null)[],
  heartbeatResult: unknown = { id: 'job-id', progress_bytes: '0' },
) {
  const { session, jobUpdate, trx, runItemQuery, pruneInsert } = makeSession(heartbeatResult);
  const execute = vi.fn((work: (connection: typeof session) => Promise<unknown>) => work(session));
  const connection = vi.fn(() => ({ execute }));
  const database = { connection } as unknown as Kysely<Database>;
  mocks.withTransaction.mockImplementation(
    async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) => work(trx),
  );
  mocks.sqlExecute.mockImplementation(() =>
    Promise.resolve({ rows: [jobRows.shift()].filter(Boolean) }),
  );
  return { database, connection, execute, session, jobUpdate, trx, runItemQuery, pruneInsert };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

function cancellationMonitor() {
  return {
    stop: vi.fn(() => Promise.resolve()),
    requested: vi.fn(() => false),
    ownershipLost: vi.fn(() => false),
  };
}

describe('atomic worker job claims', () => {
  it('validates the worker id, avoids SQL for no types, and returns null when the queue is empty', async () => {
    const database = {} as Kysely<Database>;
    await expect(claimNextJob(database, '  ', ['download'])).rejects.toThrow(
      'workerId must not be empty',
    );
    await expect(claimNextJob(database, 'worker-1', [])).resolves.toBeNull();

    mocks.sqlExecute.mockResolvedValueOnce({ rows: [] });
    await expect(claimNextJob(database, 'worker-1', ['download'])).resolves.toBeNull();
    expect(mocks.sqlExecute).toHaveBeenCalledTimes(1);
  });

  it('returns the first row claimed for the registered types', async () => {
    const database = {} as Kysely<Database>;
    const row = makeJob({ type: 'download' });
    mocks.sqlExecute.mockResolvedValueOnce({ rows: [row] });

    await expect(claimNextJob(database, 'worker-2', ['download', 'prune'])).resolves.toBe(row);
    expect(mocks.sqlExecute).toHaveBeenCalledTimes(1);
  });
});

describe('worker pool execution', () => {
  it('validates loop timing and retry settings before touching a database', () => {
    const database = {} as Kysely<Database>;
    const handlers: JobHandlers = { update_check: () => Promise.resolve(null) };

    expect(() => startJobWorker(database, handlers, { concurrency: 0, log })).toThrow(RangeError);
    expect(() =>
      startJobWorker(database, handlers, {
        concurrency: 1,
        pollIntervalMs: 0,
        log,
      }),
    ).toThrow(RangeError);
    expect(() =>
      startJobWorker(database, handlers, {
        concurrency: 1,
        retryBaseDelayMs: -1,
        log,
      }),
    ).toThrow(RangeError);
  });

  it('runs a registered handler, persists success, and releases its advisory lock', async () => {
    const queued = makeJob();
    const setup = makeDatabase([queued, null]);
    mocks.tryAcquireJobLock.mockResolvedValue(true);
    mocks.releaseJobLock.mockResolvedValue(undefined);
    const cancellation = cancellationMonitor();
    mocks.monitorJobCancellation.mockReturnValue(cancellation);
    const progress = {
      report: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    };
    mocks.createJobProgressReporter.mockReturnValue(progress);
    const handler = vi.fn<NonNullable<JobHandlers['update_check']>>(() =>
      Promise.resolve({ checked: true }),
    );

    const worker = startJobWorker(
      setup.database,
      { update_check: handler },
      {
        concurrency: 1,
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        cancellationPollIntervalMs: 60_000,
        workerId: () => 'worker-fixed',
        log,
      },
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await worker.stop();

    expect(handler.mock.calls[0]?.[0]).toEqual(queued);
    expect(setup.jobUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded', result: { checked: true } }),
    );
    expect(mocks.releaseJobLock).toHaveBeenCalledWith(setup.session, queued.id);
    expect(progress.stop).toHaveBeenCalledTimes(1);
  });

  it('persists only the generic retrying failure and returns a busy-lock claim to the queue', async () => {
    const failedJob = makeJob();
    const setup = makeDatabase([failedJob, null]);
    mocks.tryAcquireJobLock.mockResolvedValue(true);
    mocks.releaseJobLock.mockResolvedValue(undefined);
    mocks.monitorJobCancellation.mockReturnValue(cancellationMonitor());
    mocks.createJobProgressReporter.mockReturnValue({
      report: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    });
    const rejectedHandler = vi.fn(() =>
      Promise.reject(new Error('sensitive implementation detail')),
    );
    const worker = startJobWorker(
      setup.database,
      { update_check: rejectedHandler },
      {
        concurrency: 1,
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        cancellationPollIntervalMs: 60_000,
        workerId: () => 'worker-fixed',
        log,
      },
    );
    await vi.waitFor(() => expect(rejectedHandler).toHaveBeenCalledTimes(1));
    await worker.stop();
    expect(setup.jobUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: 'JOB_HANDLER_FAILED',
        error_message: 'The job handler failed.',
      }),
    );
    const errorContext = log.error.mock.calls[0]?.[0] as
      { err?: unknown; type?: string } | undefined;
    expect(errorContext?.err).toBeInstanceOf(Error);
    expect(errorContext?.type).toBe('update_check');
    expect(log.error.mock.calls[0]?.[1]).toBe('job handler failed');
    expect(mocks.releaseJobLock).toHaveBeenCalledWith(setup.session, failedJob.id);

    const busySetup = makeDatabase([makeJob(), null]);
    mocks.tryAcquireJobLock.mockResolvedValueOnce(false);
    const neverHandler = vi.fn(() => Promise.resolve(null));
    const busyWorker = startJobWorker(
      busySetup.database,
      { update_check: neverHandler },
      {
        concurrency: 1,
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        cancellationPollIntervalMs: 60_000,
        workerId: () => 'worker-busy',
        log,
      },
    );
    await vi.waitFor(() => expect(busySetup.jobUpdate.execute).toHaveBeenCalledTimes(1));
    await busyWorker.stop();
    expect(neverHandler).not.toHaveBeenCalled();
    expect(busySetup.jobUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued', locked_by: null, locked_at: null }),
    );
  });

  it('finalizes an unchanged download without scheduling a prune job', async () => {
    const countryId = '00000000-0000-4000-8000-000000000001';
    const download = makeJob({
      type: 'download',
      payload: { countryId, version: 'latest', keepVersions: 4 },
    });
    const setup = makeDatabase([download, null]);
    mocks.tryAcquireJobLock.mockResolvedValue(true);
    mocks.releaseJobLock.mockResolvedValue(undefined);
    mocks.monitorJobCancellation.mockReturnValue(cancellationMonitor());
    mocks.createJobProgressReporter.mockReturnValue({
      report: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    });
    const handler = vi.fn<NonNullable<JobHandlers['download']>>(() =>
      Promise.resolve({ version: '20261101', skipReason: 'unchanged' }),
    );
    const worker = startJobWorker(
      setup.database,
      { download: handler },
      {
        concurrency: 1,
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        cancellationPollIntervalMs: 60_000,
        workerId: () => 'worker-download',
        log,
      },
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await worker.stop();

    expect(mocks.finalizeIntervalRunItem).toHaveBeenCalledWith(setup.trx, download.id, {
      status: 'skipped',
      version: '20261101',
      errorCode: null,
      errorMessage: 'The source is unchanged; no download was needed.',
    });
    expect(setup.pruneInsert.values).not.toHaveBeenCalled();
  });

  it('finalizes a downloaded interval item and queues retention when the payload requests it', async () => {
    const countryId = '00000000-0000-4000-8000-000000000001';
    const download = makeJob({
      type: 'download',
      created_by: 'admin-id',
      payload: { countryId, version: '20261101', keepVersions: 3 },
    });
    const setup = makeDatabase([download, null]);
    mocks.tryAcquireJobLock.mockResolvedValue(true);
    mocks.releaseJobLock.mockResolvedValue(undefined);
    mocks.monitorJobCancellation.mockReturnValue(cancellationMonitor());
    mocks.createJobProgressReporter.mockReturnValue({
      report: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    });
    const handler = vi.fn<NonNullable<JobHandlers['download']>>(() =>
      Promise.resolve({ version: '20261101' }),
    );
    const worker = startJobWorker(
      setup.database,
      { download: handler },
      {
        concurrency: 1,
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        cancellationPollIntervalMs: 60_000,
        workerId: () => 'worker-download',
        log,
      },
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await worker.stop();

    expect(mocks.finalizeIntervalRunItem).toHaveBeenCalledWith(setup.trx, download.id, {
      status: 'downloaded',
      bytes: '0',
      version: '20261101',
    });
    expect(setup.pruneInsert.values).toHaveBeenCalledWith({
      type: 'prune',
      payload: { countryId, keep: 3 },
      max_attempts: 10,
      created_by: 'admin-id',
    });
  });

  it('finishes cooperative cancellation only after handler completion and cleanup', async () => {
    const download = makeJob({ type: 'download' });
    const setup = makeDatabase([download, null]);
    mocks.tryAcquireJobLock.mockResolvedValue(true);
    mocks.releaseJobLock.mockResolvedValue(undefined);
    const cancellation = cancellationMonitor();
    cancellation.requested.mockReturnValue(true);
    mocks.monitorJobCancellation.mockReturnValue(cancellation);
    mocks.createJobProgressReporter.mockReturnValue({
      report: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    });
    const handler = vi.fn<NonNullable<JobHandlers['download']>>(() => Promise.resolve(undefined));
    const worker = startJobWorker(
      setup.database,
      { download: handler },
      {
        concurrency: 1,
        pollIntervalMs: 60_000,
        heartbeatIntervalMs: 60_000,
        cancellationPollIntervalMs: 60_000,
        workerId: () => 'worker-cancel',
        log,
      },
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await worker.stop();

    expect(setup.jobUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canceled', cancel_requested: true }),
    );
    expect(mocks.finalizeIntervalRunItem).toHaveBeenCalledWith(setup.trx, download.id, {
      status: 'skipped',
      version: null,
      errorCode: null,
      errorMessage: 'The download was canceled.',
    });
    expect(mocks.releaseJobLock).toHaveBeenCalledWith(setup.session, download.id);
  });
});
