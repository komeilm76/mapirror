import { describe, expect, it } from 'vitest';

import { CacheDownloadRequestSchema, CacheDownloadResponseSchema } from '../src';

const countryId = '00000000-0000-4000-8000-000000000001';
const jobId = '00000000-0000-4000-8000-000000000002';

describe('cache download contracts', () => {
  it('accepts strict latest and six-digit dated requests', () => {
    expect(CacheDownloadRequestSchema.parse({ countryId, version: 'latest' })).toEqual({
      countryId,
      version: 'latest',
    });
    expect(CacheDownloadRequestSchema.parse({ countryId, version: '261023' })).toEqual({
      countryId,
      version: '261023',
    });
    expect(
      CacheDownloadRequestSchema.safeParse({ countryId, version: '261023', extra: true }).success,
    ).toBe(false);
  });

  it('rejects malformed identities and version labels', () => {
    for (const value of [
      { countryId: 'not-a-uuid', version: 'latest' },
      { countryId, version: '26010' },
      { countryId, version: '2026-10-23' },
      { countryId, version: 'latest', extra: false },
    ]) {
      expect(CacheDownloadRequestSchema.safeParse(value).success).toBe(false);
    }
  });

  it('accepts dated or not-yet-resolved latest response identities only', () => {
    expect(CacheDownloadResponseSchema.parse({ jobId, resolvedVersion: '261023' })).toEqual({
      jobId,
      resolvedVersion: '261023',
    });
    expect(CacheDownloadResponseSchema.parse({ jobId, resolvedVersion: null })).toEqual({
      jobId,
      resolvedVersion: null,
    });
    expect(
      CacheDownloadResponseSchema.safeParse({ jobId, resolvedVersion: 'latest' }).success,
    ).toBe(false);
  });
});
