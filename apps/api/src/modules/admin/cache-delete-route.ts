/** Delete all cached versions for one catalog country (`P2-API-06`).
 *
 * @module modules/admin/cache-delete-route
 */

import {
  CacheCountryDeleteBodySchema,
  CacheCountryDeleteQuerySchema,
  CacheCountryParamsSchema,
} from '@mapirror/shared';
import type { Kysely } from 'kysely';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/env';
import { findCountryCache, listActiveCountryJobs } from '../../db/repositories/cache';
import { insertAuditLog, AUDIT_ACTIONS } from '../../db/repositories/audit-logs';
import type { Database } from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import { normaliseIp } from '../../lib/client-ip';
import { AppError } from '../../lib/errors';
import { createCacheStorage } from '../storage/storage';
import { requestJobCancellation } from '../jobs/cancellation';
import { withCacheCountryMutationLock } from './cache-mutation-lock';

const COUNTRY_JOB_CANCEL_WAIT_MS = 3_000;
const JOB_POLL_INTERVAL_MS = 50;

/** Dependencies for the authenticated cache-country delete handler. */
export interface CacheDeleteRouteOptions {
  readonly config: AppConfig;
}

/** Creates `DELETE /_admin/api/cache/:countryId`; DB removal commits before safe file unlinking. */
export function createCacheDeleteHandler(options: CacheDeleteRouteOptions) {
  const storage = createCacheStorage(options.config.cacheDir);

  return async function deleteCachedCountry(
    request: FastifyRequest<{ Params: { countryId: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const params = CacheCountryParamsSchema.safeParse(request.params);
    if (!params.success) throw params.error;
    const query = CacheCountryDeleteQuerySchema.safeParse(request.query);
    if (!query.success) throw query.error;
    const body = CacheCountryDeleteBodySchema.safeParse(
      request.body === undefined ? {} : request.body,
    );
    if (!body.success) throw body.error;
    if (
      query.data.confirm !== undefined &&
      body.data.confirm !== undefined &&
      query.data.confirm !== body.data.confirm
    ) {
      throw confirmationRequired(params.data.countryId);
    }

    const admin = request.authenticatedAdmin;
    if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

    const countryId = params.data.countryId;
    const confirmation = body.data.confirm ?? query.data.confirm;
    const cancelJobs = query.data.cancelJobs === 'true';
    await request.server.db.db.connection().execute(async (connection) => {
      await withCacheCountryMutationLock(connection, countryId, request.log, async () => {
        const storagePaths = await (async () => {
          const cancelDeadline = Date.now() + COUNTRY_JOB_CANCEL_WAIT_MS;
          while (true) {
            const result = await withTransaction(connection, async (trx) => {
              const country = await trx
                .selectFrom('countries')
                .select(['id', 'slug'])
                .where('id', '=', countryId)
                .forUpdate()
                .executeTakeFirst();
              if (country === undefined) {
                throw new AppError('NOT_FOUND', 'The requested cached country does not exist.');
              }
              if (country.slug !== confirmation) throw confirmationRequired(countryId);

              const cache = await findCountryCache(trx, countryId);
              if (cache === null) {
                throw new AppError('NOT_FOUND', 'The requested cached country does not exist.');
              }

              const activeJobs = await listActiveCountryJobs(trx, countryId);
              if (activeJobs.length > 0) {
                return { kind: 'active' as const, jobIds: activeJobs.map(({ id }) => id) };
              }

              const versions = await trx
                .selectFrom('map_versions')
                .select('storage_path')
                .where('country_id', '=', countryId)
                .execute();

              await trx.deleteFrom('map_versions').where('country_id', '=', countryId).execute();
              // The catalog row is deliberately preserved, so ON DELETE CASCADE on countries does not clear this
              // scheduling relationship. An explicit cache-country deletion opts the country out of every interval.
              await trx
                .deleteFrom('interval_countries')
                .where('country_id', '=', countryId)
                .execute();
              await trx.deleteFrom('country_cache').where('country_id', '=', countryId).execute();
              await insertAuditLog(trx, {
                actorId: admin.id,
                actorName: admin.username,
                action: AUDIT_ACTIONS.cacheDeleteCountry,
                targetType: 'country',
                targetId: countryId,
                ip: normaliseIp(request.ip),
                metadata: {
                  slug: country.slug,
                  versionCount: versions.length,
                  totalSizeBytes: cache.total_size_bytes,
                  wasPublic: cache.is_public,
                },
              });
              return {
                kind: 'deleted' as const,
                storagePaths: versions.map(({ storage_path }) => storage_path),
              };
            });

            if (result.kind === 'deleted') return result.storagePaths;
            if (!cancelJobs) throw activeJobsConflict(countryId, result.jobIds);

            await Promise.all(
              result.jobIds.map((jobId) => requestJobCancellation(connection, jobId)),
            );
            const stillActive = await waitForCountryJobs(connection, countryId, cancelDeadline);
            if (stillActive.length > 0) {
              throw activeJobsConflict(
                countryId,
                stillActive.map(({ id }) => id),
                'Active work has not finished cleanup yet. Try deleting again shortly.',
              );
            }
          }
        })();

        for (const storagePath of storagePaths) {
          try {
            const removed = await storage.versionFileAt(storagePath).remove();
            if (!removed) {
              request.log.warn(
                { countryId, storagePath },
                'cache file row was deleted but an ancestor symlink blocked leaf cleanup; orphan sweep required',
              );
            }
          } catch (error) {
            request.log.warn(
              { err: error, countryId, storagePath },
              'cache country was deleted from the database but a file could not be removed; orphan sweep required',
            );
          }
        }
      });
    });

    await reply.code(204).send();
  };
}

/** Waits only while cooperative workers clean up; a timed-out delete leaves the cache rows intact. */
async function waitForCountryJobs(database: Kysely<Database>, countryId: string, deadline: number) {
  while (Date.now() < deadline) {
    const active = await listActiveCountryJobs(database, countryId);
    if (active.length === 0) return active;
    await delay(JOB_POLL_INTERVAL_MS);
  }
  return listActiveCountryJobs(database, countryId);
}

/** One timer primitive shared by lock/cancellation polling. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function confirmationRequired(countryId: string): AppError<{ countryId: string }> {
  return new AppError(
    'CONFIRMATION_REQUIRED',
    'Type the country slug exactly to confirm this deletion.',
    { countryId },
  );
}

function activeJobsConflict(
  countryId: string,
  jobIds: string[],
  message = 'This country has queued or running jobs. Cancel them before deleting its cache.',
): AppError<{ countryId: string; jobIds: string[] }> {
  return new AppError('JOB_ALREADY_RUNNING', message, { countryId, jobIds });
}
