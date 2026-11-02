import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCacheManifest } from '../cache-manifest';

describe('cache artifact manifest', () => {
  it('hashes eligible map files in stable order and ignores non-artifacts and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mapirror-cache-manifest-'));
    const outside = await mkdtemp(join(tmpdir(), 'mapirror-cache-outside-'));
    const firstBytes = Buffer.from('first cached map');
    const secondBytes = Buffer.from('second cached map');
    const generatedAt = new Date('2026-11-02T12:34:56.000Z');

    try {
      await mkdir(join(root, 'finland', '2026-10-01T000000Z'), { recursive: true });
      await mkdir(join(root, 'sweden', '2026-10-02T000000Z'), { recursive: true });
      await mkdir(join(root, '.partial'), { recursive: true });
      await writeFile(
        join(root, 'finland', '2026-10-01T000000Z', 'finland-latest.osm.pbf'),
        firstBytes,
      );
      await writeFile(
        join(root, 'sweden', '2026-10-02T000000Z', 'sweden-latest.osm.pbf'),
        secondBytes,
      );
      await writeFile(join(root, 'finland', '2026-10-01T000000Z', 'notes.txt'), 'ignored');
      await writeFile(join(root, '.partial', 'transfer.part'), 'ignored');
      await writeFile(join(outside, 'escaped.osm.pbf'), 'must not be followed');
      await symlink(outside, join(root, 'norway'));
      await symlink(
        join(outside, 'escaped.osm.pbf'),
        join(root, 'finland', '2026-10-01T000000Z', 'linked.osm.pbf'),
      );

      const manifest = await createCacheManifest(root, generatedAt);

      expect(manifest).toEqual({
        format: 'mapirror-cache-manifest',
        version: 1,
        generatedAt: generatedAt.toISOString(),
        artifacts: [
          {
            path: 'finland/2026-10-01T000000Z/finland-latest.osm.pbf',
            sizeBytes: String(firstBytes.length),
            md5: createHash('md5').update(firstBytes).digest('hex'),
          },
          {
            path: 'sweden/2026-10-02T000000Z/sweden-latest.osm.pbf',
            sizeBytes: String(secondBytes.length),
            md5: createHash('md5').update(secondBytes).digest('hex'),
          },
        ],
      });
      expect(await readFile(join(outside, 'escaped.osm.pbf'), 'utf8')).toBe('must not be followed');
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it('rejects a cache root that does not exist', async () => {
    await expect(
      createCacheManifest(join(tmpdir(), 'mapirror-no-such-cache-root')),
    ).rejects.toThrow();
  });
});
