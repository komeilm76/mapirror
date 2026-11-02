import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type {
  CatalogCountryRow,
  CatalogParentRow,
  CatalogCachedVersionRow,
} from '../../src/db/repositories/catalog';
import type {
  MapSource,
  SourceRegionDetail,
  SourceSnapshot,
} from '../../src/modules/geofabrik/source';

const mocks = vi.hoisted(() => ({
  findCountryBySlug: vi.fn<(trx: unknown, slug: string) => Promise<CatalogCountryRow | null>>(),
  findCountryParentChain: vi.fn<(trx: unknown, id: string) => Promise<CatalogParentRow[]>>(),
  listCachedRegionVersions:
    vi.fn<(trx: unknown, id: string) => Promise<CatalogCachedVersionRow[]>>(),
}));
vi.mock('../../src/db/repositories/catalog', () => ({
  findCountryBySlug: mocks.findCountryBySlug,
  findCountryParentChain: mocks.findCountryParentChain,
  listCachedRegionVersions: mocks.listCachedRegionVersions,
}));

import { createCatalogRegionHandlers } from '../../src/modules/admin/catalog-region-route';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const VERSION_ID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-01T12:00:00Z');
const DIGEST = 'a'.repeat(32);

function makeCountry(overrides: Partial<CatalogCountryRow> = {}): CatalogCountryRow {
  return {
    id: COUNTRY_ID,
    source: 'geofabrik',
    source_id: 'europe/finland',
    parent_id: 'europe',
    slug: 'finland',
    name: 'Finland',
    iso_alpha2: ['FI'],
    iso_other: ['FI', 'FIN'],
    source_pbf_url: 'https://download.example/finland-latest.osm.pbf',
    source_size_hint_bytes: '9007199254740992',
    catalog_synced_at: NOW,
    created_at: NOW,
    updated_at: NOW,
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

function makeVersion(overrides: Partial<CatalogCachedVersionRow> = {}): CatalogCachedVersionRow {
  return {
    id: VERSION_ID,
    version: '261101',
    origin: 'geofabrik_snapshot',
    data_timestamp: NOW,
    file_size_bytes: '123',
    checksum_md5: DIGEST,
    created_at: NOW,
    ...overrides,
  };
}

function makeRequest(slug = 'finland') {
  const trx = {};
  const transaction = {
    setIsolationLevel: vi.fn(),
    execute: vi.fn((callback: (trx: object) => Promise<unknown>) => callback(trx)),
  };
  transaction.setIsolationLevel.mockImplementation(() => transaction);
  const database = { transaction: vi.fn(() => transaction) };
  const request = {
    params: { slug },
    log: { warn: vi.fn() },
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { slug: string } }>;
  return { request, database, transaction, trx };
}

function makeHandlers(
  options: {
    detail?: SourceRegionDetail;
    snapshots?: SourceSnapshot[];
    detailError?: Error;
    snapshotsError?: Error;
  } = {},
) {
  const source = {
    getRegionDetail: vi.fn(() =>
      options.detailError
        ? Promise.reject(options.detailError)
        : Promise.resolve(
            options.detail ?? {
              version: '261102',
              dataTimestamp: NOW,
              sizeBytes: 500,
              etag: null,
              lastModified: null,
            },
          ),
    ),
    listSnapshots: vi.fn(() =>
      options.snapshotsError
        ? Promise.reject(options.snapshotsError)
        : Promise.resolve(options.snapshots ?? []),
    ),
  } as unknown as Pick<MapSource, 'getRegionDetail' | 'listSnapshots'>;
  return { handlers: createCatalogRegionHandlers(source), source };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCountryBySlug.mockResolvedValue(makeCountry());
  mocks.findCountryParentChain.mockResolvedValue([
    { source_id: 'europe', slug: 'europe', name: 'Europe' },
  ]);
  mocks.listCachedRegionVersions.mockResolvedValue([makeVersion()]);
});

describe('admin catalog region handlers', () => {
  it('combines local identity, parent chain, cached versions and live source detail', async () => {
    const { handlers, source } = makeHandlers();
    const setup = makeRequest();
    const response = await handlers.getRegion(setup.request);
    expect(setup.transaction.setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(source.getRegionDetail).toHaveBeenCalledWith('europe/finland');
    expect(response).toEqual({
      country: {
        countryId: COUNTRY_ID,
        sourceId: 'europe/finland',
        slug: 'finland',
        name: 'Finland',
        parentChain: [{ sourceId: 'europe', slug: 'europe', name: 'Europe' }],
        iso: ['FI', 'FIN'],
        pbfUrl: 'https://download.example/finland-latest.osm.pbf',
        sizeHintBytes: '9007199254740992',
      },
      source: { version: '261102', sizeBytes: 500, dataTimestamp: NOW.toISOString() },
      sourceReachable: true,
      cachedVersions: [
        {
          id: VERSION_ID,
          version: '261101',
          origin: 'geofabrik_snapshot',
          dataTimestamp: NOW.toISOString(),
          sizeBytes: 123,
          checksumMd5: DIGEST,
          createdAt: NOW.toISOString(),
        },
      ],
    });
  });

  it('returns source-unavailable defaults, rejects bad slugs and unknown local regions', async () => {
    const sourceError = new Error('private upstream text');
    const { handlers } = makeHandlers({ detailError: sourceError });
    const setup = makeRequest();
    const response = await handlers.getRegion(setup.request);
    expect(response.sourceReachable).toBe(false);
    expect(response.source).toEqual({ version: null, sizeBytes: null, dataTimestamp: null });
    expect(setup.request.log.warn).toHaveBeenCalledWith(
      { err: sourceError, slug: 'finland' },
      'Geofabrik region page is unavailable',
    );

    const badSlug = makeRequest('Finland');
    await expect(handlers.getRegion(badSlug.request)).rejects.toThrow();
    mocks.findCountryBySlug.mockResolvedValue(null);
    await expect(handlers.getRegion(makeRequest().request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('overlays current snapshots with cached metadata and ignores malformed source MD5s', async () => {
    const { handlers } = makeHandlers({
      snapshots: [
        { version: '261101', dataTimestamp: NOW, sizeBytes: 500, checksumMd5: 'invalid' },
        { version: '261102', dataTimestamp: null, sizeBytes: null, checksumMd5: null },
      ],
    });
    const response = await handlers.getSnapshots(makeRequest().request);
    expect(response.sourceReachable).toBe(true);
    expect(response.latest).toEqual({ version: '261101', sizeBytes: 500 });
    expect(response.data).toEqual([
      {
        version: '261101',
        dataTimestamp: NOW.toISOString(),
        sizeBytes: 500,
        checksumMd5: DIGEST,
        cached: true,
      },
      {
        version: '261102',
        dataTimestamp: null,
        sizeBytes: null,
        checksumMd5: null,
        cached: false,
      },
    ]);
  });

  it('falls back to non-upload cached versions during source outages and handles empty sources', async () => {
    mocks.listCachedRegionVersions.mockResolvedValue([
      makeVersion({ version: 'upload-v1', origin: 'upload' }),
      makeVersion({ version: '261101', checksum_md5: 'invalid' }),
      makeVersion({
        id: '00000000-0000-4000-8000-000000000004',
        version: '261030',
        origin: 'geofabrik_latest',
        data_timestamp: null,
        checksum_md5: null,
      }),
    ]);
    const { handlers } = makeHandlers({ snapshotsError: new Error('offline') });
    const response = await handlers.getSnapshots(makeRequest().request);
    expect(response.sourceReachable).toBe(false);
    expect(response.latest).toBeNull();
    expect(response.data).toEqual([
      {
        version: '261101',
        dataTimestamp: NOW.toISOString(),
        sizeBytes: 123,
        checksumMd5: null,
        cached: true,
      },
      {
        version: '261030',
        dataTimestamp: null,
        sizeBytes: 123,
        checksumMd5: null,
        cached: true,
      },
    ]);

    const empty = makeHandlers({ snapshots: [] });
    const emptyResponse = await empty.handlers.getSnapshots(makeRequest().request);
    expect(emptyResponse.latest).toBeNull();
    expect(emptyResponse.data).toEqual([]);
  });

  it('rejects unsafe persisted byte values instead of returning malformed JSON', async () => {
    mocks.listCachedRegionVersions.mockResolvedValue([makeVersion({ file_size_bytes: '-1' })]);
    await expect(
      makeHandlers({ snapshotsError: new Error('offline') }).handlers.getSnapshots(
        makeRequest().request,
      ),
    ).rejects.toThrow('catalog byte count is not a non-negative decimal integer');
  });
});
