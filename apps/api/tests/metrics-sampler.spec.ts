import type { Kysely } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/db/schema';
import {
  cpuPercentBetween,
  startMetricsSampler,
  type CpuCounters,
  type MetricsReaders,
} from '../src/modules/system/metrics-sampler';

interface ConflictBuilder {
  column(name: string): { doNothing(): unknown };
}

function fakeDatabase(options: { failFirstWrite?: boolean } = {}) {
  const writes: unknown[] = [];
  let attempts = 0;
  const execute = vi.fn((values: unknown) => {
    attempts += 1;
    if (options.failFirstWrite === true && attempts === 1) {
      return Promise.reject(new Error('database unavailable'));
    }
    writes.push(values);
    return Promise.resolve();
  });
  const database = {
    insertInto: vi.fn(() => ({
      values: (values: unknown) => ({
        onConflict: (configure: (builder: ConflictBuilder) => unknown) => {
          configure({ column: () => ({ doNothing: () => undefined }) });
          return { execute: () => execute(values) };
        },
      }),
    })),
  } as unknown as Kysely<Database>;
  return { database, execute, writes };
}

function readers(overrides: Partial<MetricsReaders> = {}): MetricsReaders {
  return {
    readCpuCounters: () => ({ total: 2_000, idle: 1_500, cores: 4 }),
    readLoadAverage: () => [0.4, 0.3, 0.2],
    readMemory: () => ({ totalBytes: 2_000, freeBytes: 500 }),
    readDiskSpace: () => Promise.resolve({ freeBytes: 70n, totalBytes: 100n }),
    readCacheSize: () => Promise.resolve(25n),
    ...overrides,
  };
}

const log = { warn: vi.fn<(context: object, message: string) => void>() };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('CPU metric calculation', () => {
  it('reports busy percentage from cumulative counters and leaves invalid intervals unknown', () => {
    const before: CpuCounters = { total: 1_000, idle: 700, cores: 4 };
    expect(cpuPercentBetween(null, { total: 2_000, idle: 1_500, cores: 4 })).toBeNull();
    expect(cpuPercentBetween(before, { total: 1_200, idle: 800, cores: 4 })).toBe(50);
    expect(cpuPercentBetween(before, { total: 1_200, idle: 700, cores: 8 })).toBeNull();
    expect(cpuPercentBetween(before, { total: 900, idle: 800, cores: 4 })).toBeNull();
    expect(cpuPercentBetween(before, { total: 1_000, idle: 700, cores: 4 })).toBeNull();
  });
});

describe('startMetricsSampler', () => {
  it('writes an immediate timestamp-deduplicated sample and keeps available fields when disk measurement fails', async () => {
    const { database, writes } = fakeDatabase();
    const sampler = startMetricsSampler(database, '/cache', log, {
      intervalMs: 10_000,
      now: () => new Date('2026-10-31T12:34:56.789Z'),
      readers: readers({ readDiskSpace: () => Promise.reject(new Error('statfs unavailable')) }),
    });

    await sampler.stop();

    expect(writes).toEqual([
      {
        sampled_at: new Date('2026-10-31T12:34:56.000Z'),
        cpu_percent: null,
        load1: 0.4,
        load5: 0.3,
        load15: 0.2,
        mem_used_bytes: 1_500n,
        mem_total_bytes: 2_000n,
        disk_used_bytes: null,
        disk_total_bytes: null,
        cache_size_bytes: 25n,
      },
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      { failedReadings: ['disk'] },
      'some system metrics could not be read; nullable fields were stored',
    );
  });

  it('tolerates a failed write and retries on a later tick', async () => {
    vi.useFakeTimers();
    const { database, execute, writes } = fakeDatabase({ failFirstWrite: true });
    let notifyFirstWarning: () => void = () => undefined;
    const firstWarning = new Promise<void>((resolve) => {
      notifyFirstWarning = resolve;
    });
    const retryLog = {
      warn: vi.fn<(context: object, message: string) => void>((_context, message) => {
        if (message === 'system metrics sample failed; sampler will retry') notifyFirstWarning();
      }),
    };
    const sampler = startMetricsSampler(database, '/cache', retryLog, {
      intervalMs: 1_000,
      now: () => new Date('2026-10-31T12:34:56.000Z'),
      readers: readers(),
    });

    await firstWarning;
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toHaveLength(2);
    await sampler.stop();

    expect(execute).toHaveBeenCalledTimes(3);
    expect(retryLog.warn.mock.calls.map(([, message]) => message)).toContain(
      'system metrics sample failed; sampler will retry',
    );
    expect(retryLog.warn.mock.calls[0]?.[0]).toHaveProperty('err');
  });

  it('skips timer ticks during an in-flight sample and drains it on stop', async () => {
    vi.useFakeTimers();
    const { database, writes } = fakeDatabase();
    let diskReads = 0;
    let resolveDisk: ((space: { freeBytes: bigint; totalBytes: bigint }) => void) | undefined;
    const pendingDisk = new Promise<{ freeBytes: bigint; totalBytes: bigint }>((resolve) => {
      resolveDisk = resolve;
    });
    const sampler = startMetricsSampler(database, '/cache', log, {
      intervalMs: 1_000,
      readers: readers({
        readDiskSpace: () => {
          diskReads += 1;
          return pendingDisk;
        },
      }),
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(diskReads).toBe(1);
    let stopped = false;
    const stopping = sampler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveDisk?.({ freeBytes: 70n, totalBytes: 100n });
    await stopping;
    expect(writes).toHaveLength(1);
  });

  it('aligns periodic samples across instances started at different times', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T12:34:55.000Z'));
    const { database, writes } = fakeDatabase();
    const first = startMetricsSampler(database, '/cache', log, {
      intervalMs: 10_000,
      readers: readers(),
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(2_000);
    const second = startMetricsSampler(database, '/cache', log, {
      intervalMs: 10_000,
      readers: readers(),
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes).toHaveLength(4);
    expect(writes[2]).toMatchObject({ sampled_at: new Date('2026-10-31T12:35:00.000Z') });
    expect(writes[3]).toMatchObject({ sampled_at: new Date('2026-10-31T12:35:00.000Z') });
    await Promise.all([first.stop(), second.stop()]);
  });

  it('rejects a zero or fractional sampling interval', () => {
    const { database } = fakeDatabase();
    expect(() => startMetricsSampler(database, '/cache', log, { intervalMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => startMetricsSampler(database, '/cache', log, { intervalMs: 1.5 })).toThrow(
      RangeError,
    );
  });
});
