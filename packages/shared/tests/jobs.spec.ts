import { describe, expect, it } from 'vitest';

import {
  DownloadJobPayloadSchema,
  JobCancelRequestSchema,
  JobCancelResponseSchema,
  JobDetailResponseSchema,
  JobListQuerySchema,
  JobListResponseSchema,
  JobParamsSchema,
} from '../src';

const jobId = '00000000-0000-4000-8000-000000000001';
const countryId = '00000000-0000-4000-8000-000000000002';

const view = {
  id: jobId,
  type: 'download',
  status: 'running',
  phase: 'downloading',
  progressBytes: 1024,
  totalBytes: 2048,
  speedBps: 512,
  etaSeconds: 2,
  payload: { countryId, version: '261023' },
  updateCheckResult: null,
  cancelRequested: false,
  attempts: 1,
  maxAttempts: 3,
  createdAt: '2026-10-28T00:00:00.000Z',
  startedAt: '2026-10-28T00:00:01.000Z',
  finishedAt: null,
  error: null,
} as const;

describe('admin jobs contracts', () => {
  it('accepts only documented list filters and leaves pagination normalization to the shared parser', () => {
    expect(
      JobListQuerySchema.parse({ status: 'running', type: 'download', page: '2', limit: '25' }),
    ).toEqual({
      status: 'running',
      type: 'download',
      page: '2',
      limit: '25',
    });
    expect(JobListQuerySchema.safeParse({ status: 'active' }).success).toBe(false);
    expect(JobListQuerySchema.safeParse({ status: 'queued', ignored: 'yes' }).success).toBe(false);
  });

  it('accepts bounded interval retention snapshots on download job projections', () => {
    expect(
      DownloadJobPayloadSchema.parse({ countryId, version: 'latest', keepVersions: 1 }),
    ).toEqual({ countryId, version: 'latest', keepVersions: 1 });
    expect(
      DownloadJobPayloadSchema.safeParse({ countryId, version: 'latest', keepVersions: 0 }).success,
    ).toBe(false);
    expect(
      DownloadJobPayloadSchema.safeParse({ countryId, version: 'latest', keepVersions: 11 })
        .success,
    ).toBe(false);
  });

  it('validates UUID params and a strict empty cancellation body', () => {
    expect(JobParamsSchema.parse({ jobId })).toEqual({ jobId });
    expect(JobParamsSchema.safeParse({ jobId: 'not-a-uuid' }).success).toBe(false);
    expect(JobCancelRequestSchema.parse({})).toEqual({});
    expect(JobCancelRequestSchema.safeParse({ force: true }).success).toBe(false);
  });

  it('pins the same strict job projection for list and detail', () => {
    expect(JobDetailResponseSchema.parse(view)).toEqual(view);
    expect(
      JobListResponseSchema.parse({
        data: [view],
        meta: { page: 1, limit: 25, total: 1, totalPages: 1 },
      }).data,
    ).toEqual([view]);
    expect(
      JobDetailResponseSchema.safeParse({ ...view, lockedBy: 'internal-worker' }).success,
    ).toBe(false);
    expect(
      JobDetailResponseSchema.safeParse({ ...view, etaSeconds: 31 * 24 * 60 * 60 }).success,
    ).toBe(false);
  });

  it('accepts a cancellation acknowledgement for accepted work and a terminal no-op', () => {
    expect(
      JobCancelResponseSchema.parse({
        jobId,
        status: 'running',
        accepted: true,
        cancelRequested: true,
      }),
    ).toMatchObject({ status: 'running', accepted: true });
    expect(
      JobCancelResponseSchema.parse({
        jobId,
        status: 'succeeded',
        accepted: false,
        cancelRequested: false,
      }),
    ).toMatchObject({ status: 'succeeded', accepted: false });
  });
});
