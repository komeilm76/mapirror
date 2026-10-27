/**
 * SQL access to immutable map-version rows (`03-data-model.md` §2.5, task `P2-DB-02`).
 *
 * Versions are listed newest-ready-first, with pending/failed rows following in creation order. The explicit `NULLS
 * LAST` matters in PostgreSQL: descending order otherwise puts null `ready_at` values before completed versions.
 *
 * @module db/repositories/map-versions
 */

import { sql } from 'kysely';

import type { MapVersion } from '../schema';
import type { RepositoryExecutor } from './executor';

/** Lists all versions for a country, ready versions first and newest-ready first. */
export async function listMapVersions(
  executor: RepositoryExecutor,
  countryId: string,
): Promise<MapVersion[]> {
  return executor
    .selectFrom('map_versions')
    .selectAll()
    .where('country_id', '=', countryId)
    .orderBy(sql`ready_at DESC NULLS LAST`)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'asc')
    .execute();
}

/** Loads one version by its UUID. */
export async function findMapVersionById(
  executor: RepositoryExecutor,
  versionId: string,
): Promise<MapVersion | null> {
  const row = await executor
    .selectFrom('map_versions')
    .selectAll()
    .where('id', '=', versionId)
    .executeTakeFirst();
  return row ?? null;
}

/** Loads a country's version by its public version label. */
export async function findMapVersionByLabel(
  executor: RepositoryExecutor,
  countryId: string,
  version: string,
): Promise<MapVersion | null> {
  const row = await executor
    .selectFrom('map_versions')
    .selectAll()
    .where('country_id', '=', countryId)
    .where('version', '=', version)
    .executeTakeFirst();
  return row ?? null;
}
