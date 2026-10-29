import { describe, expect, it } from 'vitest';

import { PublicCountryDownloadQuerySchema } from '../src/public-download';

describe('public country download query contract', () => {
  it('defaults to latest when omitted and accepts latest or a safe version label', () => {
    expect(PublicCountryDownloadQuerySchema.parse({})).toEqual({});
    expect(PublicCountryDownloadQuerySchema.parse({ version: 'latest' })).toEqual({
      version: 'latest',
    });
    expect(PublicCountryDownloadQuerySchema.parse({ version: '261023' })).toEqual({
      version: '261023',
    });
    expect(
      PublicCountryDownloadQuerySchema.parse({ version: 'latest@2026-10-23T20-20-51Z' }),
    ).toEqual({
      version: 'latest@2026-10-23T20-20-51Z',
    });
  });

  it('rejects unsafe version values and unknown query keys', () => {
    for (const version of ['', '../private', 'x'.repeat(65)]) {
      expect(PublicCountryDownloadQuerySchema.safeParse({ version }).success).toBe(false);
    }
    expect(PublicCountryDownloadQuerySchema.safeParse({ version: ['261023'] }).success).toBe(false);
    expect(PublicCountryDownloadQuerySchema.safeParse({ cache: 'no' }).success).toBe(false);
  });
});
