import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCacheStorage, StoragePathError } from '../src/modules/storage/storage';

const JOB_ID = '3ac68a32-40a4-4ea4-a40b-d2b2e7a4d227';

async function withDirectories<T>(run: (root: string, outside: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), 'mapirror-storage-'));
  const root = join(workspace, 'cache');
  const outside = join(workspace, 'outside');
  await mkdir(outside);
  try {
    return await run(root, outside);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('cache storage paths and safe filesystem operations', () => {
  it('builds stable relative version paths and job-scoped part paths', () => {
    const storage = createCacheStorage('/tmp/mapirror-cache');
    const version = storage.versionFile('finland', '261023', 'finland-261023.osm.pbf');
    expect(version.relativePath).toBe('finland/261023/finland-261023.osm.pbf');
    expect(Object.isFrozen(version)).toBe(true);
    expect(
      storage.versionFileAt('finland/latest@2026-10-23T20-20-51Z/finland-latest.osm.pbf'),
    ).toMatchObject({
      relativePath: 'finland/latest@2026-10-23T20-20-51Z/finland-latest.osm.pbf',
    });
    expect(storage.partFile(JOB_ID).relativePath).toBe('');
  });

  it.each([
    ['parent traversal slug', '../outside', '261023', 'finland-261023.osm.pbf'],
    ['nested slug', 'europe/finland', '261023', 'finland-261023.osm.pbf'],
    ['parent traversal version', 'finland', '../../outside', 'finland-261023.osm.pbf'],
    ['path separator filename', 'finland', '261023', '../outside.osm.pbf'],
    ['backslash filename', 'finland', '261023', '..\\outside.osm.pbf'],
    ['non-PBF filename', 'finland', '261023', 'report.txt'],
  ])('rejects %s before producing a cache path', (_label, slug, version, filename) => {
    const storage = createCacheStorage('/tmp/mapirror-cache');
    expect(() => storage.versionFile(slug, version, filename)).toThrow(StoragePathError);
  });

  it.each([
    '/tmp/outside/finland/261023/finland-261023.osm.pbf',
    '../outside/261023/finland-261023.osm.pbf',
    'finland/../outside/finland-261023.osm.pbf',
    'finland/261023/../outside.osm.pbf',
    'finland\\261023\\finland-261023.osm.pbf',
    'finland/261023',
    'finland//finland-261023.osm.pbf',
  ])('rejects unsafe persisted path %s', (path) => {
    const storage = createCacheStorage('/tmp/mapirror-cache');
    expect(() => storage.versionFileAt(path)).toThrow(StoragePathError);
  });

  it('requires a PostgreSQL UUID for the temporary part path', () => {
    const storage = createCacheStorage('/tmp/mapirror-cache');
    expect(() => storage.partFile('../outside')).toThrow(StoragePathError);
    expect(() => storage.partFile('not-a-uuid')).toThrow(StoragePathError);
  });

  it('writes a part and atomically installs it using the persisted relative path', async () => {
    await withDirectories(async (root) => {
      const storage = createCacheStorage(root);
      const part = storage.partFile(JOB_ID);
      const version = storage.versionFile('finland', '261023', 'finland-261023.osm.pbf');
      await part.ensureParent();
      const handle = await part.open('write');
      await handle.writeFile('verified map bytes');
      await handle.close();

      await storage.installPart(part, version);

      expect(await readFile(join(root, version.relativePath), 'utf8')).toBe('verified map bytes');
      await expect(part.size()).resolves.toBe(0n);
    });
  });

  it('does not expose direct write or append access to an installed version path', async () => {
    await withDirectories(async (root) => {
      const storage = createCacheStorage(root);
      const target = storage.versionFile('finland', '261023', 'finland-261023.osm.pbf');
      await target.ensureParent();
      const part = storage.partFile(JOB_ID);
      const handle = await part.open('write');
      await handle.writeFile('read-only after install');
      await handle.close();
      await storage.installPart(part, target);

      await expect(target.open('write')).rejects.toBeInstanceOf(StoragePathError);
      await expect(target.open('append')).rejects.toBeInstanceOf(StoragePathError);
      await expect(readFile(join(root, target.relativePath), 'utf8')).resolves.toBe(
        'read-only after install',
      );
    });
  });

  it('rejects a symlinked directory component without reading, writing, or unlinking outside the cache', async () => {
    await withDirectories(async (root, outside) => {
      await mkdir(root, { recursive: true });
      await symlink(outside, join(root, 'finland'), 'dir');
      await writeFile(join(outside, '261023.osm.pbf'), 'must stay untouched');
      const storage = createCacheStorage(root);
      const target = storage.versionFile('finland', '261023', '261023.osm.pbf');

      await expect(target.open('read')).rejects.toBeInstanceOf(StoragePathError);
      await expect(target.open('write')).rejects.toBeInstanceOf(StoragePathError);
      await expect(target.remove()).resolves.toBe(false);
      await expect(lstat(join(root, 'finland'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(outside, '261023.osm.pbf'), 'utf8')).resolves.toBe(
        'must stay untouched',
      );
    });
  });

  it('rejects a symlinked version directory without entering its external target', async () => {
    await withDirectories(async (root, outside) => {
      await mkdir(join(root, 'finland'), { recursive: true });
      await symlink(outside, join(root, 'finland', '261023'), 'dir');
      await writeFile(join(outside, 'finland-261023.osm.pbf'), 'must stay untouched');
      const target = createCacheStorage(root).versionFile(
        'finland',
        '261023',
        'finland-261023.osm.pbf',
      );

      await expect(target.ensureParent()).rejects.toBeInstanceOf(StoragePathError);
      await expect(target.open('read')).rejects.toBeInstanceOf(StoragePathError);
      await expect(target.remove()).resolves.toBe(false);
      await expect(lstat(join(root, 'finland', '261023'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(outside, 'finland-261023.osm.pbf'), 'utf8')).resolves.toBe(
        'must stay untouched',
      );
    });
  });

  it('rejects a symlinked `.partial` directory when preparing a job part', async () => {
    await withDirectories(async (root, outside) => {
      await mkdir(root, { recursive: true });
      await symlink(outside, join(root, '.partial'), 'dir');
      await writeFile(join(outside, `${JOB_ID}.part`), 'must stay untouched');
      const part = createCacheStorage(root).partFile(JOB_ID);

      await expect(part.ensureParent()).rejects.toBeInstanceOf(StoragePathError);
      await part.remove();
      await expect(lstat(join(root, '.partial'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(outside, `${JOB_ID}.part`), 'utf8')).resolves.toBe(
        'must stay untouched',
      );
    });
  });

  it('refuses to open a leaf symlink, and safely unlinks only the link itself', async () => {
    await withDirectories(async (root, outside) => {
      await writeFile(join(outside, 'payload'), 'external bytes');
      const relativePath = 'finland/261023/finland-261023.osm.pbf';
      const targetPath = join(root, relativePath);
      await mkdir(join(root, 'finland/261023'), { recursive: true });
      await symlink(join(outside, 'payload'), targetPath);
      const target = createCacheStorage(root).versionFileAt(relativePath);

      await expect(target.open('read')).rejects.toBeInstanceOf(StoragePathError);
      await target.remove();
      await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(outside, 'payload'), 'utf8')).resolves.toBe('external bytes');
    });
  });

  it('will not install over a symlink target', async () => {
    await withDirectories(async (root, outside) => {
      await writeFile(join(outside, 'payload'), 'external bytes');
      const storage = createCacheStorage(root);
      const part = storage.partFile(JOB_ID);
      const target = storage.versionFile('finland', '261023', 'finland-261023.osm.pbf');
      await part.ensureParent();
      const handle = await part.open('write');
      await handle.writeFile('new bytes');
      await handle.close();
      await target.ensureParent();
      await symlink(join(outside, 'payload'), join(root, target.relativePath));

      await expect(storage.installPart(part, target)).rejects.toBeInstanceOf(StoragePathError);
      await expect(readFile(join(outside, 'payload'), 'utf8')).resolves.toBe('external bytes');
      await expect(readFile(join(root, '.partial', `${JOB_ID}.part`), 'utf8')).resolves.toBe(
        'new bytes',
      );
    });
  });

  it('refuses to unlink directories and never recursively removes their contents', async () => {
    await withDirectories(async (root) => {
      const storage = createCacheStorage(root);
      const target = storage.versionFile('finland', '261023', 'finland-261023.osm.pbf');
      await target.ensureParent();
      await mkdir(join(root, target.relativePath));
      await writeFile(join(root, target.relativePath, 'keep'), 'preserved');

      await expect(target.remove()).rejects.toBeInstanceOf(StoragePathError);
      await expect(readFile(join(root, target.relativePath, 'keep'), 'utf8')).resolves.toBe(
        'preserved',
      );
    });
  });

  it('lists cache entries without following symlinked directories', async () => {
    await withDirectories(async (root, outside) => {
      const storage = createCacheStorage(root);
      const part = storage.partFile(JOB_ID);
      const ready = storage.versionFile('finland', '261023', 'finland-261023.osm.pbf');
      await part.ensureParent();
      const handle = await part.open('write');
      await handle.writeFile('known bytes');
      await handle.close();
      await storage.installPart(part, ready);
      await writeFile(join(outside, 'hidden'), 'must not be read');
      await symlink(outside, join(root, 'escape'), 'dir');

      const entries = await storage.listEntries();
      const readyEntry = entries.find(({ relativePath }) => relativePath === ready.relativePath);
      expect(readyEntry).toMatchObject({ kind: 'file', sizeBytes: 11n });
      expect(readyEntry?.modifiedAt).toBeInstanceOf(Date);
      const symlinkEntry = entries.find(({ relativePath }) => relativePath === 'escape');
      expect(symlinkEntry).toMatchObject({ kind: 'symlink', sizeBytes: 0n });
      expect(symlinkEntry?.modifiedAt).toBeInstanceOf(Date);
      expect(entries.some(({ relativePath }) => relativePath.startsWith('escape/'))).toBe(false);
    });
  });

  it('proves writability with one byte and removes the fixed readiness probe', async () => {
    await withDirectories(async (root) => {
      await createCacheStorage(root).probeWritable();
      await expect(lstat(join(root, '.readyz'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('removes a planted readiness symlink without touching its target', async () => {
    await withDirectories(async (root, outside) => {
      await mkdir(root, { recursive: true });
      await writeFile(join(outside, 'payload'), 'external bytes');
      await symlink(join(outside, 'payload'), join(root, '.readyz'));

      await expect(createCacheStorage(root).probeWritable()).rejects.toBeInstanceOf(
        StoragePathError,
      );
      await expect(lstat(join(root, '.readyz'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(outside, 'payload'), 'utf8')).resolves.toBe('external bytes');
    });
  });

  it('canonicalizes an operator-configured root symlink, then blocks links beneath it', async () => {
    await withDirectories(async (_root, outside) => {
      const alias = join(outside, 'cache-alias');
      const actual = join(outside, 'actual-cache');
      await mkdir(actual);
      await symlink(actual, alias, 'dir');
      const storage = createCacheStorage(alias);
      const target = storage.versionFile('finland', '261023', 'finland-261023.osm.pbf');
      const part = storage.partFile(JOB_ID);
      await target.ensureParent();
      const handle = await part.open('write');
      await handle.writeFile('under operator-selected root');
      await handle.close();
      await storage.installPart(part, target);

      await expect(readFile(join(actual, target.relativePath), 'utf8')).resolves.toBe(
        'under operator-selected root',
      );
    });
  });
});
