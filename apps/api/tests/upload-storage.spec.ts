import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createUploadStorage, UploadStorageError } from '../src/modules/storage/upload-storage';

const UPLOAD_ID = '3ac68a32-40a4-4ea4-a40b-d2b2e7a4d227';

async function withDirectories<T>(run: (root: string, outside: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), 'mapirror-upload-storage-'));
  const root = join(workspace, 'tmp');
  const outside = join(workspace, 'outside');
  await mkdir(outside);
  try {
    return await run(root, outside);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('upload staging storage', () => {
  it('uses a UUID filename and reconstructs only that persisted relative path', () => {
    const storage = createUploadStorage('/tmp/mapirror-uploads');
    expect(storage.file(UPLOAD_ID).relativePath).toBe(`${UPLOAD_ID}.osm.pbf`);
    expect(storage.fileAt(`${UPLOAD_ID}.osm.pbf`).relativePath).toBe(`${UPLOAD_ID}.osm.pbf`);
    expect(Object.isFrozen(storage.file(UPLOAD_ID))).toBe(true);
  });

  it.each(['../outside', 'not-a-uuid', '3ac68a32-40a4-4ea4-a40b-d2b2e7a4d227/child', ''])(
    'rejects an invalid upload id %s',
    (uploadId) => {
      expect(() => createUploadStorage('/tmp/mapirror-uploads').file(uploadId)).toThrow(
        UploadStorageError,
      );
    },
  );

  it.each([
    '/tmp/outside/upload.osm.pbf',
    '../outside.osm.pbf',
    `${UPLOAD_ID}.pbf`,
    `${UPLOAD_ID}.osm.pbf/child`,
    `${UPLOAD_ID}.osm.pbf\\child`,
    '',
  ])('rejects an unsafe persisted temp_path %s', (relativePath) => {
    expect(() => createUploadStorage('/tmp/mapirror-uploads').fileAt(relativePath)).toThrow(
      UploadStorageError,
    );
  });

  it('creates a new file exclusively, reports its size and removes it', async () => {
    await withDirectories(async (root) => {
      const file = createUploadStorage(root).file(UPLOAD_ID);
      const handle = await file.openForWrite();
      await handle.writeFile('staged map bytes');
      await handle.close();

      await expect(file.size()).resolves.toBe(16n);
      await expect(readFile(join(root, file.relativePath), 'utf8')).resolves.toBe(
        'staged map bytes',
      );
      await expect(file.openForWrite()).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(file.remove()).resolves.toBe(true);
      await expect(file.remove()).resolves.toBe(false);
      await expect(file.size()).resolves.toBe(0n);
    });
  });

  it('allows an operator-configured root symlink but writes beneath its canonical target', async () => {
    await withDirectories(async (_root, outside) => {
      const actual = join(outside, 'actual-tmp');
      const alias = join(outside, 'tmp-alias');
      await mkdir(actual);
      await symlink(actual, alias, 'dir');
      const file = createUploadStorage(alias).file(UPLOAD_ID);
      const handle = await file.openForWrite();
      await handle.writeFile('staged');
      await handle.close();

      await expect(readFile(join(actual, file.relativePath), 'utf8')).resolves.toBe('staged');
    });
  });

  it('removes a leaf symlink without following or deleting its target', async () => {
    await withDirectories(async (root, outside) => {
      await mkdir(root);
      const target = join(outside, 'payload');
      const filePath = join(root, `${UPLOAD_ID}.osm.pbf`);
      await writeFile(target, 'external bytes');
      await symlink(target, filePath);

      const file = createUploadStorage(root).file(UPLOAD_ID);
      await expect(file.openForWrite()).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(file.size()).rejects.toBeInstanceOf(UploadStorageError);
      await expect(file.remove()).resolves.toBe(true);
      await expect(lstat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(target, 'utf8')).resolves.toBe('external bytes');
    });
  });

  it('refuses to remove a directory with the generated filename', async () => {
    await withDirectories(async (root) => {
      const filePath = join(root, `${UPLOAD_ID}.osm.pbf`);
      await mkdir(filePath, { recursive: true });
      await writeFile(join(filePath, 'keep'), 'preserved');

      await expect(createUploadStorage(root).file(UPLOAD_ID).remove()).rejects.toBeInstanceOf(
        UploadStorageError,
      );
      await expect(readFile(join(filePath, 'keep'), 'utf8')).resolves.toBe('preserved');
    });
  });
});
