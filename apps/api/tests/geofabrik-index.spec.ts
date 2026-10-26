import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  fetchGeofabrikRegions,
  GEOFABRIK_INDEX_FILENAME,
  parseGeofabrikIndex,
} from '../src/modules/geofabrik/index-client';

const indexFixture = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        id: 'europe/finland',
        parent: 'europe',
        name: 'Finland',
        'iso3166-1:alpha2': ['FI'],
        'iso3166-2': ['FI-01'],
        urls: {
          pbf: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf',
          history: 'https://download.geofabrik.de/europe/finland-updates/',
        },
        unrelated: 'ignored',
      },
      geometry: null,
    },
  ],
  name: 'Geofabrik download areas',
};

describe('parseGeofabrikIndex', () => {
  it('validates and maps source fields into the MapSource region contract', () => {
    expect(parseGeofabrikIndex(indexFixture)).toEqual([
      {
        id: 'europe/finland',
        parentId: 'europe',
        name: 'Finland',
        isoAlpha2: ['FI'],
        isoOther: ['FI-01'],
        pbfUrl: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf',
      },
    ]);
  });

  it('defaults absent parent, ISO lists and PBF URL without inventing values', () => {
    expect(
      parseGeofabrikIndex({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { id: 'antarctica', name: 'Antarctica' } }],
      }),
    ).toEqual([
      {
        id: 'antarctica',
        parentId: null,
        name: 'Antarctica',
        isoAlpha2: [],
        isoOther: [],
        pbfUrl: null,
      },
    ]);
  });

  it('rejects malformed collection and region fields with Zod validation errors', () => {
    expect(() => parseGeofabrikIndex({ type: 'FeatureCollection', features: [{}] })).toThrow(
      ZodError,
    );
    expect(() =>
      parseGeofabrikIndex({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              id: 'europe/finland',
              name: 'Finland',
              'iso3166-1:alpha2': 'FI',
              urls: { pbf: 'javascript:alert(1)' },
            },
          },
        ],
      }),
    ).toThrow(ZodError);
  });
});

describe('fetchGeofabrikRegions', () => {
  it('requests the no-geometry catalog and validates its JSON response', async () => {
    const calls: { url: string; accept: string | null }[] = [];
    const fetchImpl = (input: URL, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(input),
        accept: new Headers(init?.headers).get('accept'),
      });
      return Promise.resolve(
        new Response(JSON.stringify(indexFixture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };

    const regions = await fetchGeofabrikRegions('https://mirror.example.org/geofabrik/', fetchImpl);

    expect(calls).toEqual([
      {
        url: `https://mirror.example.org/geofabrik/${GEOFABRIK_INDEX_FILENAME}`,
        accept: 'application/json',
      },
    ]);
    expect(regions[0]?.id).toBe('europe/finland');
  });

  it('rejects non-success status without echoing the configured URL', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(new Response('unavailable', { status: 503 }));

    let error: unknown;
    try {
      await fetchGeofabrikRegions('https://user:secret@mirror.example.org', fetchImpl);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Geofabrik index request failed with HTTP 503');
    expect((error as Error).message).not.toContain('secret');
  });
});
