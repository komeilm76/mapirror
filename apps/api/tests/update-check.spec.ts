import { describe, expect, it } from 'vitest';

import {
  compareSourceToCache,
  type CachedSourceIdentity,
} from '../src/modules/updates/update-check';
import type { SourceRegionDetail } from '../src/modules/geofabrik/source';

const CACHED: CachedSourceIdentity[] = [
  {
    version: 'latest@2026-10-23T20-20-51Z',
    dataTimestamp: new Date('2026-10-23T20:20:51.000Z'),
    sizeBytes: '1000',
  },
];

function sourceDetail(overrides: Partial<SourceRegionDetail> = {}): SourceRegionDetail {
  return {
    version: '261024',
    dataTimestamp: new Date('2026-10-24T20:20:51.000Z'),
    sizeBytes: 1200,
    etag: null,
    lastModified: null,
    ...overrides,
  };
}

describe('compareSourceToCache', () => {
  it('reports a newer source timestamp and exposes only its available-version facts', () => {
    expect(compareSourceToCache(sourceDetail(), CACHED)).toEqual({
      state: 'update_available',
      availableVersion: '261024',
      availableSizeBytes: 1200,
      availableAt: new Date('2026-10-24T20:20:51.000Z'),
      reason: null,
    });
  });

  it('treats an exact source snapshot already cached as up to date', () => {
    const current = sourceDetail({ version: '261024' });
    const cached = [
      ...CACHED,
      {
        version: '261024',
        dataTimestamp: new Date('2026-10-24T20:20:51.000Z'),
        sizeBytes: '1200',
      },
    ];

    expect(compareSourceToCache(current, cached)).toMatchObject({
      state: 'up_to_date',
      availableVersion: null,
      availableSizeBytes: null,
      availableAt: null,
      reason: null,
    });
  });

  it('reports an identity change when data timestamps are equal but the advertised size differs', () => {
    expect(
      compareSourceToCache(
        sourceDetail({ dataTimestamp: new Date('2026-10-23T20:20:51.000Z'), sizeBytes: 1200 }),
        CACHED,
      ),
    ).toMatchObject({ state: 'update_available', availableSizeBytes: 1200 });
  });

  it('does not call an older upstream timestamp an available update', () => {
    expect(
      compareSourceToCache(
        sourceDetail({
          dataTimestamp: new Date('2026-10-22T20:20:51.000Z'),
          sizeBytes: 1200,
        }),
        CACHED,
      ),
    ).toMatchObject({ state: 'up_to_date', availableVersion: null });
  });

  it('uses a changed size when freshness timestamps are missing', () => {
    expect(
      compareSourceToCache(sourceDetail({ dataTimestamp: null, sizeBytes: 1200 }), [
        { ...CACHED[0]!, dataTimestamp: null },
      ]),
    ).toMatchObject({ state: 'update_available', availableVersion: '261024' });
  });

  it('returns unknown when source or cached identity is too incomplete to compare', () => {
    expect(compareSourceToCache(null, CACHED)).toMatchObject({ state: 'unknown' });
    const missingCachedIdentity = compareSourceToCache(
      sourceDetail({ dataTimestamp: null, sizeBytes: 1000 }),
      [{ ...CACHED[0]!, dataTimestamp: null }],
    );
    expect(missingCachedIdentity.state).toBe('unknown');
    expect(missingCachedIdentity.reason).not.toBeNull();

    const noCachedSourceVersion = compareSourceToCache(sourceDetail(), []);
    expect(noCachedSourceVersion.state).toBe('unknown');
    expect(noCachedSourceVersion.reason).not.toBeNull();
  });

  it('rejects malformed source metadata as unknown rather than claiming it is current', () => {
    expect(compareSourceToCache(sourceDetail({ version: 'latest' }), CACHED)).toMatchObject({
      state: 'unknown',
    });
    expect(compareSourceToCache(sourceDetail({ sizeBytes: -1 }), CACHED)).toMatchObject({
      state: 'unknown',
    });
  });
});
