import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { ActiveCountryJobRow } from '../../src/db/repositories/cache';
import type { CacheListOptions } from '../../src/db/repositories/cache';
import type {
  CatalogCachedVersionRow,
  CatalogCountryRow,
  CatalogPage,
} from '../../src/db/repositories/catalog';

const mocks = vi.hoisted(() => ({
  findCachedCountry:
    vi.fn<(trx: unknown, countryId: string) => Promise<CatalogCountryRow | null>>(),
  findMostRecentDownloads: vi.fn(
    (_trx: unknown, _countryIds: readonly string[]): Promise<Map<string, Date>> =>
      Promise.resolve(new Map()),
  ),
  listActiveCountryJobs: vi.fn(
    (_trx: unknown, _countryId: string): Promise<ActiveCountryJobRow[]> => Promise.resolve([]),
  ),
  listCachedCountries: vi.fn((_trx: unknown, _options: CacheListOptions): Promise<CatalogPage> =>
    Promise.resolve({ rows: [], total: '0' }),
  ),
  listCachedRegionVersions: vi.fn(
    (_trx: unknown, _countryId: string): Promise<CatalogCachedVersionRow[]> => Promise.resolve([]),
  ),
}));
vi.mock('../../src/db/repositories/cache', () => ({
  findCachedCountry: mocks.findCachedCountry,
  findMostRecentDownloads: mocks.findMostRecentDownloads,
  listActiveCountryJobs: mocks.listActiveCountryJobs,
  listCachedCountries: mocks.listCachedCountries,
}));
vi.mock('../../src/db/repositories/catalog', () => ({
  listCachedRegionVersions: mocks.listCachedRegionVersions,
}));

import { getCacheDetail, getCacheList } from '../../src/modules/admin/cache-route';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const VERSION_ID = '00000000-0000-4000-8000-000000000002';
const JOB_ID = '00000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-11-01T12:00:00Z');

function makeCountry(overrides: Partial<CatalogCountryRow> = {}): CatalogCountryRow {
  return {
    id: COUNTRY_ID,
    source: 'geofabrik',
    source_id: 'europe-finland',
    parent_id: 'europe',
    slug: 'finland',
    name: 'Finland',
    iso_alpha2: ['FI'],
    iso_other: ['FI', 'FIN'],
    source_pbf_url: null,
    source_size_hint_bytes: '20',
    catalog_synced_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    cache_country_id: COUNTRY_ID,
    is_public: true,
    public_since: NOW,
    update_state: 'update_available',
    available_version: '261102',
    available_size_bytes: '9007199254740992',
    available_at: NOW,
    update_checked_at: NOW,
    versions_ready_count: 2,
    total_size_bytes: '300',
    cache_created_at: NOW,
    cache_updated_at: NOW,
    ...overrides,
  };
}

function makeVersion(overrides: Partial<CatalogCachedVersionRow> = {}): CatalogCachedVersionRow {
  return {
    id: VERSION_ID,
    version: '261101',
    origin: 'geofabrik_snapshot',
    data_timestamp: NOW,
    file_size_bytes: '9007199254740992',
    checksum_md5: 'a'.repeat(32),
    created_at: NOW,
    ...overrides,
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
  return { request, database, transaction, trx };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCachedCountry.mockResolvedValue(makeCountry());
  mocks.findMostRecentDownloads.mockResolvedValue(new Map([[COUNTRY_ID, NOW]]));
  mocks.listActiveCountryJobs.mockResolvedValue([]);
  mocks.listCachedCountries.mockResolvedValue({ rows: [makeCountry()], total: '1' });
  mocks.listCachedRegionVersions.mockResolvedValue([makeVersion()]);
});

