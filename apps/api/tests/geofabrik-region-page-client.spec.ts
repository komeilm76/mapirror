import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  fetchGeofabrikRegionPage,
  geofabrikRegionPageUrl,
  geofabrikRegionPbfUrl,
} from '../src/modules/geofabrik/region-page-client';

const finlandPage = readFileSync(
  new URL('../src/modules/geofabrik/fixtures/finland.html', import.meta.url),
  'utf8',
);

describe('Geofabrik region-page client', () => {
  it('constructs encoded region and dated/latest PBF URLs under the configured base path', () => {
    expect(geofabrikRegionPageUrl('https://download.example/base/', 'europe/finland').href).toBe(
      'https://download.example/base/europe/finland.html',
    );
    expect(geofabrikRegionPbfUrl('https://download.example', 'europe/finland', '261023').href).toBe(
      'https://download.example/europe/finland-261023.osm.pbf',
    );
    expect(geofabrikRegionPbfUrl('https://download.example', 'europe/finland', 'latest').href).toBe(
      'https://download.example/europe/finland-latest.osm.pbf',
    );
  });

  it('rejects path traversal and invalid snapshot identities before any request', () => {
    expect(() => geofabrikRegionPageUrl('https://download.example', '../finland')).toThrow(
      'not a safe path',
    );
    expect(() =>
      geofabrikRegionPbfUrl('https://download.example', 'europe/finland', '../secret'),
    ).toThrow('six-digit date or latest');
  });

  it('parses an offline source response and enforces the streamed response size limit', async () => {
    const fetchImpl = () => Promise.resolve(new Response(finlandPage, { status: 200 }));
    const page = await fetchGeofabrikRegionPage('https://download.example', 'europe/finland', {
      fetchImpl,
    });
    expect(page.snapshots[0]?.version).toBe('261023');
    await expect(
      fetchGeofabrikRegionPage('https://download.example', 'europe/finland', {
        fetchImpl,
        maxBytes: 32,
      }),
    ).rejects.toThrow('response size limit');
  });

  it('rejects upstream HTTP errors and bounds a fetch that stalls', async () => {
    await expect(
      fetchGeofabrikRegionPage('https://download.example', 'europe/finland', {
        fetchImpl: () => Promise.resolve(new Response('offline', { status: 503 })),
      }),
    ).rejects.toThrow('HTTP 503');

    await expect(
      fetchGeofabrikRegionPage('https://download.example', 'europe/finland', {
        timeoutMs: 5,
        fetchImpl: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      }),
    ).rejects.toThrow('aborted');
  });
});
