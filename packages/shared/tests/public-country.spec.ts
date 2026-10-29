import { describe, expect, it } from 'vitest';

import {
  PublicCountryDetailResponseSchema,
  PublicCountryParamsSchema,
  PublicCountryVersionsQuerySchema,
  PublicCountryVersionsResponseSchema,
} from '../src/public-country';

const license = {
  name: 'ODbL 1.0',
  attribution: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright',
  source: 'Geofabrik GmbH',
  sourceUrl: 'https://download.geofabrik.de',
};

const version = {
  version: '261023',
  dataTimestamp: '2026-10-22T20:19:04.000Z',
  sizeBytes: 773_465_008,
  checksumMd5: 'd41d8cd98f00b204e9800998ecf8427e',
  downloadUrl: '/_public/api/countries/finland/download?version=261023',
  isLatest: true,
};

describe('public country detail contracts', () => {
  it('accepts only catalog slugs and pagination query keys', () => {
    expect(PublicCountryParamsSchema.parse({ slug: 'finland' })).toEqual({ slug: 'finland' });
    expect(PublicCountryParamsSchema.safeParse({ slug: 'Finland' }).success).toBe(false);
    expect(PublicCountryVersionsQuerySchema.parse({ page: '2', limit: '10' })).toEqual({
      page: '2',
      limit: '10',
    });
    expect(PublicCountryVersionsQuerySchema.safeParse({ sort: 'name' }).success).toBe(false);
    expect(PublicCountryVersionsQuerySchema.safeParse({ extra: 'nope' }).success).toBe(false);
  });

  it('pins the public detail response and rejects internal fields', () => {
    const detail = {
      slug: 'finland',
      name: 'Finland',
      iso: ['FI'],
      versions: [version],
      latest: '261023',
      updatedAt: '2026-10-22T20:19:04.000Z',
      license,
    };
    expect(PublicCountryDetailResponseSchema.parse(detail)).toEqual(detail);
    expect(
      PublicCountryDetailResponseSchema.safeParse({ ...detail, versions: Array(101).fill(version) })
        .success,
    ).toBe(false);
    expect(
      PublicCountryDetailResponseSchema.safeParse({
        ...detail,
        versions: [{ ...version, storagePath: 'internal/path' }],
      }).success,
    ).toBe(false);
  });

  it('pins pagination metadata, source attribution, and safe version fields', () => {
    const response = {
      data: [version],
      meta: { page: 1, limit: 25, total: 1, totalPages: 1 },
      license,
    };
    expect(PublicCountryVersionsResponseSchema.parse(response)).toEqual(response);
    expect(
      PublicCountryVersionsResponseSchema.safeParse({
        ...response,
        data: [{ ...version, jobId: 'internal-job' }],
      }).success,
    ).toBe(false);
  });
});
