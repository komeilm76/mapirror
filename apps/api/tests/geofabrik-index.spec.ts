import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  createGeofabrikCatalogIndexSource,
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

    const regions = await fetchGeofabrikRegions('https://mirror.example.org/geofabrik/', {
      fetchImpl,
    });

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
      await fetchGeofabrikRegions('https://user:secret@mirror.example.org', { fetchImpl });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Geofabrik index request failed with HTTP 503');
    expect((error as Error).message).not.toContain('secret');
  });

  it('passes cancellation to the fetch and promptly rejects when the caller aborts', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = (_input: URL, init?: RequestInit): Promise<Response> => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>(() => undefined);
    };
    const pending = fetchGeofabrikRegions('https://mirror.example.org', {
      fetchImpl,
      signal: controller.signal,
      timeoutMs: 5_000,
    });

    await Promise.resolve();
    controller.abort(new Error('job canceled'));

    await expect(pending).rejects.toThrow('job canceled');
    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts the response-body read when the caller cancels after headers arrive', async () => {
    const controller = new AbortController();
    let bodyReadStarted = false;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      json: () => {
        bodyReadStarted = true;
        return new Promise<unknown>(() => undefined);
      },
    } as Response;
    const fetchImpl = (): Promise<Response> => Promise.resolve(response);
    const pending = fetchGeofabrikRegions('https://mirror.example.org', {
      fetchImpl,
      signal: controller.signal,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(bodyReadStarted).toBe(true);
    controller.abort(new Error('body canceled'));

    await expect(pending).rejects.toThrow('body canceled');
  });

  it('enforces the deadline and aborts a fetch that ignores AbortSignal', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = (_input: URL, init?: RequestInit): Promise<Response> => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>(() => undefined);
    };

    await expect(
      fetchGeofabrikRegions('https://mirror.example.org', { fetchImpl, timeoutMs: 5 }),
    ).rejects.toThrow('Geofabrik index request timed out');
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([0, 30_001, 1.5, Number.NaN])(
    'rejects invalid timeout %s before making a request',
    async (timeoutMs) => {
      const fetchImpl = (): Promise<Response> => {
        throw new Error('must not fetch');
      };

      await expect(
        fetchGeofabrikRegions('https://mirror.example.org', { fetchImpl, timeoutMs }),
      ).rejects.toThrow(RangeError);
    },
  );
});

describe('createGeofabrikCatalogIndexSource', () => {
  it('uses the configured base URL and the validated index client', async () => {
    const calls: string[] = [];
    const source = createGeofabrikCatalogIndexSource('https://mirror.example.org/geofabrik', {
      fetchImpl: (input) => {
        calls.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify(indexFixture), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });

    expect(source.id).toBe('geofabrik');
    await expect(source.listRegions()).resolves.toHaveLength(1);
    expect(calls).toEqual([`https://mirror.example.org/geofabrik/${GEOFABRIK_INDEX_FILENAME}`]);
  });
});
