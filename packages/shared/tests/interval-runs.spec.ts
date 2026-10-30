import { describe, expect, it } from 'vitest';

import {
  IntervalRunDetailResponseSchema,
  IntervalRunListQuerySchema,
  IntervalRunNowBodySchema,
  IntervalRunNowResponseSchema,
  IntervalRunViewSchema,
} from '../src';

const UUID = '00000000-0000-4000-8000-000000000001';

const run = {
  id: UUID,
  intervalId: UUID,
  intervalName: 'Daily Europe',
  triggeredBy: 'manual',
  status: 'partial',
  countriesTotal: 2,
  countriesOk: 1,
  countriesFailed: 1,
  countriesSkipped: 0,
  bytesDownloaded: 123,
  startedAt: '2026-10-30T03:00:00.000Z',
  finishedAt: '2026-10-30T03:01:00.000Z',
  durationMs: 60_000,
  errorMessage: 'One or more country downloads failed.',
} as const;

describe('interval run contracts', () => {
  it('requires manual run requests to be empty and validates accepted job IDs', () => {
    expect(IntervalRunNowBodySchema.parse({})).toEqual({});
    expect(IntervalRunNowBodySchema.safeParse({ force: true }).success).toBe(false);
    expect(IntervalRunNowResponseSchema.parse({ runId: UUID, jobIds: [UUID] })).toEqual({
      runId: UUID,
      jobIds: [UUID],
    });
  });

  it('keeps the partial aggregate status and country outcomes in the strict response contract', () => {
    expect(IntervalRunViewSchema.parse(run)).toEqual(run);
    expect(
      IntervalRunDetailResponseSchema.safeParse({
        run,
        items: [
          {
            id: UUID,
            countryId: UUID,
            countrySlug: 'finland',
            countryName: 'Finland',
            jobId: UUID,
            status: 'downloaded',
            version: '2026-10-27T00:00:00Z',
            bytes: 123,
            errorCode: null,
            errorMessage: null,
          },
        ],
      }).success,
    ).toBe(true);
    expect(IntervalRunViewSchema.safeParse({ ...run, status: 'almost-succeeded' }).success).toBe(
      false,
    );
  });

  it('accepts bounded-query inputs for the shared pagination normalizer and rejects unknown keys', () => {
    expect(IntervalRunListQuerySchema.safeParse({ page: '2', limit: '10' }).success).toBe(true);
    expect(IntervalRunListQuerySchema.safeParse({ page: '2', unknown: 'x' }).success).toBe(false);
  });
});
