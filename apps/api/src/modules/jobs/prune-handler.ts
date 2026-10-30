/**
 * Safe post-update cache retention for ready map versions (`P4-INT-07`, D-7).
 *
 * The handler keeps the configured number of newest valid ready artifacts, commits row/cache-summary/audit changes
 * atomically, then unlinks only their validated storage files while holding the exclusive country-cache lock.
 *
 * @module modules/jobs/prune-handler
 */

import { z } from 'zod';
import { sql } from 'kysely';

import type { Job, JsonValue } from '../../db/schema';
import { insertAuditLog, AUDIT_ACTIONS } from '../../db/repositories/audit-logs';
import { listActiveCountryJobs } from '../../db/repositories/cache';
import { withTransaction } from '../../db/transaction';
import {
  withCacheCountryMutationLock,
  type CacheMutationLockLogger,
} from '../admin/cache-mutation-lock';
import { createCacheStorage, type CacheStorage, type StorageFile } from '../storage/storage';
import type { JobHandler, JobHandlerContext } from './worker';

const PrunePayloadSchema = z
  .object({
    countryId: z.uuid(),
    keep: z.int().min(1).max(10),
  })
  .strict();

const SILENT_LOGGER: CacheMutationLockLogger = { warn: () => undefined };

/** Dependencies of the registered retention worker handler. */
export interface PruneHandlerOptions {
  /** Cache root on the persistent filesystem. */
  readonly cacheDirectory: string;
  /** Injectable cache boundary for focused storage tests. */
  readonly cacheStorage?: CacheStorage;
}

interface ReadyVersion {
  readonly id: string;
  readonly version: string;
  readonly file_size_bytes: string;
  readonly storage_path: string;
  readonly ready_at: Date | null;
}

interface CheckedVersion extends ReadyVersion {
  readonly file: StorageFile;
}

/** Builds the worker handler for interval-triggered version retention. */
export function createPruneHandler(options: PruneHandlerOptions): JobHandler {
  const storage = options.cacheStorage ?? createCacheStorage(options.cacheDirectory);
  return (job, context) => runPrune(job, context, storage);
}

