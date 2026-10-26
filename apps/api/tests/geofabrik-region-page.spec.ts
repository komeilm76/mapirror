/** Fixture-driven tests for Geofabrik's human-readable region pages (`P2-SRC-03`). */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseDisplayedSize, parseGeofabrikRegionPage } from '../src/modules/geofabrik/region-page';

/** Reads one checked-in upstream-shaped HTML fixture without network access. */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../src/modules/geofabrik/fixtures/${name}`, import.meta.url),
    'utf8',
  );
}

describe('parseDisplayedSize', () => {
  it.each([
    ['773.5 MB', 773_500_000],
    ['760 MiB', 796_917_760],
    ['4,321,987 bytes', 4_321_987],
    ['123456789', 123_456_789],
    ['1.25 GB', 1_250_000_000],
  ])('converts %s to bytes', (input, expected) => {
    expect(parseDisplayedSize(input)).toBe(expected);
  });

  it.each(['', '261023', 'about 3 GB', '1,23 MB', '9007199254740992 bytes'])(
    'returns null for unsupported or unsafe size %s',
    (input) => {
      expect(parseDisplayedSize(input)).toBeNull();
    },
  );
});

describe('parseGeofabrikRegionPage', () => {
  it('extracts dated snapshots, sizes, and page freshness while excluding latest and subregion links', () => {
    const page = parseGeofabrikRegionPage(fixture('europe.html'));

    expect(page.dataTimestamp?.toISOString()).toBe('2026-10-23T20:20:00.000Z');
    expect(page.snapshots).toEqual([
      {
        version: '261023',
        dataTimestamp: new Date('2026-10-23T20:20:00.000Z'),
        sizeBytes: 12_400_000_000,
        checksumMd5: null,
      },
      {
        version: '261016',
        dataTimestamp: null,
        sizeBytes: 12_100_000_000,
        checksumMd5: null,
      },
    ]);
  });

  it('handles a region page with no subregions and parses its dated history', () => {
    const page = parseGeofabrikRegionPage(fixture('finland.html'));

    expect(page.dataTimestamp?.toISOString()).toBe('2026-10-23T20:20:51.000Z');
    expect(page.snapshots.map(({ version, sizeBytes }) => ({ version, sizeBytes }))).toEqual([
      { version: '261023', sizeBytes: 773_500_000 },
      { version: '261016', sizeBytes: 796_917_760 },
    ]);
    expect(page.snapshots[0]?.dataTimestamp).toEqual(page.dataTimestamp);
  });

  it('parses a single-snapshot region and an ISO UTC timestamp', () => {
    const page = parseGeofabrikRegionPage(fixture('monaco.html'));

    expect(page.dataTimestamp?.toISOString()).toBe('2026-10-22T19:05:00.000Z');
    expect(page.snapshots).toEqual([
      {
        version: '261022',
        dataTimestamp: page.dataTimestamp,
        sizeBytes: 4_321_987,
        checksumMd5: null,
      },
    ]);
  });

  it.each(['2026-02-30T12:00:00Z', '2026-10-23 25:20 UTC'])(
    'rejects an impossible “data up to” timestamp: %s',
    (timestamp) => {
      const page = parseGeofabrikRegionPage(`<p>Data up to ${timestamp}</p>`);
      expect(page.dataTimestamp).toBeNull();
    },
  );

  it('returns null metadata and no snapshots when the page has no matching facts', () => {
    expect(
      parseGeofabrikRegionPage('<html><body><p>Downloads coming soon</p></body></html>'),
    ).toEqual({
      dataTimestamp: null,
      snapshots: [],
    });
  });
});
