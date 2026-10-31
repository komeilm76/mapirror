import { describe, expect, it, vi } from 'vitest';

import type { Job } from '../src/db/schema';
import { UpdateCheckNotCachedError, type UpdateChecker } from '../src/modules/updates/update-check';
import { createUpdateCheckHandler } from '../src/modules/jobs/update-check-handler';
import type { JobHandlerContext } from '../src/modules/jobs/worker';

function makeContext(countryIds: readonly string[]) {
  const execute = vi.fn(() => Promise.resolve(countryIds.map((country_id) => ({ country_id }))));
  const query = {
    select: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    where: vi.fn(() => query),
    execute,
  };
  const database = { selectFrom: vi.fn(() => query) } as unknown as JobHandlerContext['database'];
  const reportProgress = vi.fn(() => Promise.resolve());
  return {
    context: {
      database,
      signal: new AbortController().signal,
      reportProgress,
    } as JobHandlerContext,
    execute,
    reportProgress,
  };
}

function makeJob(payload: Job['payload']): Job {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'update_check',
    status: 'running',
    priority: 0,
    payload,
    result: null,
    created_by: null,
    created_at: new Date('2026-10-31T00:00:00.000Z'),
    run_after: new Date('2026-10-31T00:00:00.000Z'),
    started_at: new Date('2026-10-31T00:00:00.000Z'),
    finished_at: null,
    locked_by: 'worker',
    locked_at: new Date('2026-10-31T00:00:00.000Z'),
    cancel_requested: false,
    attempts: 1,
    max_attempts: 3,
    progress_bytes: '0',
    total_bytes: null,
    speed_bps: null,
    phase: null,
    error_code: null,
    error_message: null,
  };
}

function checkedResult(state: 'update_available' | 'up_to_date' | 'unknown') {
  return {
    state,
    availableVersion: null,
    availableSizeBytes: null,
    availableAt: null,
    reason: null,
    cached: { version: null, dataTimestamp: null, sizeBytes: null },
    source: null,
    checkedAt: new Date('2026-10-31T00:00:00.000Z'),
  } as const;
}

describe('bulk update-check handler', () => {
  it('checks every cached country and aggregates all three outcomes with count-based progress', async () => {
    const ids = ['country-a', 'country-b', 'country-c'];
    const { context, reportProgress } = makeContext(ids);
    const check = vi.fn((countryId: string) =>
      Promise.resolve(
        checkedResult(
          countryId === ids[0]
            ? 'update_available'
            : countryId === ids[1]
              ? 'up_to_date'
              : 'unknown',
        ),
      ),
    );
    const checker = { check } as unknown as UpdateChecker;
    const handler = createUpdateCheckHandler({ checker });

    const result = await handler(makeJob({}), context);

    expect(result).toEqual({
      total: 3,
      checked: 3,
      updateAvailable: 1,
      upToDate: 1,
      unknown: 1,
      skipped: 0,
    });
    expect(check).toHaveBeenCalledTimes(3);
    expect(reportProgress).toHaveBeenLastCalledWith({ progressBytes: 3n, totalBytes: 3n });
  });

  it('counts requested ids removed after admission as skipped and does not fail the aggregate', async () => {
    const ids = ['00000000-0000-4000-8000-000000000001'];
    const missingId = '00000000-0000-4000-8000-000000000002';
    const { context } = makeContext(ids);
    const checker = {
      check: vi.fn(() => Promise.resolve(checkedResult('up_to_date'))),
    } as unknown as UpdateChecker;
    const handler = createUpdateCheckHandler({ checker });

    const result = await handler(makeJob({ countryIds: [ids[0]!, missingId] }), context);

    expect(result).toEqual({
      total: 2,
      checked: 1,
      updateAvailable: 0,
      upToDate: 1,
      unknown: 0,
      skipped: 1,
    });
  });

  it('treats a cache removed during checking as skipped while other failures remain retryable', async () => {
    const ids = ['country-a', 'country-b'];
    const { context } = makeContext(ids);
    const checker = {
      check: vi.fn((countryId: string) =>
        countryId === 'country-a'
          ? Promise.reject(new UpdateCheckNotCachedError(countryId))
          : Promise.resolve(checkedResult('unknown')),
      ),
    } as unknown as UpdateChecker;
    const result = await createUpdateCheckHandler({ checker })(makeJob({}), context);
    expect(result).toMatchObject({ total: 2, checked: 1, unknown: 1, skipped: 1 });

    const failingChecker = {
      check: vi.fn(() => Promise.reject(new Error('database failed'))),
    } as unknown as UpdateChecker;
    await expect(
      createUpdateCheckHandler({ checker: failingChecker })(makeJob({}), context),
    ).rejects.toThrow('database failed');
  });
});
