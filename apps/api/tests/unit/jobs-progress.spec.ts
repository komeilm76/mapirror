import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database, Job } from '../../src/db/schema';
import {
  MAX_JOB_ETA_SECONDS,
  createJobProgressReporter,
  estimateJobEtaSeconds,
} from '../../src/modules/jobs/progress';

function makeJob(progressBytes = '0'): Job {
  const now = new Date('2026-11-01T12:00:00.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'download',
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
    progress_bytes: progressBytes,
    total_bytes: null,
    speed_bps: null,
    phase: null,
    error_code: null,
    error_message: null,
  };
}

function makeSession(results: Array<{ progress_bytes: string } | undefined | Error>) {
  const set = vi.fn((_values: unknown) => query);
  const executeTakeFirst = vi.fn(() => {
    const result = results.shift();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const query = {
    set,
    where: vi.fn(() => query),
    returning: vi.fn(() => query),
    executeTakeFirst,
  };
  const session = { updateTable: vi.fn(() => query) } as unknown as Kysely<Database>;
  return { session, set, executeTakeFirst };
}

afterEach(() => vi.useRealTimers());

describe('job progress reporting', () => {
  it('coalesces regressing updates, preserves omitted fields and flushes the latest snapshot', async () => {
    const setup = makeSession([{ progress_bytes: '50' }, { progress_bytes: '80' }]);
    let clock = 0;
    const reporter = createJobProgressReporter(setup.session, makeJob(), 'worker-1', {
      minIntervalMs: 1_000,
      now: () => clock,
    });
    await reporter.report({ progressBytes: 50n, totalBytes: 100n, phase: 'downloading' });
    await reporter.report({ progressBytes: 40n });
    await reporter.report({ progressBytes: 80n, totalBytes: null, phase: 'verifying' });
    clock = 1_000;
    await reporter.flush();

    expect(setup.executeTakeFirst).toHaveBeenCalledTimes(2);
    expect(setup.set.mock.calls[1]?.[0]).toMatchObject({
      speed_bps: 30n,
      total_bytes: null,
      phase: 'verifying',
    });
    await reporter.stop();
    await expect(reporter.report({ progressBytes: 90n })).rejects.toThrow('is stopped');
  });

  it('throttles persistence but continues timers and flushes the newest progress', async () => {
    vi.useFakeTimers();
    const setup = makeSession([{ progress_bytes: '10' }, { progress_bytes: '20' }]);
    let clock = 0;
    const reporter = createJobProgressReporter(setup.session, makeJob(), 'worker-1', {
      minIntervalMs: 1_000,
      now: () => clock,
    });
    await reporter.report({ progressBytes: 10n });
    clock = 100;
    await reporter.report({ progressBytes: 20n });
    expect(setup.executeTakeFirst).toHaveBeenCalledOnce();
    clock = 1_000;
    await vi.advanceTimersByTimeAsync(900);
    expect(setup.executeTakeFirst).toHaveBeenCalledTimes(2);
    await reporter.stop();
  });

  it('rejects invalid intervals, clocks and values beyond PostgreSQL bigint bounds', async () => {
    const setup = makeSession([]);
    expect(() =>
      createJobProgressReporter(setup.session, makeJob(), 'worker', { minIntervalMs: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createJobProgressReporter(setup.session, makeJob(), 'worker', { now: () => Number.NaN }),
    ).toThrow(RangeError);
    const reporter = createJobProgressReporter(setup.session, makeJob(), 'worker', {
      now: () => 0,
    });
    await expect(reporter.report({ progressBytes: -1n })).rejects.toThrow(RangeError);
    await expect(
      reporter.report({ progressBytes: 1n, totalBytes: 9_223_372_036_854_775_808n }),
    ).rejects.toThrow(RangeError);
    expect(setup.executeTakeFirst).not.toHaveBeenCalled();
  });

  it('keeps failed writes buffered, reports ownership loss, and normalizes non-Error rejections', async () => {
    const lost = makeSession([undefined]);
    const lostReporter = createJobProgressReporter(lost.session, makeJob(), 'worker-1', {
      now: () => 0,
    });
    await expect(lostReporter.report({ progressBytes: 1n })).rejects.toThrow(
      'worker no longer owns progress for job 00000000-0000-4000-8000-000000000001',
    );
    await expect(lostReporter.flush()).rejects.toThrow('worker no longer owns progress');

    const failed = makeSession([new Error('database unavailable')]);
    const failedReporter = createJobProgressReporter(failed.session, makeJob(), 'worker-1', {
      now: () => 0,
    });
    await expect(failedReporter.report({ progressBytes: 1n })).rejects.toThrow(
      'database unavailable',
    );
    await expect(failedReporter.flush()).rejects.toThrow('database unavailable');

    const rejected = makeSession([]);
    // Exercise normalizing third-party rejections that are not Error instances.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    rejected.executeTakeFirst.mockImplementationOnce(() => Promise.reject('non-error rejection'));
    const rejectedReporter = createJobProgressReporter(rejected.session, makeJob(), 'worker-1', {
      now: () => 0,
    });
    await expect(rejectedReporter.report({ progressBytes: 1n })).rejects.toBe(
      'non-error rejection',
    );
    await expect(rejectedReporter.flush()).rejects.toMatchObject({
      message: 'progress persistence failed',
      cause: 'non-error rejection',
    });
  });

  it('caps calculated speed at PostgreSQL bigint max', async () => {
    const setup = makeSession([{ progress_bytes: '9223372036854775807' }]);
    const reporter = createJobProgressReporter(setup.session, makeJob(), 'worker-1', {
      minIntervalMs: 1,
      now: () => 0,
    });
    await reporter.report({ progressBytes: 9_223_372_036_854_775_807n });
    expect(setup.set.mock.calls[0]?.[0]).toMatchObject({ speed_bps: 9_223_372_036_854_775_807n });
  });
});

describe('estimateJobEtaSeconds', () => {
  it('returns null for invalid, unknown or implausibly long estimates and zero when complete', () => {
    expect(estimateJobEtaSeconds(-1, 100, 10)).toBeNull();
    expect(estimateJobEtaSeconds(Number.MAX_SAFE_INTEGER + 1, 100, 10)).toBeNull();
    expect(estimateJobEtaSeconds('bad', 100, 10)).toBeNull();
    expect(estimateJobEtaSeconds(1, null, 10)).toBeNull();
    expect(estimateJobEtaSeconds(1, 10, null)).toBeNull();
    expect(estimateJobEtaSeconds(1, 10, 0)).toBeNull();
    expect(estimateJobEtaSeconds(10, 10, 1)).toBe(0);
    expect(estimateJobEtaSeconds(0, BigInt(MAX_JOB_ETA_SECONDS) + 1n, 1)).toBeNull();
  });

  it('uses ceiling division with bigint inputs beyond JavaScript safe integer range', () => {
    expect(estimateJobEtaSeconds('9007199254740993', '9007199254741000', '3')).toBe(3);
    expect(estimateJobEtaSeconds(0, 11, 5)).toBe(3);
  });
});