async function runPrune(
  job: Job,
  context: JobHandlerContext,
  storage: CacheStorage,
): Promise<JsonValue> {
  if (job.type !== 'prune') throw new TypeError('prune handler received a non-prune job');
  const payload = PrunePayloadSchema.parse(job.payload);
  assertNotAborted(context.signal);

  return withCacheCountryMutationLock(
    context.database,
    payload.countryId,
    context.log ?? SILENT_LOGGER,
    async () => {
      assertNotAborted(context.signal);
      const snapshot = await withTransaction(context.database, async (trx) => {
        const country = await trx
          .selectFrom('countries')
          .select(['id', 'slug'])
          .where('id', '=', payload.countryId)
          .forUpdate()
          .executeTakeFirst();
        if (country === undefined) return null;

        const activeJobs = await listActiveCountryJobs(trx, payload.countryId);
        if (
          activeJobs.some(
            ({ id, type }) => id !== job.id && (type === 'download' || type === 'import'),
          )
        ) {
          throw new Error(
            'A download or import is active for this country; retention will retry later.',
          );
        }

        const versions = await trx
          .selectFrom('map_versions')
          .select(['id', 'version', 'file_size_bytes', 'storage_path', 'ready_at'])
          .where('country_id', '=', payload.countryId)
          .where('status', '=', 'ready')
          .orderBy(sql`ready_at DESC NULLS LAST`)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .execute();
        return { country, versions };
      });
      if (snapshot === null) {
        return { countryId: payload.countryId, keep: payload.keep, retained: 0, pruned: 0 };
      }

      const validVersions: CheckedVersion[] = [];
      for (const version of snapshot.versions) {
        assertNotAborted(context.signal);
        if (version.ready_at === null) {
          context.log?.warn(
            { countryId: payload.countryId, versionId: version.id },
            'ready version without ready_at was excluded from retention pruning',
          );
          continue;
        }
        try {
          const file = storage.versionFileAt(version.storage_path);
          const actualSize = await file.size();
          if (actualSize === 0n || actualSize !== BigInt(version.file_size_bytes)) {
            context.log?.warn(
              {
                countryId: payload.countryId,
                versionId: version.id,
                storagePath: version.storage_path,
              },
              'ready version with a missing or inconsistent artifact was preserved during retention pruning',
            );
            continue;
          }
          validVersions.push({ ...version, file });
        } catch (error) {
          context.log?.warn(
            { countryId: payload.countryId, versionId: version.id, err: error },
            'ready version with an invalid storage artifact was preserved during retention pruning',
          );
        }
      }

      const candidates = validVersions.slice(payload.keep);
      if (candidates.length === 0) {
        return {
          countryId: payload.countryId,
          keep: payload.keep,
          retained: validVersions.length,
          pruned: 0,
        };
      }
      assertNotAborted(context.signal);

      const deleted = await withTransaction(context.database, async (trx) => {
        const activeJobs = await listActiveCountryJobs(trx, payload.countryId);
        if (
          activeJobs.some(
            ({ id, type }) => id !== job.id && (type === 'download' || type === 'import'),
          )
        ) {
          throw new Error('A download or import became active before retention could commit.');
        }

        const current = await trx
          .selectFrom('map_versions')
          .select(['id', 'version', 'file_size_bytes', 'storage_path'])
          .where('country_id', '=', payload.countryId)
          .where('status', '=', 'ready')
          .where(
            'id',
            'in',
            candidates.map(({ id }) => id),
          )
          .forUpdate()
          .execute();
        const expectedById = new Map(candidates.map((version) => [version.id, version]));
        const deletable = current.filter((version) => {
          const expected = expectedById.get(version.id);
          return (
            expected !== undefined &&
            expected.storage_path === version.storage_path &&
            expected.version === version.version &&
            BigInt(expected.file_size_bytes) === BigInt(version.file_size_bytes)
          );
        });
        if (deletable.length === 0) {
          return [];
        }

        const ids = deletable.map(({ id }) => id);
        await trx
          .deleteFrom('map_versions')
          .where('country_id', '=', payload.countryId)
          .where('id', 'in', ids)
          .where('status', '=', 'ready')
          .execute();

        const totals = await trx
          .selectFrom('map_versions')
          .select([
            sql<number>`count(*) filter (where status = 'ready')::int`.as('ready_count'),
            sql<string>`coalesce(sum(file_size_bytes) filter (where status = 'ready'), 0)::text`.as(
              'total_size_bytes',
            ),
          ])
          .where('country_id', '=', payload.countryId)
          .executeTakeFirstOrThrow();
        const cache = await trx
          .selectFrom('country_cache')
          .select(['is_public', 'public_since'])
          .where('country_id', '=', payload.countryId)
          .forUpdate()
          .executeTakeFirst();
        if (cache !== undefined) {
          await trx
            .updateTable('country_cache')
            .set({
              is_public: totals.ready_count > 0 && cache.is_public,
              public_since: totals.ready_count > 0 && cache.is_public ? cache.public_since : null,
              versions_ready_count: totals.ready_count,
              total_size_bytes: totals.total_size_bytes,
              update_state: 'unknown',
              available_version: null,
              available_size_bytes: null,
              available_at: null,
              updated_at: new Date(),
            })
            .where('country_id', '=', payload.countryId)
            .execute();
        }

        await insertAuditLog(trx, {
          actorId: null,
          actorName: 'system',
          action: AUDIT_ACTIONS.versionPrune,
          targetType: 'country_cache',
          targetId: payload.countryId,
          metadata: {
            countryId: payload.countryId,
            slug: snapshot.country.slug,
            keep: payload.keep,
            prunedVersions: deletable.map(({ id, version, file_size_bytes: sizeBytes }) => ({
              id,
              version,
              sizeBytes: String(sizeBytes),
            })),
          },
        });
        return deletable;
      });

      for (const version of deleted) {
        try {
          if (!(await storage.versionFileAt(version.storage_path).remove())) {
            context.log?.warn(
              {
                countryId: payload.countryId,
                versionId: version.id,
                storagePath: version.storage_path,
              },
              'pruned version row was deleted but an ancestor symlink blocked file cleanup; orphan sweep required',
            );
          }
        } catch (error) {
          context.log?.warn(
            {
              countryId: payload.countryId,
              versionId: version.id,
              storagePath: version.storage_path,
              err: error,
            },
            'pruned version row was deleted but file cleanup failed; orphan sweep required',
          );
        }
      }

      return {
        countryId: payload.countryId,
        keep: payload.keep,
        retained: validVersions.length - deleted.length,
        pruned: deleted.length,
      };
    },
    context.signal,
  );
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Retention job was canceled.');
}
