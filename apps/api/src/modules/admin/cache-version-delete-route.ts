/** Delete one cached map version with audit and safe post-commit cleanup (`P2-API-08`).
 *
 * @module modules/admin/cache-version-delete-route
 */

import {
  CacheVersionDeleteBodySchema,
  CacheVersionDeleteParamsSchema,
  CacheVersionDeleteQuerySchema,
} from '@mapirror/shared';
import { sql } from 'kysely';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/env';
import { findCountryCache, listActiveCountryJobs } from '../../db/repositories/cache';
import { AUDIT_ACTIONS, insertAuditLog } from '../../db/repositories/audit-logs';
import { withTransaction } from '../../db/transaction';
import { normaliseIp } from '../../lib/client-ip';
import { AppError } from '../../lib/errors';
import { withCacheCountryMutationLock } from './cache-mutation-lock';
import { createCacheStorage } from '../storage/storage';

/** Dependencies for the authenticated single-version delete handler. */
export interface CacheVersionDeleteRouteOptions {
  readonly config: AppConfig;
}

/** Creates `DELETE /_admin/api/cache/:countryId/versions/:versionId`. */
export function createCacheVersionDeleteHandler(options: CacheVersionDeleteRouteOptions) {
  const storage = createCacheStorage(options.config.cacheDir);

  return async function deleteCachedVersion(
    request: FastifyRequest<{ Params: { countryId: string; versionId: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const params = CacheVersionDeleteParamsSchema.safeParse(request.params);
    if (!params.success) throw params.error;
    const query = CacheVersionDeleteQuerySchema.safeParse(request.query);
    if (!query.success) throw query.error;
    const body = CacheVersionDeleteBodySchema.safeParse(
      request.body === undefined ? {} : request.body,
    );
    if (!body.success) throw body.error;

    const queryConfirmed = query.data.confirm === 'true';
    if (
      query.data.confirm !== undefined &&
      body.data.confirm !== undefined &&
      queryConfirmed !== body.data.confirm
    ) {
      throw confirmationRequired(params.data.versionId);
    }
    if (!queryConfirmed && body.data.confirm !== true) {
      throw confirmationRequired(params.data.versionId);
    }

    const admin = request.authenticatedAdmin;
    if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

    const { countryId, versionId } = params.data;
    await request.server.db.db.connection().execute(async (connection) => {
      await withCacheCountryMutationLock(connection, countryId, request.log, async () => {
        const deleted = await withTransaction(connection, async (trx) => {
          const country = await trx
            .selectFrom('countries')
            .select(['id', 'slug'])
            .where('id', '=', countryId)
            .forUpdate()
            .executeTakeFirst();
          if (country === undefined) {
            throw new AppError('NOT_FOUND', 'The requested cached version does not exist.');
          }

          const cache = await findCountryCache(trx, countryId);
          if (cache === null) {
            throw new AppError('NOT_FOUND', 'The requested cached version does not exist.');
          }

          const version = await trx
            .selectFrom('map_versions')
            .select([
              'id',
              'version',
              'origin',
              'file_size_bytes',
              'checksum_md5',
              'checksum_sha256',
              'storage_path',
              'status',
            ])
            .where('country_id', '=', countryId)
            .where('id', '=', versionId)
            .forUpdate()
            .executeTakeFirst();
          if (version === undefined) {
            throw new AppError('NOT_FOUND', 'The requested cached version does not exist.');
          }

          const activeJobs = await listActiveCountryJobs(trx, countryId);
          if (activeJobs.length > 0) {
            throw new AppError(
              'JOB_ALREADY_RUNNING',
              'This country has queued or running work. Wait for it to finish before deleting a version.',
              { countryId, jobIds: activeJobs.map(({ id }) => id) },
            );
          }

          // Validate the persisted relative path before deleting the row; only a safe storage reference crosses commit.
          const storageFile = storage.versionFileAt(version.storage_path);
          await trx
            .deleteFrom('map_versions')
            .where('country_id', '=', countryId)
            .where('id', '=', versionId)
            .execute();

          const remaining = await trx
            .selectFrom('map_versions')
            .select([
              sql<string>`count(*)::text`.as('version_count'),
              sql<string>`count(*) filter (where status = 'ready')::text`.as('ready_count'),
              sql<string>`coalesce(sum(file_size_bytes) filter (where status = 'ready'), 0)::text`.as(
                'total_size_bytes',
              ),
            ])
            .where('country_id', '=', countryId)
            .executeTakeFirstOrThrow();
          const remainingVersionCount = safeCount(remaining.version_count, 'version count');
          const versionsReadyCount = safeCount(remaining.ready_count, 'ready version count');
          const totalSizeBytes = nonNegativeBigintText(remaining.total_size_bytes);
          const wasLastVersion = remainingVersionCount === 0;
          const unpublishes = cache.is_public && versionsReadyCount === 0;

          if (wasLastVersion) {
            await trx.deleteFrom('country_cache').where('country_id', '=', countryId).execute();
          } else {
            await trx
              .updateTable('country_cache')
              .set({
                is_public: versionsReadyCount > 0 && cache.is_public,
                public_since: versionsReadyCount > 0 && cache.is_public ? cache.public_since : null,
                versions_ready_count: versionsReadyCount,
                total_size_bytes: totalSizeBytes,
                update_state: 'unknown',
                available_version: null,
                available_size_bytes: null,
                available_at: null,
                updated_at: new Date(),
              })
              .where('country_id', '=', countryId)
              .execute();
          }

          await insertAuditLog(trx, {
            actorId: admin.id,
            actorName: admin.username,
            action: AUDIT_ACTIONS.versionDelete,
            targetType: 'map_version',
            targetId: version.id,
            ip: normaliseIp(request.ip),
            metadata: {
              countryId,
              slug: country.slug,
              version: version.version,
              origin: version.origin,
              status: version.status,
              sizeBytes: nonNegativeBigintText(version.file_size_bytes),
              checksumMd5: version.checksum_md5,
              checksumSha256: version.checksum_sha256,
              wasLastVersion,
              wasPublic: cache.is_public,
              unpublished: unpublishes,
            },
          });

          return {
            file: storageFile,
            storagePath: version.storage_path,
            version: version.version,
          };
        });

        try {
          await deleted.file.remove();
        } catch (error) {
          request.log.warn(
            {
              err: error,
              countryId,
              versionId,
              version: deleted.version,
              storagePath: deleted.storagePath,
            },
            'map version was deleted from the database but its file could not be removed; orphan sweep required',
          );
        }
      });
    });

    await reply.code(204).send();
  };
}

/** Exact `true` is required in the query or JSON body. */
function confirmationRequired(versionId: string): AppError<{ versionId: string }> {
  return new AppError(
    'CONFIRMATION_REQUIRED',
    'Confirm deletion of this version with confirm=true.',
    { versionId },
  );
}

/** Converts a PostgreSQL count to a bounded JS integer suitable for `country_cache.versions_ready_count`. */
function safeCount(value: string, label: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new RangeError(`map version ${label} is invalid`);
  const count = BigInt(value);
  if (count > 2_147_483_647n)
    throw new RangeError(`map version ${label} exceeds PostgreSQL integer range`);
  return Number(count);
}

/** Validates PostgreSQL int8/numeric text without coercion or precision loss. */
function nonNegativeBigintText(value: string): string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RangeError('map version byte count is not a non-negative decimal integer');
  }
  return value;
}
