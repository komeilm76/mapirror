import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/db/schema';
import { createCacheStorage } from '../src/modules/storage/storage';
import { readCacheOrphanReport } from '../src/modules/system/storage-orphans';
import {
  STALE_PART_RETENTION_MS,
  sweepStalePartFiles,
} from '../src/modules/system/storage-reconciliation';

const READY_JOB = '3ac68a32-40a4-4ea4-a40b-d2b2e7a4d227';
const ACTIVE_JOB = 'ea699b4e-bbda-451a-aed0-9a9c4d109022';

function fakeDatabase(
  versions: readonly {
    storage_path: string;
    status: 'pending' | 'ready' | 'failed';
    job_id: string | null;
  }[],
  activeJobs: readonly { id: string }[],
): Kysely<Database> {
  return {
    selectFrom: (table: string) => {
      const builder = {
        select: () => builder,
        where: () => builder,
        execute: () => Promise.resolve(table === 'map_versions' ? versions : activeJobs),
      };
      return builder;
    },
  } as unknown as Kysely<Database>;
}

async function writePart(
  storage: ReturnType<typeof createCacheStorage>,
  jobId: string,
  content: string,
  country: string,
  version: string,
  filename: string,
): Promise<string> {
  const part = storage.partFile(jobId);
  const target = storage.versionFile(country, version, filename);
  await part.ensureParent();
  const handle = await part.open('write');
  await handle.writeFile(content);
  await handle.close();
  await storage.installPart(part, target);
  return target.relativePath;
}

describe('readCacheOrphanReport', () => {
  it('counts unreferenced entries without exposing paths and ignores ready or active-job files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mapirror-orphans-'));
    const cacheDirectory = join(workspace, 'cache');
    const outsideDirectory = join(workspace, 'outside');
    await mkdir(outsideDirectory);
    const storage = createCacheStorage(cacheDirectory);

    try {
      const readyPath = await writePart(
        storage,
        READY_JOB,
        'ready bytes',
        'finland',
        '261023',
        'finland-261023.osm.pbf',
      );
      const pendingPath = await writePart(
        storage,
        ACTIVE_JOB,
        'installing bytes',
        'norway',
        '261024',
        'norway-261024.osm.pbf',
      );
      const activePart = storage.partFile('047c99a0-9bdb-4901-98a5-a8d1774eabcc');
      await activePart.ensureParent();
      const activeHandle = await activePart.open('write');
      await activeHandle.writeFile('active part');
      await activeHandle.close();

      const orphanPath = join(cacheDirectory, 'finland', 'old', 'old.osm.pbf');
      await mkdir(join(cacheDirectory, 'finland', 'old'), { recursive: true });
      await writeFile(orphanPath, 'orphan bytes');
      await mkdir(join(cacheDirectory, 'empty-directory'));
      await writeFile(join(outsideDirectory, 'secret'), 'not scanned');
      await symlink(outsideDirectory, join(cacheDirectory, 'external-link'), 'dir');

      const report = await readCacheOrphanReport(
        fakeDatabase(
          [
            { storage_path: readyPath, status: 'ready', job_id: READY_JOB },
            { storage_path: pendingPath, status: 'pending', job_id: ACTIVE_JOB },
          ],
          [{ id: ACTIVE_JOB }, { id: '047c99a0-9bdb-4901-98a5-a8d1774eabcc' }],
        ),
        storage,
      );

      expect(report).toEqual({ count: 3, bytes: 12 });
      expect(JSON.stringify(report)).not.toContain('old.osm.pbf');
      expect(JSON.stringify(report)).not.toContain('external-link');
      expect(JSON.stringify(report)).not.toContain('secret');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reports an inactive partial artifact as an orphan but does not follow its symlink', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mapirror-orphan-part-'));
    const cacheDirectory = join(workspace, 'cache');
    const outsideDirectory = join(workspace, 'outside');
    await mkdir(outsideDirectory);
    const storage = createCacheStorage(cacheDirectory);

    try {
      const part = storage.partFile('047c99a0-9bdb-4901-98a5-a8d1774eabcc');
      await part.ensureParent();
      const handle = await part.open('write');
      await handle.writeFile('stray');
      await handle.close();
      await writeFile(join(outsideDirectory, 'outside'), 'external');
      await symlink(
        join(outsideDirectory, 'outside'),
        join(cacheDirectory, '.partial', 'linked.part'),
      );

      await expect(readCacheOrphanReport(fakeDatabase([], []), storage)).resolves.toEqual({
        count: 2,
        bytes: 5,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('sweeps only stale unowned UUID part files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mapirror-part-sweep-'));
    const cacheDirectory = join(workspace, 'cache');
    const storage = createCacheStorage(cacheDirectory);
    const now = new Date('2026-10-25T09:00:00.000Z');
    const staleId = 'c914807c-a870-4654-bb52-c087be2d9da2';
    const activeId = 'b2a58853-95bd-405a-b259-93eb3ad7ff8b';

    try {
      for (const [id, text] of [
        [staleId, 'stale'],
        [activeId, 'active'],
      ] as const) {
        const part = storage.partFile(id);
        await part.ensureParent();
        const handle = await part.open('write');
        await handle.writeFile(text);
        await handle.close();
        const oldTime = new Date(now.getTime() - STALE_PART_RETENTION_MS - 1_000);
        await utimes(join(cacheDirectory, '.partial', `${id}.part`), oldTime, oldTime);
      }
      const log = { info: vi.fn(), warn: vi.fn() };

      await expect(
        sweepStalePartFiles(fakeDatabase([], [{ id: activeId }]), storage, log, now),
      ).resolves.toBe(1);

      await expect(storage.partFile(staleId).size()).resolves.toBe(0n);
      await expect(storage.partFile(activeId).size()).resolves.toBe(6n);
      expect(log.info).toHaveBeenCalledWith({ removed: 1 }, 'stale cache part files removed');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
