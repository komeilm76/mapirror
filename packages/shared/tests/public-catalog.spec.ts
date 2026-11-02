import { describe, expect, it } from 'vitest';

import { PublicCountriesQuerySchema, PublicCountriesResponseSchema } from '../src/public-catalog';

describe('public catalog contracts', () => {
  it('accepts only the documented query keys and public sort vocabulary', () => {
    expect(
      PublicCountriesQuerySchema.parse({
        q: ' finland ',
        continent: ' europe ',
        page: '2',
        sort: 'updated',
      }),
    ).toEqual({ q: 'finland', continent: 'europe', page: '2', sort: 'updated' });
    for (const query of [
      { order: 'desc' },
      { sort: 'created' },
      { continent: '' },
      { q: 'x'.repeat(129) },
      { q: 'fin\u0000land' },
      { continent: 'europe\u0000' },
      { extra: 'nope' },
    ]) {
      expect(PublicCountriesQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it('pins the public-safe list projection, pagination envelope, and ODbL attribution', () => {
    const response = {
      data: [
        {
          slug: 'finland',
          name: 'Finland',
          continent: 'europe',
          iso: ['FI'],
          newestVersion: '261023',
          sizeBytes: '9007199254740993',
          updatedAt: '2026-10-22T20:19:04.000Z',
          downloadUrl: '/_public/api/countries/finland/download?version=latest',
        },
      ],
      meta: { page: 1, limit: 25, total: 1, totalPages: 1 },
      license: {
        name: 'ODbL 1.0',
        attribution: '© OpenStreetMap contributors',
        url: 'https://www.openstreetmap.org/copyright',
      },
    };
    expect(PublicCountriesResponseSchema.parse(response)).toEqual(response);
    for (const field of [
      'countryId',
      'storage_path',
      'jobId',
      'job_id',
      'adminId',
      'admin_id',
      'ip',
      'ipHash',
      'ip_hash',
    ]) {
      expect(
        PublicCountriesResponseSchema.safeParse({
          ...response,
          data: [{ ...response.data[0], [field]: 'internal-value' }],
        }).success,
        field,
      ).toBe(false);
    }
  });
});
