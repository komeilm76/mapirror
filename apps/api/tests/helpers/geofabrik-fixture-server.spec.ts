import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createGeofabrikMapSource } from '../../src/modules/geofabrik/map-source';
import {
  getGeofabrikPbfFixture,
  GEOFABRIK_PBF_FIXTURE_MD5,
  withGeofabrikFixtureServer,
} from './geofabrik-fixture-server';

const pbfFixture = getGeofabrikPbfFixture();

describe('Geofabrik fixture HTTP server', () => {
  it('returns a defensive copy of the PBF bytes', () => {
    const copy = getGeofabrikPbfFixture();
    const firstByte = copy[0];
    if (firstByte === undefined) throw new Error('PBF fixture is unexpectedly empty');
    copy[0] = firstByte ^ 0xff;
    expect(getGeofabrikPbfFixture()[0]).toBe(firstByte);
  });

  it('serves offline index, region pages, PBF metadata, bytes and a matching MD5 sidecar', async () => {
    await withGeofabrikFixtureServer({}, async ({ baseUrl, requests }) => {
      const source = createGeofabrikMapSource(baseUrl, {
        metadataMaxAttempts: 1,
        metadataRetryDelayMs: 0,
      });
      const regions = await source.listRegions();
      expect(regions.map(({ id }) => id)).toEqual(['europe', 'europe/finland', 'europe/monaco']);
      expect(
        regions.every(
          (region) => region.pbfUrl === null || new URL(region.pbfUrl).origin === baseUrl,
        ),
      ).toBe(true);

      const detail = await source.getRegionDetail('europe/finland');
      expect(detail.version).toBe('261023');
      expect(detail.sizeBytes).toBe(773_500_000);

      const resolved = await source.resolveDownload('europe/finland', '261023');
      expect(resolved.url).toBe(`${baseUrl}/europe/finland-261023.osm.pbf`);
      expect(resolved.sizeBytes).toBe(pbfFixture.byteLength);
      expect(resolved.checksumMd5).toBeNull();

      const [pbf, sidecar] = await Promise.all([fetch(resolved.url), fetch(`${resolved.url}.md5`)]);
      const bytes = new Uint8Array(await pbf.arrayBuffer());
      expect(pbf.status).toBe(200);
      expect(Buffer.from(bytes)).toEqual(pbfFixture);
      expect(createHash('md5').update(bytes).digest('hex')).toBe(GEOFABRIK_PBF_FIXTURE_MD5);
      expect(await sidecar.text()).toBe(`${GEOFABRIK_PBF_FIXTURE_MD5}  finland-261023.osm.pbf\n`);

      expect(requests).toEqual([
        'GET /index-v1-nogeom.json',
        'GET /europe/finland.html',
        'GET /europe/finland.html',
        'HEAD /europe/finland-261023.osm.pbf',
        'GET /europe/finland-261023.osm.pbf',
        'GET /europe/finland-261023.osm.pbf.md5',
      ]);
    });
  });

  it('can model a source server that ignores Range and sends the full body', async () => {
    await withGeofabrikFixtureServer({ rangeMode: 'ignore' }, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/europe/finland-261023.osm.pbf`, {
        headers: { range: 'bytes=4-' },
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(pbfFixture);
    });
  });

  it('serves a configured checksum mismatch as a well-formed MD5 sidecar', async () => {
    const wrongMd5 = '0'.repeat(32);
    await withGeofabrikFixtureServer(
      { md5ByPath: { '/europe/finland-261023.osm.pbf': wrongMd5 } },
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/europe/finland-261023.osm.pbf.md5`);
        expect(await response.text()).toBe(`${wrongMd5}  finland-261023.osm.pbf\n`);
      },
    );
  });

  it('rejects status and checksum overrides that cannot be served safely', async () => {
    await expect(
      withGeofabrikFixtureServer({ statusByPath: { '/europe/finland.html': 204 } }, async () => {}),
    ).rejects.toThrow(RangeError);
    await expect(
      withGeofabrikFixtureServer({ statusByPath: { '/europe/finland.html': 302 } }, async () => {}),
    ).rejects.toThrow(RangeError);
    await expect(
      withGeofabrikFixtureServer({ statusByPath: { 'europe/finland.html': 503 } }, async () => {}),
    ).rejects.toThrow(TypeError);
    await expect(
      withGeofabrikFixtureServer(
        { md5ByPath: { '/europe/finland-261023.osm.pbf': 'not-an-md5' } },
        async () => {},
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      withGeofabrikFixtureServer(
        { md5ByPath: { '/unknown.osm.pbf': '0'.repeat(32) } },
        async () => {},
      ),
    ).rejects.toThrow(TypeError);
  });

  it('supports local byte ranges and per-path status overrides without contacting a live source', async () => {
    await withGeofabrikFixtureServer(
      { statusByPath: { '/europe/finland.html': 503 } },
      async ({ baseUrl, requests, requestDetails }) => {
        const page = await fetch(`${baseUrl}/europe/finland.html`);
        expect(page.status).toBe(503);

        const pbf = await fetch(`${baseUrl}/europe/finland-261023.osm.pbf`, {
          headers: { range: 'bytes=0-3', 'if-range': '"mapirror-fixture-pbf-v1"' },
        });
        expect(pbf.status).toBe(206);
        expect(pbf.headers.get('content-range')).toBe(`bytes 0-3/${pbfFixture.byteLength}`);
        expect(Buffer.from(await pbf.arrayBuffer())).toEqual(pbfFixture.subarray(0, 4));

        const staleRange = await fetch(`${baseUrl}/europe/finland-261023.osm.pbf`, {
          headers: { range: 'bytes=0-3', 'if-range': '"stale-pbf"' },
        });
        expect(staleRange.status).toBe(200);
        expect(Buffer.from(await staleRange.arrayBuffer())).toEqual(pbfFixture);

        const missing = await fetch(`${baseUrl}/not-a-fixture`);
        expect(missing.status).toBe(404);
        expect(requests).toEqual([
          'GET /europe/finland.html',
          'GET /europe/finland-261023.osm.pbf',
          'GET /europe/finland-261023.osm.pbf',
          'GET /not-a-fixture',
        ]);
        expect(
          requestDetails
            .filter(({ url }) => url === '/europe/finland-261023.osm.pbf')
            .map(({ range, ifRange }) => ({ range, ifRange })),
        ).toEqual([
          { range: 'bytes=0-3', ifRange: '"mapirror-fixture-pbf-v1"' },
          { range: 'bytes=0-3', ifRange: '"stale-pbf"' },
        ]);
      },
    );
  });
});