describe('admin cache list and detail handlers', () => {
  it('filters and pages cache rows using safe local-size sorting and download timestamps', async () => {
    const setup = makeRequest({
      q: ' Finland ',
      continent: 'europe',
      update: 'available',
      page: '2',
      limit: '10',
      sort: 'size',
      order: 'desc',
    });
    const response = await getCacheList(setup.request);
    expect(setup.transaction.setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(mocks.listCachedCountries.mock.calls[0]?.[1]).toEqual({
      search: 'Finland',
      continent: 'europe',
      updateAvailable: true,
      page: 2,
      limit: 10,
      sort: 'totalSizeBytes',
      order: 'desc',
    });
    expect(mocks.findMostRecentDownloads.mock.calls[0]?.[1]).toEqual([COUNTRY_ID]);
    expect(response.data[0]).toMatchObject({
      countryId: COUNTRY_ID,
      iso: ['FI', 'FIN'],
      sourceSizeHintBytes: 20,
      cache: {
        cached: true,
        totalSizeBytes: 300,
        availableSizeBytes: '9007199254740992',
      },
      lastCheckedAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      mostRecentDownloadAt: NOW.toISOString(),
    });
    expect(response.meta).toEqual({ page: 2, limit: 10, total: 1, totalPages: 1 });
  });

  it('supports all cache sort keys and represents absent dates and optional cache values safely', async () => {
    const sorts = [
      ['name', 'name'],
      ['size', 'totalSizeBytes'],
      ['updated', 'lastSyncedAt'],
      ['created', 'createdAt'],
    ] as const;
    for (const [sort, expected] of sorts) {
      await getCacheList(makeRequest({ sort }).request);
      expect(mocks.listCachedCountries.mock.calls.at(-1)?.[1].sort).toBe(expected);
    }

    mocks.listCachedCountries.mockResolvedValue({
      rows: [
        makeCountry({
          source_size_hint_bytes: null,
          is_public: null,
          update_state: null,
          versions_ready_count: null,
          total_size_bytes: null,
          available_size_bytes: null,
          update_checked_at: null,
          cache_created_at: NOW,
        }),
      ],
      total: '0',
    });
    mocks.findMostRecentDownloads.mockResolvedValue(new Map());
    const response = await getCacheList(makeRequest().request);
    expect(response.data[0]).toMatchObject({
      sourceSizeHintBytes: null,
      cache: {
        isPublic: false,
        updateState: 'unknown',
        versionsReady: 0,
        totalSizeBytes: 0,
        availableSizeBytes: null,
      },
      lastCheckedAt: null,
      mostRecentDownloadAt: null,
    });
  });

  it('rejects invalid list filters, missing cache dates and invalid persisted numbers', async () => {
    await expect(getCacheList(makeRequest({ unsafe: true }).request)).rejects.toThrow();
    mocks.listCachedCountries.mockResolvedValue({ rows: [], total: '-1' });
    await expect(getCacheList(makeRequest().request)).rejects.toThrow();

    mocks.listCachedCountries.mockResolvedValue({
      rows: [makeCountry({ cache_created_at: null })],
      total: '1',
    });
    await expect(getCacheList(makeRequest().request)).rejects.toThrow(
      'cached country is missing created_at',
    );

    mocks.listCachedCountries.mockResolvedValue({
      rows: [makeCountry({ total_size_bytes: '-1' })],
      total: '1',
    });
    await expect(getCacheList(makeRequest().request)).rejects.toThrow(
      'cache byte count is not a non-negative decimal integer',
    );
  });

  it('validates detail params, returns not found and maps versions and active jobs safely', async () => {
    const invalid = makeRequest({}, { countryId: 'bad' });
    await expect(getCacheDetail(invalid.request)).rejects.toThrow();
    expect(mocks.findCachedCountry).not.toHaveBeenCalled();

    mocks.findCachedCountry.mockResolvedValue(null);
    await expect(getCacheDetail(makeRequest().request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    mocks.findCachedCountry.mockResolvedValue(
      makeCountry({
        source_size_hint_bytes: null,
        is_public: null,
        public_since: null,
        update_state: null,
        available_version: null,
        available_size_bytes: null,
        available_at: null,
        update_checked_at: null,
        versions_ready_count: null,
        total_size_bytes: null,
      }),
    );
    mocks.listCachedRegionVersions.mockResolvedValue([
      makeVersion({ data_timestamp: null, checksum_md5: 'invalid-checksum' }),
    ]);
    mocks.listActiveCountryJobs.mockResolvedValue([
      {
        id: JOB_ID,
        type: 'download',
        status: 'running',
        progress_bytes: '10',
        total_bytes: null,
      },
    ]);
    const response = await getCacheDetail(makeRequest().request);
    expect(response.country).toMatchObject({ countryId: COUNTRY_ID, iso: ['FI', 'FIN'] });
    expect(response.cache).toMatchObject({
      isPublic: false,
      publicSince: null,
      totalSizeBytes: 0,
      versionsReady: 0,
      updateState: 'unknown',
      availableVersion: null,
      availableSizeBytes: null,
      updateCheckedAt: null,
    });
    expect(response.versions[0]).toMatchObject({
      id: VERSION_ID,
      dataTimestamp: null,
      sizeBytes: '9007199254740992',
      checksumMd5: null,
      status: 'ready',
    });
    expect(response.activeJobs[0]).toMatchObject({
      id: JOB_ID,
      progressBytes: 10,
      totalBytes: null,
    });
  });

  it('rejects invalid version bytes, invalid checksums and oversized totals before serialization', async () => {
    mocks.findCachedCountry.mockResolvedValue(makeCountry({ total_size_bytes: '-1' }));
    await expect(getCacheDetail(makeRequest().request)).rejects.toThrow(
      'cache byte count is not a non-negative decimal integer',
    );

    mocks.findCachedCountry.mockResolvedValue(makeCountry());
    mocks.listCachedRegionVersions.mockResolvedValue([makeVersion({ file_size_bytes: '-1' })]);
    await expect(getCacheDetail(makeRequest().request)).rejects.toThrow(
      'cache byte count is not a non-negative decimal integer',
    );
  });
});
