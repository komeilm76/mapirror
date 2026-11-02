import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { CatalogCountryRow } from '../../src/db/repositories/catalog';
import type { MapVersionPage } from '../../src/db/repositories/map-versions';

const mocks = vi.hoisted(() => ({
  findCachedCountry:
    vi.fn<(trx: unknown, countryId: string) => Promise<CatalogCountryRow | null>>(),
  listMapVersionsPage: vi.fn(
    (_trx: unknown, _countryId: string, _limit: number, _offset: number): Promise<MapVersionPage> =>
      Promise.resolve({ rows: [], total: '0' }),
  ),
}));
vi.mock('../../src/db/repositories/cache', () => ({
  findCachedCountry: mocks.findCachedCountry,
}));
vi.mock('../../src/db/repositories/map-versions', () => ({
  listMapVersionsPage: mocks.listMapVersionsPage,
}));

import { getCacheVersions } from '../../src/modules/admin/cache-versions-route';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const VERSION_ID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-01T12:00:00Z');

function makeCountry(): CatalogCountryRow {
  return {
    id: COUNTRY_ID,
    source: 'geofabrik',
    source_id: 'europe-finland',
    parent_id: 'europe',
    slug: 'finland',
    name: 'Finland',
    iso_alpha2: ['FI'],
    iso_other: ['FIN'],
    source_pbf_url: null,
    source_size_hint_bytes: null,
    catalog_synced_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    cache_country_id: COUNTRY_ID,
    is_public: false,
    public_since: null,
    update_state: 'unknown',
    available_version: null,
    available_size_bytes: null,
    available_at: null,
    update_checked_at: null,
    versions_ready_count: 1,
    total_size_bytes: '100',
    cache_created_at: NOW,
    cache_updated_at: NOW,
  };
}

function makeRequest(query: unknown = {}, params: unknown = { countryId: COUNTRY_ID }) {
  const trx = {};
  const transaction = {
    setIsolationLevel: vi.fn(),
    execute: vi.fn((callback: (trx: object) => Promise<unknown>) => callback(trx)),
  };
  transaction.setIsolationLevel.mockImplementation(() => transaction);
  const database = { transaction: vi.fn(() => transaction) };
  const request = {
    query,
    params,
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { countryId: string } }>;
  return { request, transaction, trx };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCachedCountry.mockResolvedValue(makeCountry());
  mocks.listMapVersionsPage.mockResolvedValue({
    rows: [
      {
        id: VERSION_ID,
        version: '261101',
        origin: 'geofabrik_snapshot',
        data_timestamp: NOW,
        file_size_bytes: '9007199254740992',
        checksum_md5: 'a'.repeat(32),
        status: 'ready',
        created_at: NOW,
      },
    ],
    total: '1',
  });
});

describe('getCacheVersions', () => {
  it('returns a bounded page with safe bigint and checksum projections', async () => {
    const setup = makeRequest({ page: '2', limit: '10' });
    const response = await getCacheVersions(setup.request);
    expect(setup.transaction.setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(mocks.listMapVersionsPage).toHaveBeenCalledWith(setup.trx, COUNTRY_ID, 10, 10);
    expect(response.data[0]).toMatchObject({
      id: VERSION_ID,
      version: '261101',
      origin: 'geofabrik_snapshot',
      dataTimestamp: NOW.toISOString(),
      sizeBytes: '9007199254740992',
      checksumMd5: 'a'.repeat(32),
      status: 'ready',
      createdAt: NOW.toISOString(),
    });
    expect(response.meta).toEqual({ page: 2, limit: 10, total: 1, totalPages: 1 });
  });

  it('uses the documented default page size and normalizes nullable or invalid version fields', async () => {
    mocks.listMapVersionsPage.mockResolvedValue({
      rows: [
        {
          id: VERSION_ID,
          version: 'upload-1',
          origin: 'upload',
          data_timestamp: null,
          file_size_bytes: '0',
          checksum_md5: 'not-md5',
          status: 'failed',
          created_at: NOW,
        },
      ],
      total: '0',
    });
    const response = await getCacheVersions(makeRequest().request);
    expect(mocks.listMapVersionsPage).toHaveBeenCalledWith(expect.anything(), COUNTRY_ID, 25, 0);
    expect(response.data[0]).toMatchObject({
      version: 'upload-1',
      dataTimestamp: null,
      sizeBytes: 0,
      checksumMd5: null,
      status: 'failed',
    });
  });

  it('rejects invalid params/query, missing cache countries and corrupt database values', async () => {
    await expect(getCacheVersions(makeRequest({}, { countryId: 'bad' }).request)).rejects.toThrow();
    await expect(getCacheVersions(makeRequest({ extra: true }).request)).rejects.toThrow();
    mocks.findCachedCountry.mockResolvedValue(null);
    await expect(getCacheVersions(makeRequest().request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    mocks.findCachedCountry.mockResolvedValue(makeCountry());
    mocks.listMapVersionsPage.mockResolvedValue({ rows: [], total: '-1' });
    await expect(getCacheVersions(makeRequest().request)).rejects.toThrow(
      'map version count is not a non-negative decimal integer',
    );

    mocks.listMapVersionsPage.mockResolvedValue({
      rows: [
        {
          id: VERSION_ID,
          version: '261101',
          origin: 'geofabrik_snapshot',
          data_timestamp: null,
          file_size_bytes: '-1',
          checksum_md5: null,
          status: 'ready',
          created_at: NOW,
        },
      ],
      total: '1',
    });
    await expect(getCacheVersions(makeRequest().request)).rejects.toThrow(
      'map version byte count is not a non-negative decimal integer',
    );
  });
});
