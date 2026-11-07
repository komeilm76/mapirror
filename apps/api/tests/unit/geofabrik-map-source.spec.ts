import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchRegions: vi.fn(),
  fetchRegionPage: vi.fn(),
  fetchHeadMetadata: vi.fn(),
  regionPbfUrl: vi.fn(),
  createPageSource: vi.fn(),
}));
vi.mock('../../src/modules/geofabrik/index-client', () => ({
  fetchGeofabrikRegions: mocks.fetchRegions,
}));
vi.mock('../../src/modules/geofabrik/region-page-client', () => ({
  fetchGeofabrikRegionPage: mocks.fetchRegionPage,
  geofabrikRegionPathFromPbfUrl: (pbfUrl: string) => {
    const segments = new URL(pbfUrl).pathname.split('/').filter((segment) => segment.length > 0);
    const filename = segments.pop() ?? '';
    return [...segments, filename.replace(/-latest\.osm\.pbf$/u, '')].join('/');
  },
  geofabrikRegionPbfUrl: mocks.regionPbfUrl,
  createGeofabrikRegionPageSource: mocks.createPageSource,
  GeofabrikRegionPageHttpError: class GeofabrikRegionPageHttpError extends Error {
    constructor(readonly status: number) {
      super(`page status ${String(status)}`);
    }
  },
}));
vi.mock('../../src/modules/geofabrik/file-metadata', () => ({
  fetchGeofabrikHeadMetadata: mocks.fetchHeadMetadata,
  GeofabrikMetadataHttpError: class GeofabrikMetadataHttpError extends Error {
    constructor(
      readonly status: number,
      readonly operation: 'HEAD' | 'MD5',
      readonly attempts: number,
    ) {
      super(`${operation} status ${String(status)} after ${String(attempts)} attempts`);
    }
  },
}));

import { GeofabrikMetadataHttpError } from '../../src/modules/geofabrik/file-metadata';
import { GeofabrikRegionPageHttpError } from '../../src/modules/geofabrik/region-page-client';
import {
  createGeofabrikMapSource,
  GeofabrikSnapshotGoneError,
} from '../../src/modules/geofabrik/map-source';

const SNAPSHOT_DATE = new Date('2026-10-31T00:00:00Z');
const PAGE_DATE = new Date('2026-10-30T00:00:00Z');
const page = {
  snapshots: [
    {
      version: '261031',
      dataTimestamp: SNAPSHOT_DATE,
      sizeBytes: 100,
      checksumMd5: 'a'.repeat(32),
    },
    { version: '261030', dataTimestamp: PAGE_DATE, sizeBytes: 80, checksumMd5: null },
  ],
  dataTimestamp: PAGE_DATE,
};
const metadata = {
  sizeBytes: 120,
  etag: 'etag-1',
  lastModified: SNAPSHOT_DATE,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createPageSource.mockReturnValue({
    getRegionDetail: vi.fn(() => Promise.resolve({ version: '261031' })),
    listSnapshots: vi.fn(() => Promise.resolve(page.snapshots)),
  });
  mocks.fetchRegions.mockResolvedValue([]);
  mocks.fetchRegionPage.mockResolvedValue(page);
  mocks.regionPbfUrl.mockReturnValue({
    href: 'https://download.example.test/finland-latest.osm.pbf',
  });
  mocks.fetchHeadMetadata.mockResolvedValue(metadata);
});

