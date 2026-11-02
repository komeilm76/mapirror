import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

const mocks = vi.hoisted(() => ({
  findPublicCountryBySlug: vi.fn(),
  listPublicCountries: vi.fn(),
  listPublicCountryVersions: vi.fn(),
}));
vi.mock('../../src/db/repositories/public-catalog', () => ({
  findPublicCountryBySlug: mocks.findPublicCountryBySlug,
  listPublicCountries: mocks.listPublicCountries,
  listPublicCountryVersions: mocks.listPublicCountryVersions,
}));

import {
  getPublicCountries,
  getPublicCountry,
  getPublicCountryVersions,
} from '../../src/modules/public/countries-route';

const COUNTRY = {
  country_id: 'country-id',
  slug: 'finland',
  name: 'Finland',
  continent: 'Europe',
  iso_alpha2: ['FI'],
  iso_other: ['FIN', 'FI'],
  newest_version: '261101',
  newest_data_timestamp: new Date('2026-11-01T00:00:00Z'),
  newest_ready_at: new Date('2026-11-01T00:01:00Z'),
  newest_size_bytes: '9007199254740993',
};

function makeRequest(query: unknown = {}, params: unknown = { slug: 'finland' }) {
  const execute = vi.fn((work: (trx: object) => Promise<unknown>) => work({}));
  const setIsolationLevel = vi.fn(() => ({ execute }));
  const transaction = vi.fn(() => ({ setIsolationLevel }));
  const request = {
    query,
    params,
    server: { db: { db: { transaction } } },
  } as unknown as FastifyRequest<{ Params: { slug: string } }>;
  return { request, transaction, setIsolationLevel, execute };
}

beforeEach(() => vi.resetAllMocks());

describe('public country catalog handlers', () => {
  it('lists visible countries with deduplicated ISO codes, exact sizes, and repeatable-read pagination', async () => {
    const setup = makeRequest({ q: 'finland', sort: 'size', page: '2', limit: '10' });
    mocks.listPublicCountries.mockResolvedValue({ rows: [COUNTRY], total: '21' });
    await expect(getPublicCountries(setup.request)).resolves.toMatchObject({
      data: [
        {
          slug: 'finland',
          iso: ['FI', 'FIN'],
          newestVersion: '261101',
          sizeBytes: '9007199254740993',
          downloadUrl: '/_public/api/countries/finland/download?version=latest',
        },
      ],
      meta: { page: 2, limit: 10, total: 21, totalPages: 3 },
    });
    expect(setup.setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(mocks.listPublicCountries).toHaveBeenCalledWith(expect.anything(), {
      search: 'finland',
      continent: undefined,
      sort: 'size',
      limit: 10,
      offset: 10,
    });
  });

  it('rejects malformed list queries and invalid database counts or byte totals', async () => {
    const invalid = makeRequest({ extra: 'not-allowed' });
    await expect(getPublicCountries(invalid.request)).rejects.toThrow();
    expect(mocks.listPublicCountries).not.toHaveBeenCalled();

    const badCount = makeRequest();
    mocks.listPublicCountries.mockResolvedValue({ rows: [], total: '01' });
    await expect(getPublicCountries(badCount.request)).rejects.toThrow(
      'public catalog row count is not a non-negative decimal integer',
    );

    const badSize = makeRequest();
    mocks.listPublicCountries.mockResolvedValue({
      rows: [{ ...COUNTRY, newest_size_bytes: '-1' }],
      total: '0',
    });
    await expect(getPublicCountries(badSize.request)).rejects.toThrow(
      'public catalog byte count is not a non-negative decimal integer',
    );
  });

  it('returns country details and only safe, validated version fields', async () => {
    const setup = makeRequest();
    mocks.findPublicCountryBySlug.mockResolvedValue(COUNTRY);
    mocks.listPublicCountryVersions.mockResolvedValue({
      rows: [
        {
          version: '261101',
          data_timestamp: COUNTRY.newest_data_timestamp,
          file_size_bytes: '10',
          checksum_md5: 'a'.repeat(32),
          ready_at: COUNTRY.newest_ready_at,
        },
        {
          version: 'old/version',
          data_timestamp: null,
          file_size_bytes: '20',
          checksum_md5: 'invalid',
          ready_at: null,
        },
      ],
      total: '2',
    });

    await expect(getPublicCountry(setup.request)).resolves.toMatchObject({
      slug: 'finland',
      iso: ['FI', 'FIN'],
      latest: '261101',
      versions: [
        { version: '261101', checksumMd5: 'a'.repeat(32), isLatest: true },
        {
          version: 'old/version',
          checksumMd5: null,
          isLatest: false,
          downloadUrl: '/_public/api/countries/finland/download?version=old%2Fversion',
        },
      ],
    });
    expect(mocks.listPublicCountryVersions).toHaveBeenCalledWith(expect.anything(), 'country-id', {
      limit: 100,
    });
  });

  it('maps malformed, missing, and unpublished country identities to the same not-found error', async () => {
    const malformed = makeRequest({}, { slug: '../finland' });
    await expect(getPublicCountry(malformed.request)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(malformed.transaction).not.toHaveBeenCalled();

    const missing = makeRequest();
    mocks.findPublicCountryBySlug.mockResolvedValue(null);
    await expect(getPublicCountry(missing.request)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('validates paginated version history and bounds the total count', async () => {
    const invalid = makeRequest({ limit: '0' });
    await expect(getPublicCountryVersions(invalid.request)).rejects.toThrow();
    expect(mocks.listPublicCountryVersions).not.toHaveBeenCalled();

    const valid = makeRequest({ page: '3', limit: '5' });
    mocks.findPublicCountryBySlug.mockResolvedValue(COUNTRY);
    mocks.listPublicCountryVersions.mockResolvedValue({ rows: [], total: '11' });
    await expect(getPublicCountryVersions(valid.request)).resolves.toMatchObject({
      data: [],
      meta: { page: 3, limit: 5, total: 11, totalPages: 3 },
    });
    expect(mocks.listPublicCountryVersions).toHaveBeenCalledWith(expect.anything(), 'country-id', {
      limit: 5,
      offset: 10,
    });

    mocks.listPublicCountryVersions.mockResolvedValue({ rows: [], total: '9007199254740992' });
    await expect(getPublicCountryVersions(valid.request)).rejects.toThrow(
      'public catalog row count exceeds the JSON safe integer range',
    );
  });
});
