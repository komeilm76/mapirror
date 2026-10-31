import { describe, expect, it, vi } from 'vitest';

import {
  createMetricsReaders,
  startMetricsSampler,
} from '../../src/modules/system/metrics-sampler';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('persisted metrics samples', () => {
  it('persists process readings and ignores a duplicate sample in the same second', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const country = await db
          .insertInto('countries')
          .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await db
          .insertInto('country_cache')
          .values({ country_id: country.id, total_size_bytes: '725' })
          .execute();

        const defaultReaders = createMetricsReaders(db);
        const readers = {
          ...defaultReaders,
          readCpuCounters: () => ({ total: 2_000, idle: 1_500, cores: 4 }),
          readLoadAverage: () => [0.25, 0.5, 0.75],
          readMemory: () => ({ totalBytes: 4_000, freeBytes: 1_000 }),
          readDiskSpace: () => Promise.resolve({ freeBytes: 40n, totalBytes: 100n }),
        };
        const now = () => new Date('2026-10-31T12:34:56.789Z');
        const log = { warn: vi.fn() };

        const first = startMetricsSampler(db, '/unused', log, { now, readers });
        await first.stop();
        const restarted = startMetricsSampler(db, '/unused', log, { now, readers });
        await restarted.stop();

        const samples = await db.selectFrom('metrics_samples').selectAll().execute();
        expect(samples).toEqual([
          {
            sampled_at: new Date('2026-10-31T12:34:56.000Z'),
            cpu_percent: null,
            load1: 0.25,
            load5: 0.5,
            load15: 0.75,
            mem_used_bytes: '3000',
            mem_total_bytes: '4000',
            disk_used_bytes: '60',
            disk_total_bytes: '100',
            cache_size_bytes: '725',
          },
        ]);
        expect(log.warn).not.toHaveBeenCalled();
      },
      { prefix: 'metrics', migrate: true },
    );
  });
});
