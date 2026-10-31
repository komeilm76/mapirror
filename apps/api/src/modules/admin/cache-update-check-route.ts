/** Inline and asynchronous cached-country update-check routes (`P4-UPD-02`).
 *
 * @module modules/admin/cache-update-check-route
 */

import {
  CacheBulkUpdateCheckRequestSchema,
  CacheBulkUpdateCheckResponseSchema,
  CacheCountryParamsSchema,
  CacheUpdateCheckRequestSchema,
  CacheUpdateCheckResponseSchema,
  type CacheBulkUpdateCheckResponse,
  type CacheUpdateCheckResponse,
} from '@mapirror/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../lib/errors';
import { UpdateCheckNotCachedError, type UpdateChecker } from '../updates/update-check';
import { enqueueUpdateCheckJob } from '../jobs/enqueue-update-check';

const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** Handles one bounded inline check. Source failures are represented by the checker's `unknown` state. */
export async function postCacheUpdateCheck(
  request: FastifyRequest,
  checker: UpdateChecker,
): Promise<CacheUpdateCheckResponse> {
  const params = CacheCountryParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;
  const body = CacheUpdateCheckRequestSchema.safeParse(
    request.body === undefined ? {} : request.body,
  );
  if (!body.success) throw body.error;

  try {
    const result = await checker.check(params.data.countryId);
    return CacheUpdateCheckResponseSchema.parse({
      state: result.state,
      cached: {
        version: result.cached.version,
        dataTimestamp: result.cached.dataTimestamp?.toISOString() ?? null,
        sizeBytes: jsonIntegerOrNull(result.cached.sizeBytes),
      },
      source:
        result.source === null
          ? null
          : {
              version: result.source.version,
              dataTimestamp: result.source.dataTimestamp?.toISOString() ?? null,
              sizeBytes: jsonIntegerOrNull(result.source.sizeBytes),
            },
      checkedAt: result.checkedAt.toISOString(),
      reason: result.reason,
    });
  } catch (error) {
    if (error instanceof UpdateCheckNotCachedError) {
      throw new AppError('NOT_FOUND', 'The requested cached country does not exist.');
    }
    throw error;
  }
}

/** Admits one durable bulk check for selected or all cached countries. */
export async function postCacheUpdateChecks(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<CacheBulkUpdateCheckResponse> {
  const body = CacheBulkUpdateCheckRequestSchema.safeParse(
    request.body === undefined ? {} : request.body,
  );
  if (!body.success) throw body.error;

  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  const countryIds = body.data.countryIds;
  if (countryIds !== undefined) {
    const cachedIds = await request.server.db.db
      .selectFrom('country_cache')
      .select('country_id')
      .where('country_id', 'in', countryIds)
      .execute();
    if (cachedIds.length !== countryIds.length) {
      throw new AppError('NOT_FOUND', 'One or more requested countries are not cached.');
    }
  }

  const jobId = await enqueueUpdateCheckJob(request.server.db.db, {
    ...(countryIds === undefined ? {} : { countryIds }),
    createdBy: admin.id,
  });
  const response = CacheBulkUpdateCheckResponseSchema.parse({ jobId });
  reply.code(202);
  return response;
}

function jsonIntegerOrNull(value: string | number | bigint | null): number | string | null {
  if (value === null) return null;
  const integer = typeof value === 'bigint' ? value : BigInt(value);
  return integer <= MAX_SAFE_JSON_INTEGER ? Number(integer) : integer.toString();
}
