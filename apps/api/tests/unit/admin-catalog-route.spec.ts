import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { CatalogListOptions, CatalogPage } from '../../src/db/repositories/catalog';
import type { CatalogCountryRow } from '../../src/db/repositories/catalog';

const mocks = vi.hoisted(() => ({
  findCatalogSyncedAt: vi.fn<(executor: unknown) => Promise<Date | null>>(),
  listCatalogCountries: vi.fn(
    (_executor: unknown, _options: CatalogListOptions): Promise<CatalogPage> =>
      Promise.resolve({ rows: [], total: '0' }),
  ),
}));
vi.mock('../../src/db/repositories/catalog', () => ({
  findCatalogSyncedAt: mocks.findCatalogSyncedAt,
  listCatalogCountries: mocks.listCatalogCountries,
}));

import { getCatalog } from '../../src/modules/admin/catalog-route';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const SYNCED_AT = new Date('2026-11-01T12:00:00Z');

function makeRow(overrides: Partial<CatalogCountryRow> = {}): CatalogCountryRow {
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
    catalog_synced_at: SYNCED_AT,
    created_at: SYNCED_AT,
    updated_at: SYNCED_AT,
    cache_country_id: null,
    is_public: null,
    public_since: null,
    update_state: null,
    available_version: null,
    available_size_bytes: null,
    available_at: null,
    update_checked_at: null,
    versions_ready_count: null,
    total_size_bytes: null,
    cache_created_at: null,
    cache_updated_at: null,
    ...overrides,
  };
}

function makeRequest(query: unknown = {}) {
  const trx = {};
  const transaction = {
    setIsolationLevel: vi.fn(),
    execute: vi.fn((callback: (trx: object) => Promise<unknown>) => callback(trx)),
  };
  transaction.setIsolationLevel.mockImplementation(() => transaction);
  const database = { transaction: vi.fn(() => transaction) };
  const request = {
    query,
    server: { db: { db: database } },
  } as unknown as FastifyRequest;
  return { request, database, transaction, trx };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCatalogSyncedAt.mockResolvedValue(SYNCED_AT);
  mocks.listCatalogCountries.mockResolvedValue({ rows: [makeRow()], total: '1' });
});

describe('getCatalog', () => {
  it('parses filters, maps public sort keys and returns a safe page projection', async () => {
    const setup = makeRequest({
      q: ' Finland ',
      continent: 'europe',
      cache: 'all',
      update: 'available',
      page: '2',
      limit: '10',
      sort: 'size',
      order: 'desc',
    });
    const response = await getCatalog(setup.request);
    expect(setup.transaction.setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(mocks.listCatalogCountries.mock.calls[0]?.[1]).toEqual({
      search: 'Finland',
      continent: 'europe',
      cache: undefined,
      updateAvailable: true,
      page: 2,
      limit: 10,
      sort: 'sourceSizeHintBytes',
      order: 'desc',
    });
    expect(response).toEqual({
      data: [
        {
          countryId: COUNTRY_ID,
          sourceId: 'europe-finland',
          name: 'Finland',
          slug: 'finland',
          continent: 'europe',
          iso: ['FI', 'FIN'],
          sourceSizeHintBytes: 20,
          cache: {
            cached: false,
            versionsReady: 0,
            totalSizeBytes: 0,
            isPublic: false,
            updateState: 'unknown',
            availableVersion: null,
            availableSizeBytes: null,
          },
          lastSyncedAt: SYNCED_AT.toISOString(),
        },
      ],
      meta: { page: 2, limit: 10, total: 1, totalPages: 1 },
      catalogSyncedAt: SYNCED_AT.toISOString(),
    });
  });

  it('maps each allowed sort key and preserves large byte values as decimal strings', async () => {
    const big = '9007199254740992';
    const row = makeRow({
      source_size_hint_bytes: big,
      cache_country_id: COUNTRY_ID,
      is_public: true,
      update_state: 'update_available',
      available_version: '261101',
      available_size_bytes: big,
      versions_ready_count: 4,
      total_size_bytes: big,
    });
    mocks.listCatalogCountries.mockResolvedValue({ rows: [row], total: '0' });

    for (const [sort, mapped] of [
      ['name', 'name'],
      ['size', 'sourceSizeHintBytes'],
      ['updated', 'lastSyncedAt'],
      ['created', 'createdAt'],
    ] as const) {
      const setup = makeRequest({ sort });
      const response = await getCatalog(setup.request);
      expect(mocks.listCatalogCountries.mock.calls.at(-1)?.[1].sort).toBe(mapped);
      expect(response.data[0]?.sourceSizeHintBytes).toBe(big);
      expect(response.data[0]?.cache).toMatchObject({
        cached: true,
        versionsReady: 4,
        totalSizeBytes: big,
        isPublic: true,
        updateState: 'update_available',
        availableVersion: '261101',
        availableSizeBytes: big,
      });
    }
  });

  it('returns null sync timestamps and nullable source sizes and rejects invalid query values', async () => {
    mocks.findCatalogSyncedAt.mockResolvedValue(null);
    mocks.listCatalogCountries.mockResolvedValue({
      rows: [makeRow({ source_size_hint_bytes: null })],
      total: '0',
    });
    const response = await getCatalog(makeRequest().request);
    expect(response.catalogSyncedAt).toBeNull();
    expect(response.data[0]?.sourceSizeHintBytes).toBeNull();

    await expect(getCatalog(makeRequest({ unknown: true }).request)).rejects.toThrow();
    await expect(getCatalog(makeRequest({ sort: 'unsafe' }).request)).rejects.toThrow();
  });

  it('rejects malformed, negative and unsafe database count or byte values', async () => {
    for (const total of ['-1', '9007199254740992']) {
      mocks.listCatalogCountries.mockResolvedValue({ rows: [], total });
      await expect(getCatalog(makeRequest().request)).rejects.toThrow();
    }
    mocks.listCatalogCountries.mockResolvedValue({
      rows: [makeRow({ total_size_bytes: '-1' })],
      total: '0',
    });
    await expect(getCatalog(makeRequest().request)).rejects.toThrow(
      'catalog byte count is not a non-negative decimal integer',
    );
  });
});