describe('Geofabrik MapSource composition', () => {
  it('forwards optional transport, timeout and abort controls to index and page operations', async () => {
    const fetchImpl = vi.fn();
    const source = createGeofabrikMapSource('https://download.example.test/europe', {
      fetchImpl,
      pageTimeoutMs: 4321,
      metadataTimeoutMs: 7654,
      metadataMaxAttempts: 2,
      metadataRetryDelayMs: 9,
    });
    const controller = new AbortController();
    await source.listRegions(controller.signal);
    expect(mocks.fetchRegions).toHaveBeenCalledWith('https://download.example.test/europe', {
      fetchImpl,
      signal: controller.signal,
      timeoutMs: 4321,
    });
    await source.resolveDownload('europe/finland', 'latest', controller.signal);
    expect(mocks.fetchRegionPage).toHaveBeenCalledWith(
      'https://download.example.test/europe',
      'europe/finland',
      { fetchImpl, timeoutMs: 4321, signal: controller.signal },
    );
    expect(mocks.fetchHeadMetadata).toHaveBeenCalledWith(
      'https://download.example.test/finland-latest.osm.pbf',
      {
        fetchImpl,
        timeoutMs: 7654,
        maxAttempts: 2,
        retryDelayMs: 9,
        signal: controller.signal,
      },
    );
  });

  it('resolves leaf-only source ids through the index PBF path before reading pages and downloads', async () => {
    const baseUrl = 'https://download.example.test';
    mocks.fetchRegions.mockResolvedValue([
      {
        id: 'iran',
        parentId: 'asia',
        name: 'Iran',
        isoAlpha2: ['IR'],
        isoOther: [],
        pbfUrl: 'https://download.geofabrik.de/asia/iran-latest.osm.pbf',
      },
    ]);
    const source = createGeofabrikMapSource(baseUrl);

    await source.resolveDownload('iran', 'latest');

    expect(mocks.fetchRegions).toHaveBeenCalledWith(baseUrl, {});
    expect(mocks.fetchRegionPage).toHaveBeenCalledWith(baseUrl, 'asia/iran', {});
    expect(mocks.regionPbfUrl).toHaveBeenCalledWith(baseUrl, 'asia/iran', 'latest');
  });

  it('exposes page detail methods and omits undefined optional request options', async () => {
    const source = createGeofabrikMapSource('https://download.example.test/europe');
    expect(source.id).toBe('geofabrik');
    await expect(source.listRegions()).resolves.toEqual([]);
    await expect(source.getRegionDetail('europe/finland')).resolves.toMatchObject({
      version: '261031',
    });
    await expect(source.listSnapshots('europe/finland')).resolves.toHaveLength(2);
    expect(mocks.fetchRegions).toHaveBeenCalledWith('https://download.example.test/europe', {});
  });

  it('resolves latest metadata and falls back to snapshot details when HEAD size is absent', async () => {
    const source = createGeofabrikMapSource('https://download.example.test/europe');
    mocks.fetchHeadMetadata.mockResolvedValueOnce({ ...metadata, sizeBytes: null });
    await expect(source.resolveDownload('europe/finland', 'latest')).resolves.toEqual({
      version: '261031',
      url: 'https://download.example.test/finland-latest.osm.pbf',
      sizeBytes: 100,
      dataTimestamp: SNAPSHOT_DATE,
      checksumMd5: null,
      etag: 'etag-1',
      lastModified: SNAPSHOT_DATE,
    });
  });

  it('resolves a requested dated snapshot, while preserving null source metadata', async () => {
    const source = createGeofabrikMapSource('https://download.example.test/europe');
    mocks.fetchHeadMetadata.mockResolvedValueOnce({
      sizeBytes: null,
      etag: null,
      lastModified: null,
    });
    await expect(source.resolveDownload('europe/finland', '261030')).resolves.toEqual({
      version: '261030',
      url: 'https://download.example.test/finland-latest.osm.pbf',
      sizeBytes: 80,
      dataTimestamp: PAGE_DATE,
      checksumMd5: null,
      etag: null,
      lastModified: null,
    });
  });

  it('rejects malformed versions before making any upstream request', async () => {
    const source = createGeofabrikMapSource('https://download.example.test/europe');
    await expect(source.resolveDownload('europe/finland', '20261031')).rejects.toThrow(
      'Geofabrik snapshot version must be a six-digit date or latest',
    );
    expect(mocks.fetchRegionPage).not.toHaveBeenCalled();
  });

  it('maps missing dated pages and absent dated snapshots to the snapshot-gone error', async () => {
    const source = createGeofabrikMapSource('https://download.example.test/europe');
    mocks.fetchRegionPage.mockRejectedValueOnce(new GeofabrikRegionPageHttpError(404));
    await expect(source.resolveDownload('europe/finland', '261029')).rejects.toEqual(
      expect.objectContaining({ name: 'GeofabrikSnapshotGoneError', version: '261029' }),
    );

    const upstreamFailure = new GeofabrikRegionPageHttpError(500);
    mocks.fetchRegionPage.mockRejectedValueOnce(upstreamFailure);
    await expect(source.resolveDownload('europe/finland', '261029')).rejects.toBeInstanceOf(
      GeofabrikRegionPageHttpError,
    );

    mocks.fetchRegionPage.mockResolvedValueOnce({ ...page, snapshots: [] });
    await expect(source.resolveDownload('europe/finland', '261029')).rejects.toEqual(
      expect.objectContaining({ name: 'GeofabrikSnapshotGoneError', version: '261029' }),
    );
  });

  it('maps only definitive dated HEAD 404s to snapshot-gone and preserves other failures', async () => {
    const source = createGeofabrikMapSource('https://download.example.test/europe');
    mocks.fetchHeadMetadata.mockRejectedValueOnce(new GeofabrikMetadataHttpError(404, 'HEAD', 1));
    await expect(source.resolveDownload('europe/finland', '261031')).rejects.toBeInstanceOf(
      GeofabrikSnapshotGoneError,
    );

    const failure = new GeofabrikMetadataHttpError(503, 'HEAD', 2);
    mocks.fetchHeadMetadata.mockRejectedValueOnce(failure);
    await expect(source.resolveDownload('europe/finland', '261031')).rejects.toBe(failure);

    const latestNotFound = new GeofabrikMetadataHttpError(404, 'HEAD', 1);
    mocks.fetchHeadMetadata.mockRejectedValueOnce(latestNotFound);
    await expect(source.resolveDownload('europe/finland', 'latest')).rejects.toBe(latestNotFound);
  });

  it('preserves latest page failures rather than misclassifying them as deleted snapshots', async () => {
    const source = createGeofabrikMapSource('https://download.example.test/europe');
    const failure = new GeofabrikRegionPageHttpError(404);
    mocks.fetchRegionPage.mockRejectedValueOnce(failure);
    await expect(source.resolveDownload('europe/finland', 'latest')).rejects.toBe(failure);
  });
});
