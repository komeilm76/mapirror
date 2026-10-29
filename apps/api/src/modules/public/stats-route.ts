/** Anonymous aggregate stats for the published country catalogue (`P3-API-06`).
 *
 * @module modules/public/stats-route
 */

import {
  PublicStatsQuerySchema,
  PublicStatsResponseSchema,
  type PublicStatsResponse,
} from '@mapirror/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { getPublicStats } from '../../db/repositories/public-catalog';

const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** Handles `GET /_public/api/stats` from one repeatable-read snapshot. */
export async function getPublicStatsResponse(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<PublicStatsResponse> {
  const parsed = PublicStatsQuerySchema.safeParse(request.query);
  if (!parsed.success) throw parsed.error;

  const stats = await request.server.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute((trx) => getPublicStats(trx));
  reply.header('Cache-Control', 'no-store');

  return PublicStatsResponseSchema.parse({
    countries: jsonInteger(stats.countries),
    totalSizeBytes: jsonInteger(stats.total_size_bytes),
    downloads30d: jsonInteger(stats.downloads_30d),
    totalDownloads: jsonInteger(stats.total_downloads),
    lastPublishedAt: stats.last_published_at?.toISOString() ?? null,
  });
}

/** Preserves exact bigint values while using ordinary JSON numbers where they remain precise. */
function jsonInteger(value: string): number | string {
  const integer = BigInt(value);
  return integer <= MAX_SAFE_JSON_INTEGER ? Number(integer) : integer.toString();
}
