import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createGeofabrikMapSource } from '../../src/modules/geofabrik/map-source';
import {
  GEOFABRIK_PBF_FIXTURE,
  GEOFABRIK_PBF_FIXTURE_MD5,
  withGeofabrikFixtureServer,
} from './geofabrik-fixture-server';

describe('Geofabrik fixture HTTP server', () => {
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
      expect(resolved.sizeBytes).toBe(GEOFABRIK_PBF_FIXTURE.byteLength);
      expect(resolved.checksumMd5).toBeNull();

      const [pbf, sidecar] = await Promise.all([fetch(resolved.url), fetch(`${resolved.url}.md5`)]);
      const bytes = new Uint8Array(await pbf.arrayBuffer());
      expect(pbf.status).toBe(200);
      expect(Buffer.from(bytes)).toEqual(GEOFABRIK_PBF_FIXTURE);
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

  it('supports local byte ranges and per-path status overrides without contacting a live source', async () => {
    await withGeofabrikFixtureServer(
      { statusByPath: { '/europe/finland.html': 503 } },
      async ({ baseUrl, requests }) => {
        const page = await fetch(`${baseUrl}/europe/finland.html`);
        expect(page.status).toBe(503);

        const pbf = await fetch(`${baseUrl}/europe/finland-261023.osm.pbf`, {
          headers: { range: 'bytes=0-3' },
        });
        expect(pbf.status).toBe(206);
        expect(pbf.headers.get('content-range')).toBe(
          `bytes 0-3/${GEOFABRIK_PBF_FIXTURE.byteLength}`,
        );
        expect(Buffer.from(await pbf.arrayBuffer())).toEqual(GEOFABRIK_PBF_FIXTURE.subarray(0, 4));

        const missing = await fetch(`${baseUrl}/not-a-fixture`);
        expect(missing.status).toBe(404);
        expect(requests).toEqual([
          'GET /europe/finland.html',
          'GET /europe/finland-261023.osm.pbf',
          'GET /not-a-fixture',
        ]);
      },
    );
  });
});
