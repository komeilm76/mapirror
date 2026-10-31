/** Read-only cache-volume consistency report (`P5-MON-05`, L6).
 *
 * @module modules/system/storage-orphans
 */

import type { SystemStatusResponse } from '@mapirror/shared';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/schema';
import { CACHE_PROBE_FILE, type CacheStorage } from '../storage/storage';

/**
 * Counts storage entries that have no ready database row.
 *
 * Ready artifacts and paths owned by queued/running jobs are excluded. The reserved readiness probe and the
 * `.partial` container are also excluded; a `.part` is excluded only while its job remains active. No path or filename
 * is returned to callers. The scan uses the storage boundary's non-following listing, so symlink targets are never
 * inspected.
 *
 * @param database - Application database.
 * @param storage - Cache storage boundary for the configured root.
 * @returns A safe aggregate suitable for `storage.orphans` in system status.
 */
export async function readCacheOrphanReport(
  database: Kysely<Database>,
  storage: CacheStorage,
): Promise<NonNullable<SystemStatusResponse['storage']['orphans']>> {
  const [versions, activeJobs, entries] = await Promise.all([
    database.selectFrom('map_versions').select(['storage_path', 'status', 'job_id']).execute(),
    database.selectFrom('jobs').select('id').where('status', 'in', ['queued', 'running']).execute(),
    storage.listEntries(),
  ]);

  const activeJobIds = new Set(activeJobs.map(({ id }) => id));
  const readyPaths = new Set(
    versions.filter(({ status }) => status === 'ready').map(({ storage_path }) => storage_path),
  );
  const activeInstallPaths = new Set(
    versions
      .filter(
        ({ status, job_id }) => status === 'pending' && job_id !== null && activeJobIds.has(job_id),
      )
      .map(({ storage_path }) => storage_path),
  );
  const activePartPaths = new Set([...activeJobIds].map((jobId) => `.partial/${jobId}.part`));
  const expectedPaths = new Set([...readyPaths, ...activeInstallPaths]);
  const directoriesWithDescendants = new Set<string>();
  for (const { relativePath } of entries) {
    let separator = relativePath.indexOf('/');
    while (separator !== -1) {
      directoriesWithDescendants.add(relativePath.slice(0, separator));
      separator = relativePath.indexOf('/', separator + 1);
    }
  }
  let count = 0;
  let bytes = 0n;

  for (const entry of entries) {
    if (entry.kind === 'file' && expectedPaths.has(entry.relativePath)) continue;
    if (
      (entry.relativePath === CACHE_PROBE_FILE && entry.kind === 'file') ||
      (entry.relativePath === '.partial' && entry.kind === 'directory')
    ) {
      continue;
    }
    if (entry.kind === 'directory') {
      if (directoriesWithDescendants.has(entry.relativePath)) continue;
      count += 1;
      continue;
    }
    if (entry.kind === 'file' && activePartPaths.has(entry.relativePath)) continue;
    count += 1;
    if (entry.kind === 'file') bytes += entry.sizeBytes;
  }

  if (!Number.isSafeInteger(count))
    throw new RangeError('cache orphan count exceeds the JSON safe integer range');
  return {
    count,
    bytes: bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : bytes.toString(),
  };
}
