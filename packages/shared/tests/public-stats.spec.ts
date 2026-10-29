import { describe, expect, it } from 'vitest';

import { PublicStatsQuerySchema, PublicStatsResponseSchema } from '../src/public-stats';

describe('public stats contract', () => {
  it('accepts an empty strict query and rejects unsupported filters', () => {
    expect(PublicStatsQuerySchema.parse({})).toEqual({});
    expect(PublicStatsQuerySchema.safeParse({ period: 'week' }).success).toBe(false);
  });

  it('accepts safe aggregate integers and nullable publication time, but no internal fields', () => {
    const response = {
      countries: 5,
      totalSizeBytes: 2_319_000_000,
      downloads30d: 128,
      totalDownloads: 1_420,
      lastPublishedAt: '2026-10-23T20:20:51.000Z',
    };
    expect(PublicStatsResponseSchema.parse(response)).toEqual(response);
    expect(
      PublicStatsResponseSchema.parse({ ...response, totalSizeBytes: '9007199254740992' }),
    ).toMatchObject({ totalSizeBytes: '9007199254740992' });
    expect(PublicStatsResponseSchema.parse({ ...response, lastPublishedAt: null })).toMatchObject({
      lastPublishedAt: null,
    });
    expect(
      PublicStatsResponseSchema.safeParse({ ...response, ipHash: 'must-not-leak' }).success,
    ).toBe(false);
    expect(PublicStatsResponseSchema.safeParse({ ...response, countries: -1 }).success).toBe(false);
  });
});
