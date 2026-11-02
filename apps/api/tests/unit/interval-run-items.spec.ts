import { describe, expect, it, vi } from 'vitest';

import type { RepositoryExecutor } from '../../src/db/repositories/executor';
import {
  finalizeIntervalRunItem,
  type IntervalRunItemOutcome,
} from '../../src/modules/intervals/run-items';

function makeExecutor(changed: { run_id: string } | undefined, counts: Record<string, unknown>) {
  const itemUpdate = {
    set: vi.fn((_values: unknown) => itemUpdate),
    where: vi.fn(() => itemUpdate),
    returning: vi.fn(() => itemUpdate),
    executeTakeFirst: vi.fn(() => Promise.resolve(changed)),
  };
  const runUpdate = {
    set: vi.fn((_values: unknown) => runUpdate),
    where: vi.fn(() => runUpdate),
    execute: vi.fn(() => Promise.resolve()),
  };
  const selectQuery = {
    select: vi.fn(() => selectQuery),
    where: vi.fn(() => selectQuery),
    executeTakeFirstOrThrow: vi.fn(() => Promise.resolve(counts)),
  };
  const updates = [itemUpdate, runUpdate];
  const executor = {
    updateTable: vi.fn(() => updates.shift()),
    selectFrom: vi.fn(() => selectQuery),
  } as unknown as RepositoryExecutor;
  return { executor, itemUpdate, runUpdate, selectQuery };
}

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000002';
const BASE_COUNTS = {
  queued: 0,
  downloaded: 0,
  failed: 0,
  skipped: 0,
  bytes: '0',
};

async function finalize(outcome: IntervalRunItemOutcome, counts = BASE_COUNTS) {
  const setup = makeExecutor({ run_id: RUN_ID }, counts);
  await finalizeIntervalRunItem(setup.executor, JOB_ID, outcome);
  return setup;
}

describe('interval country-item finalization', () => {
  it('does nothing when the linked item is absent or no longer queued', async () => {
    const { executor, itemUpdate, runUpdate, selectQuery } = makeExecutor(undefined, BASE_COUNTS);

    await finalizeIntervalRunItem(executor, JOB_ID, {
      status: 'downloaded',
      bytes: '99',
      version: '20261031',
    });

    expect(itemUpdate.where).toHaveBeenCalledWith('status', '=', 'queued');
    expect(selectQuery.executeTakeFirstOrThrow).not.toHaveBeenCalled();
    expect(runUpdate.set).not.toHaveBeenCalled();
  });

  it('stores downloaded metadata and keeps the aggregate running while other countries remain queued', async () => {
    const { itemUpdate, runUpdate } = await finalize(
      { status: 'downloaded', bytes: '2048', version: '20261031' },
      { ...BASE_COUNTS, queued: 1, downloaded: 2, bytes: '4096' },
    );

    expect(itemUpdate.set).toHaveBeenCalledWith({
      status: 'downloaded',
      bytes: '2048',
      version: '20261031',
      error_code: null,
      error_message: null,
    });
    expect(runUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        countries_total: 3,
        countries_ok: 2,
        countries_failed: 0,
        countries_skipped: 0,
        bytes_downloaded: '4096',
      }),
    );
    expect(runUpdate.set.mock.calls[0]?.[0]).not.toHaveProperty('finished_at');
  });

  it('stores failures with zero bytes and completes an all-failed run', async () => {
    const { itemUpdate, runUpdate } = await finalize(
      { status: 'failed', errorCode: 'JOB_HANDLER_FAILED', errorMessage: 'Please retry later.' },
      { ...BASE_COUNTS, failed: 2, bytes: '0' },
    );

    expect(itemUpdate.set).toHaveBeenCalledWith({
      status: 'failed',
      bytes: 0n,
      version: null,
      error_code: 'JOB_HANDLER_FAILED',
      error_message: 'Please retry later.',
    });
    expect(runUpdate.set.mock.calls[0]?.[0]).toMatchObject({
      status: 'failed',
      countries_total: 2,
      countries_ok: 0,
      countries_failed: 2,
      countries_skipped: 0,
      bytes_downloaded: '0',
      error_message: 'All country downloads failed.',
    });
    expect(runUpdate.set.mock.calls[0]?.[0]).toHaveProperty('finished_at');
  });

  it('retains skipped version/error details and marks a mixed terminal run partial', async () => {
    const { itemUpdate, runUpdate, selectQuery } = await finalize(
      {
        status: 'skipped',
        version: '20261031',
        errorCode: 'UNCHANGED_SOURCE',
        errorMessage: 'The cached version is current.',
      },
      { ...BASE_COUNTS, downloaded: 1, failed: 1, skipped: 1, bytes: '4096' },
    );

    expect(itemUpdate.set).toHaveBeenCalledWith({
      status: 'skipped',
      bytes: 0n,
      version: '20261031',
      error_code: 'UNCHANGED_SOURCE',
      error_message: 'The cached version is current.',
    });
    expect(selectQuery.executeTakeFirstOrThrow).toHaveBeenCalledTimes(1);
    expect(runUpdate.set.mock.calls[0]?.[0]).toMatchObject({
      status: 'partial',
      countries_total: 3,
      countries_ok: 1,
      countries_failed: 1,
      countries_skipped: 1,
      bytes_downloaded: '4096',
      error_message: 'One or more country downloads failed.',
    });
  });

  it('marks a clean terminal run succeeded and clears the aggregate error', async () => {
    const { runUpdate } = await finalize(
      { status: 'downloaded', bytes: '512', version: null },
      { ...BASE_COUNTS, downloaded: 1, bytes: '512' },
    );

    expect(runUpdate.set.mock.calls[0]?.[0]).toMatchObject({
      status: 'succeeded',
      countries_total: 1,
      countries_ok: 1,
      countries_failed: 0,
      countries_skipped: 0,
      bytes_downloaded: '512',
      error_message: null,
    });
    expect(runUpdate.set.mock.calls[0]?.[0]).toHaveProperty('finished_at');
  });
});
