/**
 * Manual catalog synchronization trigger (`P2-API-02`).
 *
 * @module modules/admin/catalog-sync-route
 */

import {
  CatalogSyncRequestSchema,
  CatalogSyncResponseSchema,
  type CatalogSyncResponse,
} from '@mapirror/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../lib/errors';
import { enqueueCatalogSyncJob } from '../jobs/enqueue-catalog-sync';

/**
 * Validates the empty request contract and queues (or reuses) the active Geofabrik sync job.
 *
 * @param request - Authenticated admin request.
 * @param reply - Fastify reply, used to return the accepted status.
 * @returns The durable job id in a `202 Accepted` response.
 */
export async function postCatalogSync(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<CatalogSyncResponse> {
  const body = request.body === undefined ? {} : request.body;
  const parsed = CatalogSyncRequestSchema.safeParse(body);
  if (!parsed.success) throw parsed.error;

  const admin = request.authenticatedAdmin;
  if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  const jobId = await enqueueCatalogSyncJob(request.server.db.db, { createdBy: admin.id });
  const response = CatalogSyncResponseSchema.parse({ jobId });
  reply.code(202);
  return response;
}
