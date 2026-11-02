import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { Job } from '../../src/db/schema';

const mocks = vi.hoisted(() => ({ requestJobCancellation: vi.fn() }));
vi.mock('../../src/modules/jobs/cancellation', () => ({
  requestJobCancellation: mocks.requestJobCancellation,
}));
vi.mock('kysely', () => ({ sql: () => ({ as: vi.fn() }) }));

import { getJob, getJobs } from '../../src/modules/admin/jobs-route';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const COUNTRY_ID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-01T12:00:00Z');

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    type: 'download',
    status: 'running',
    payload: {
      countryId: COUNTRY_ID,
      version: 'latest',
      origin: 'geofabrik_latest',
      keepVersions: 3,
      secret: 'must-not-leak',
    },
    phase: 'downloading',
    progress_bytes: '10',
    total_bytes: '100',
    speed_bps: '5',
    attempts: 1,
    max_attempts: 4,
    cancel_requested: false,
    created_at: NOW,
    started_at: NOW,
    finished_at: null,
    error_code: null,
    result: null,
    worker_id: 'hidden-worker',
    locked_at: NOW,
    heartbeat_at: NOW,
    available_at: NOW,
    ...overrides,
  } as Job;
}

function makeRequest(
  options: {
    query?: unknown;
    params?: unknown;
    row?: Job;
    missing?: boolean;
    rows?: Job[];
    total?: string;
  } = {},
) {
  const trx = {
    selectFrom: vi.fn(() => {
      let rowsSelection = false;
      const query = {
        select: vi.fn((columns: unknown) => {
          rowsSelection = Array.isArray(columns);
          return query;
        }),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn(() => query),
        offset: vi.fn(() => query),
        execute: vi.fn(() => Promise.resolve(rowsSelection ? (options.rows ?? [makeJob()]) : [])),
        executeTakeFirstOrThrow: vi.fn(() => Promise.resolve({ total: options.total ?? '1' })),
      };
      return query;
    }),
  };
  const transaction = {
    setIsolationLevel: vi.fn(),
    execute: vi.fn((callback: (trx: unknown) => Promise<unknown>) => callback(trx)),
  };
  transaction.setIsolationLevel.mockImplementation(() => transaction);
  const database = {
    transaction: vi.fn(() => transaction),
    selectFrom: vi.fn(() => {
      const query = {
        select: vi.fn(() => query),
        where: vi.fn(() => query),
        executeTakeFirst: vi.fn(() =>
          Promise.resolve(options.missing ? undefined : (options.row ?? makeJob())),
        ),
      };
      return query;
    }),
  };
  const request = {
    query: options.query ?? {},
    params: options.params ?? { jobId: JOB_ID },
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { jobId: string } }>;
  return { request, database, transaction, trx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin job read handlers', () => {
  it('filters and pages jobs while projecting safe payload, phase, ETA and error fields', async () => {
    const setup = makeRequest({
      query: { type: 'download', status: 'running', page: '2', limit: '10' },
      rows: [
        makeJob({
          error_code: 'WORKER_LOST',
          result: { private: true },
        }),
      ],
    });
    const response = await getJobs(setup.request);
    expect(setup.transaction.setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(response.data[0]).toMatchObject({
      id: JOB_ID,
      type: 'download',
      status: 'running',
      phase: 'downloading',
      progressBytes: 10,
      totalBytes: 100,
      speedBps: 5,
      etaSeconds: 18,
      payload: {
        countryId: COUNTRY_ID,
        version: 'latest',
        origin: 'geofabrik_latest',
        keepVersions: 3,
      },
      error: { code: 'WORKER_LOST', message: 'The worker stopped before this job completed.' },
    });
    expect(JSON.stringify(response)).not.toContain('must-not-leak');
    expect(JSON.stringify(response)).not.toContain('hidden-worker');
    expect(JSON.stringify(response)).not.toContain('private');
    expect(response.meta).toEqual({ page: 2, limit: 10, total: 1, totalPages: 1 });
  });

  it('returns safe nulls for malformed payloads and unknown phase/error values', async () => {
    const setup = makeRequest({
      rows: [
        makeJob({
          payload: ['not', 'an', 'object'] as unknown as Job['payload'],
          phase: 'unknown-phase',
          progress_bytes: '9007199254740992',
          total_bytes: null,
          speed_bps: null,
          cancel_requested: true,
          error_code: 'private exception',
        }),
      ],
    });
    const response = await getJobs(setup.request);
    expect(response.data[0]).toMatchObject({
      phase: null,
      progressBytes: '9007199254740992',
      totalBytes: null,
      speedBps: null,
      etaSeconds: null,
      payload: null,
      error: { code: 'JOB_HANDLER_FAILED', message: 'The job handler failed.' },
    });
  });

  it('validates list filters and rejects malformed or unsafe counts', async () => {
    await expect(getJobs(makeRequest({ query: { unexpected: true } }).request)).rejects.toThrow();
    await expect(getJobs(makeRequest({ total: '-1' }).request)).rejects.toThrow(
      'job row count is not a non-negative decimal integer',
    );
    await expect(getJobs(makeRequest({ total: '9007199254740992' }).request)).rejects.toThrow(
      'job row count exceeds the JSON safe integer range',
    );
  });

  it('validates detail params, returns not-found and maps update-check results through the schema', async () => {
    await expect(getJob(makeRequest({ params: { jobId: 'bad' } }).request)).rejects.toThrow();

    const missing = makeRequest({ missing: true });
    await expect(getJob(missing.request)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const validUpdate = makeRequest({
      row: makeJob({
        type: 'update_check',
        status: 'succeeded',
        phase: null,
        payload: { countryIds: [COUNTRY_ID] },
        result: { total: 2, checked: 1, updateAvailable: 0, upToDate: 1, unknown: 0, skipped: 1 },
        total_bytes: null,
        speed_bps: null,
        finished_at: NOW,
      }),
    });
    await expect(getJob(validUpdate.request)).resolves.toMatchObject({
      payload: { countryIds: [COUNTRY_ID] },
      updateCheckResult: { checked: 1, upToDate: 1, updateAvailable: 0, unknown: 0 },
      finishedAt: NOW.toISOString(),
    });

    const invalidUpdate = makeRequest({
      row: makeJob({ type: 'update_check', payload: {}, result: { secret: 'omitted' } }),
    });
    await expect(getJob(invalidUpdate.request)).resolves.toMatchObject({
      updateCheckResult: null,
    });
  });
});
