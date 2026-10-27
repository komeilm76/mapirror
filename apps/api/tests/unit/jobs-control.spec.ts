import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { Database, Job } from '../../src/db/schema';
import {
  createJobProgressReporter,
  estimateJobEtaSeconds,
  MAX_JOB_ETA_SECONDS,
} from '../../src/modules/jobs/progress';

describe('job progress and ETA', () => {
  it('rounds the remaining duration up to a whole second', () => {
    expect(estimateJobEtaSeconds(100n, 200n, 30n)).toBe(4);
    expect(estimateJobEtaSeconds(100n, 200n, 100n)).toBe(1);
  });

  it('keeps bigint precision beyond JavaScript safe integers', () => {
    expect(estimateJobEtaSeconds('9007199254740992', '9007199254741092', '10')).toBe(10);
  });

  it('reports zero only when complete and unknown when size or speed is unavailable', () => {
    expect(estimateJobEtaSeconds(200n, 200n, null)).toBe(0);
    expect(estimateJobEtaSeconds(10n, null, 1n)).toBeNull();
    expect(estimateJobEtaSeconds(10n, 20n, null)).toBeNull();
    expect(estimateJobEtaSeconds(10n, 20n, 0n)).toBeNull();
  });

  it('does not expose negative, unsafe-number, or implausibly long estimates', () => {
    expect(estimateJobEtaSeconds(-1n, 20n, 1n)).toBeNull();
    expect(estimateJobEtaSeconds(Number.MAX_SAFE_INTEGER + 1, 20n, 1n)).toBeNull();
    expect(estimateJobEtaSeconds(0n, BigInt(MAX_JOB_ETA_SECONDS) + 1n, 1n)).toBeNull();
  });

  it('rejects byte counters that cannot fit PostgreSQL bigint columns before touching the database', async () => {
    const reporter = createJobProgressReporter(
      {} as Kysely<Database>,
      { id: 'job-1', progress_bytes: '0' } as Job,
      'worker-1',
    );

    await expect(reporter.report({ progressBytes: 9_223_372_036_854_775_808n })).rejects.toThrow(
      'progressBytes must be a non-negative PostgreSQL bigint',
    );
    await expect(
      reporter.report({ progressBytes: 1n, totalBytes: 9_223_372_036_854_775_808n }),
    ).rejects.toThrow('totalBytes must be a non-negative PostgreSQL bigint');
    await reporter.stop();
  });
});
