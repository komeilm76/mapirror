/** Toggle public visibility for one cached catalog country (`P3-API-02`).
 *
 * @module modules/admin/cache-public-route
 */

import {
  CacheCountryParamsSchema,
  CachePublicToggleBodySchema,
  CachePublicToggleResponseSchema,
  type CachePublicToggleResponse,
} from '@mapirror/shared';
import { sql } from 'kysely';
import type { FastifyRequest } from 'fastify';

import { insertAuditLog, AUDIT_ACTIONS } from '../../db/repositories/audit-logs';
import { withTransaction } from '../../db/transaction';
import { normaliseIp } from '../../lib/client-ip';
import { AppError } from '../../lib/errors';

/** Handles `POST /_admin/api/cache/:countryId/public`; the visibility change and audit row commit together. */
export async function postCachePublic(
  request: FastifyRequest<{ Params: { countryId: string } }>,
): Promise<CachePublicToggleResponse> {
  const params = CacheCountryParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;
  const body = CachePublicToggleBodySchema.safeParse(request.body);
  if (!body.success) throw body.error;

  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  const result = await withTransaction(request.server.db.db, async (trx) => {
    // Cache deletion and version deletion lock the country row first. Taking the same lock makes the ready-version
    // check and publication decision serial with removal of the last ready version.
    const country = await trx
      .selectFrom('countries')
      .select(['id', 'slug'])
      .where('id', '=', params.data.countryId)
      .forUpdate()
      .executeTakeFirst();
    if (country === undefined) {
      throw new AppError('NOT_FOUND', 'The requested cached country does not exist.');
    }

    const cache = await trx
      .selectFrom('country_cache')
      .select(['is_public', 'public_since'])
      .where('country_id', '=', country.id)
      .forUpdate()
      .executeTakeFirst();
    if (cache === undefined) {
      throw new AppError('NOT_FOUND', 'The requested cached country does not exist.');
    }

    if (body.data.isPublic) {
      const readyVersion = await trx
        .selectFrom('map_versions')
        .select('id')
        .where('country_id', '=', country.id)
        .where('status', '=', 'ready')
        .limit(1)
        .executeTakeFirst();
      if (readyVersion === undefined) {
        throw new AppError('NO_READY_VERSION', 'This country has no ready map version to publish.');
      }
    }

    const before = cache.is_public;
    const after = body.data.isPublic;
    if (before === after) {
      return {
        isPublic: after,
        publicSince: after ? (cache.public_since?.toISOString() ?? null) : null,
      };
    }

    const updated = await trx
      .updateTable('country_cache')
      .set({ is_public: after, public_since: after ? sql<Date>`now()` : null })
      .where('country_id', '=', country.id)
      .returning('public_since')
      .executeTakeFirstOrThrow();

    await insertAuditLog(trx, {
      actorId: admin.id,
      actorName: admin.username,
      action: after ? AUDIT_ACTIONS.cachePublish : AUDIT_ACTIONS.cacheUnpublish,
      targetType: 'country',
      targetId: country.id,
      ip: normaliseIp(request.ip),
      metadata: {
        slug: country.slug,
        beforeIsPublic: before,
        afterIsPublic: after,
      },
    });

    return { isPublic: after, publicSince: updated.public_since?.toISOString() ?? null };
  });

  return CachePublicToggleResponseSchema.parse(result);
}
