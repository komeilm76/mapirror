import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database } from '../../src/db/schema';
import { withCacheCountryMutationLock } from '../../src/modules/admin/cache-mutation-lock';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), cacheCountryAdvisoryLockKey: vi.fn() }));
vi.mock('kysely', () => ({ sql: () => ({ execute: mocks.execute }) }));
vi.mock('../../src/db/repositories/cache', () => ({
  cacheCountryAdvisoryLockKey: mocks.cacheCountryAdvisoryLockKey,
}));

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const LOGGER = { warn: vi.fn() };
const CONNECTION = {} as Kysely<Database>;

afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cacheCountryAdvisoryLockKey.mockReturnValue('cache-country-lock');
});

describe('withCacheCountryMutationLock', () => {
  it('acquires, runs cleanup, and releases the session lock', async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const mutation = vi.fn(() => Promise.resolve('result'));
    await expect(
      withCacheCountryMutationLock(CONNECTION, COUNTRY_ID, LOGGER, mutation),
    ).resolves.toBe('result');
    expect(mocks.cacheCountryAdvisoryLockKey).toHaveBeenCalledWith(COUNTRY_ID);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mutation).toHaveBeenCalledOnce();
    expect(LOGGER.warn).not.toHaveBeenCalled();
  });

  it('polls a busy lock, honors cancellation, and rejects when the bounded wait expires', async () => {
    vi.useFakeTimers();
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ locked: false }] })
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const work = withCacheCountryMutationLock(CONNECTION, COUNTRY_ID, LOGGER, () =>
      Promise.resolve(7),
    );
    await vi.advanceTimersByTimeAsync(50);
    await expect(work).resolves.toBe(7);

    mocks.execute.mockReset();
    mocks.execute.mockResolvedValue({ rows: [{ locked: false }] });
    const timeout = withCacheCountryMutationLock(CONNECTION, COUNTRY_ID, LOGGER, () =>
      Promise.resolve(0),
    );
    const timeoutAssertion = expect(timeout).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });
    await vi.advanceTimersByTimeAsync(5_000);
    await timeoutAssertion;
    expect(mocks.execute).toHaveBeenCalledTimes(100);

    const controller = new AbortController();
    controller.abort(new Error('stop waiting'));
    const beforeCalls = mocks.execute.mock.calls.length;
    await expect(
      withCacheCountryMutationLock(
        CONNECTION,
        COUNTRY_ID,
        LOGGER,
        () => Promise.resolve(0),
        controller.signal,
      ),
    ).rejects.toThrow('stop waiting');
    expect(mocks.execute).toHaveBeenCalledTimes(beforeCalls);

    const nonErrorReason = new AbortController();
    nonErrorReason.abort('non-error reason');
    await expect(
      withCacheCountryMutationLock(
        CONNECTION,
        COUNTRY_ID,
        LOGGER,
        () => Promise.resolve(0),
        nonErrorReason.signal,
      ),
    ).rejects.toThrow('Cache mutation canceled.');

    const canceledAtDeadline = new AbortController();
    mocks.execute.mockResolvedValue({ rows: [{ locked: false }] });
    const canceledWait = withCacheCountryMutationLock(
      CONNECTION,
      COUNTRY_ID,
      LOGGER,
      () => Promise.resolve(0),
      canceledAtDeadline.signal,
    );
    const canceledAssertion = expect(canceledWait).rejects.toThrow('cancel at timeout deadline');
    setTimeout(() => canceledAtDeadline.abort(new Error('cancel at timeout deadline')), 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await canceledAssertion;
  });

  it('releases after a mutation error and logs unlock failures without replacing the result', async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockRejectedValueOnce(new Error('unlock failed'));
    await expect(
      withCacheCountryMutationLock(CONNECTION, COUNTRY_ID, LOGGER, () =>
        Promise.reject(new Error('mutation failed')),
      ),
    ).rejects.toThrow('mutation failed');
    expect(LOGGER.warn.mock.calls[0]?.[0]).toMatchObject({ countryLock: 'cache-country-lock' });
    expect(LOGGER.warn.mock.calls[0]?.[1]).toBe(
      'could not explicitly release cache-mutation advisory lock; connection teardown will release it',
    );
  });

  it('warns when the lock was not held at release and stops on acquire errors', async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: false }] });
    await expect(
      withCacheCountryMutationLock(CONNECTION, COUNTRY_ID, LOGGER, () =>
        Promise.resolve(undefined),
      ),
    ).resolves.toBeUndefined();
    expect(LOGGER.warn).toHaveBeenCalledWith(
      { countryLock: 'cache-country-lock' },
      'cache mutation advisory lock was not held at release',
    );

    mocks.execute.mockReset();
    mocks.execute.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      withCacheCountryMutationLock(CONNECTION, COUNTRY_ID, LOGGER, () =>
        Promise.resolve(undefined),
      ),
    ).rejects.toThrow('database unavailable');
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
});
