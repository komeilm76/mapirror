import { describe, expect, it } from 'vitest';

import {
  CacheBulkUpdateCheckRequestSchema,
  CacheBulkUpdateCheckResponseSchema,
  CacheUpdateCheckRequestSchema,
  CacheUpdateCheckResponseSchema,
  UpdateCheckJobResultSchema,
} from '../src';

const countryId = '00000000-0000-4000-8000-000000000001';
const jobId = '00000000-0000-4000-8000-000000000002';

describe('cache update-check contracts', () => {
  it('accepts strict inline and optional bulk requests', () => {
    expect(CacheUpdateCheckRequestSchema.parse({})).toEqual({});
    expect(CacheUpdateCheckRequestSchema.safeParse({ anything: true }).success).toBe(false);
    expect(CacheBulkUpdateCheckRequestSchema.parse({})).toEqual({});
    expect(CacheBulkUpdateCheckRequestSchema.parse({ countryIds: [countryId] })).toEqual({
      countryIds: [countryId],
    });
    expect(CacheBulkUpdateCheckRequestSchema.safeParse({ countryIds: [] }).success).toBe(false);
    expect(
      CacheBulkUpdateCheckRequestSchema.safeParse({ countryIds: [countryId, countryId] }).success,
    ).toBe(false);
    expect(
      CacheBulkUpdateCheckRequestSchema.safeParse({ countryIds: [countryId], extra: 1 }).success,
    ).toBe(false);
  });

  it('keeps a failed source explicitly unknown and validates safe identity fields', () => {
    expect(
      CacheUpdateCheckResponseSchema.parse({
        state: 'unknown',
        cached: { version: '261023', dataTimestamp: null, sizeBytes: '9007199254740993' },
        source: null,
        checkedAt: '2026-10-31T00:00:00.000Z',
        reason: 'The map source could not be checked.',
      }).state,
    ).toBe('unknown');
    expect(
      CacheUpdateCheckResponseSchema.safeParse({
        state: 'up_to_date',
        cached: { version: null, dataTimestamp: null, sizeBytes: null },
        source: null,
        checkedAt: '2026-10-31T00:00:00.000Z',
        reason: null,
        leaked: 'no',
      }).success,
    ).toBe(false);
  });

  it('validates accepted ids and internally consistent bulk aggregates', () => {
    expect(CacheBulkUpdateCheckResponseSchema.parse({ jobId })).toEqual({ jobId });
    const result = {
      total: 4,
      checked: 3,
      updateAvailable: 1,
      upToDate: 1,
      unknown: 1,
      skipped: 1,
    };
    expect(UpdateCheckJobResultSchema.parse(result)).toEqual(result);
    expect(UpdateCheckJobResultSchema.safeParse({ ...result, skipped: 0 }).success).toBe(false);
  });
});
