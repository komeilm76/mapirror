import type { Kysely } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/db/schema';
import { startHousekeeping } from '../src/lib/housekeeping';

const log = { info: vi.fn(), warn: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('startHousekeeping', () => {
  it('runs immediately, repeats after failures, and stops scheduling before shutdown', async () => {
    vi.useFakeTimers();
    const database = {
      transaction: () => ({ execute: async () => Promise.reject(new Error('database offline')) }),
    } as unknown as Kysely<Database>;
    const housekeeping = startHousekeeping(database, log, { intervalMs: 1_000 });

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(2));

    await housekeeping.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('rejects a zero or fractional interval instead of creating a hot timer', () => {
    const database = {} as Kysely<Database>;
    expect(() => startHousekeeping(database, log, { intervalMs: 0 })).toThrow(RangeError);
    expect(() => startHousekeeping(database, log, { intervalMs: 1.5 })).toThrow(RangeError);
  });
});
