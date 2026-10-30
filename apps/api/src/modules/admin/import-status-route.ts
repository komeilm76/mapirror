/** Read the safe status projection for one administrator import upload (`P4-IMP-03`).
 *
 * @module modules/admin/import-status-route
 */

import {
  ImportStatusParamsSchema,
  ImportStatusResponseSchema,
  type ImportStatusResponse,
} from '@mapirror/shared';
import type { FastifyRequest } from 'fastify';

import { AppError } from '../../lib/errors';

const JOB_HANDLER_FAILED_MESSAGE = 'The job handler failed.';
const WORKER_LOST_MESSAGE = 'The worker stopped before this job completed.';

/** Handles `GET /_admin/api/imports/:uploadId` without exposing raw job errors. */
export async function getImportStatus(
  request: FastifyRequest<{ Params: { uploadId: string } }>,
): Promise<ImportStatusResponse> {
  const params = ImportStatusParamsSchema.safeParse(request.params);
  if (!params.success) throw params.error;

  const row = await request.server.db.db
    .selectFrom('upload_sessions as upload')
    .leftJoin('jobs as job', 'job.id', 'upload.job_id')
    .select([
      'upload.status',
      'upload.size_bytes',
      'upload.checksum_md5',
      'upload.job_id',
      'job.error_code',
    ])
    .where('upload.id', '=', params.data.uploadId)
    .executeTakeFirst();
  if (row === undefined)
    throw new AppError('NOT_FOUND', 'The requested import upload does not exist.');
  if (row.job_id === null) throw new Error('Import upload has no associated job.');

  return ImportStatusResponseSchema.parse({
    status: row.status,
    sizeBytes: row.size_bytes,
    checksumMd5: row.checksum_md5,
    jobId: row.job_id,
    error: safeJobError(row.error_code),
  });
}

function safeJobError(code: string | null): ImportStatusResponse['error'] {
  if (code === null) return null;
  if (code === 'WORKER_LOST') {
    return { code: 'WORKER_LOST', message: WORKER_LOST_MESSAGE };
  }
  return { code: 'JOB_HANDLER_FAILED', message: JOB_HANDLER_FAILED_MESSAGE };
}
