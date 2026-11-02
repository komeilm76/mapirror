import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { getImportStatus } from '../../src/modules/admin/import-status-route';

const UPLOAD_ID = '00000000-0000-4000-8000-000000000001';
const JOB_ID = '00000000-0000-4000-8000-000000000002';

function makeRequest(options: { params?: unknown; row?: unknown; missing?: boolean } = {}) {
  const query = {
    leftJoin: vi.fn(() => query),
    select: vi.fn(() => query),
    where: vi.fn(() => query),
    executeTakeFirst: vi.fn((): Promise<unknown> =>
      Promise.resolve(
        options.missing
          ? undefined
          : options.row === undefined
            ? {
                status: 'received',
                size_bytes: '125',
                checksum_md5: 'a'.repeat(32),
                job_id: JOB_ID,
                error_code: null,
              }
            : options.row,
      ),
    ),
  };
  const database = { selectFrom: vi.fn(() => query) };
  const request = {
    params: options.params ?? { uploadId: UPLOAD_ID },
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { uploadId: string } }>;
  return { request, database, query };
}

describe('getImportStatus', () => {
  it('projects safe upload status and leaves successful jobs without an error', async () => {
    const setup = makeRequest();
    await expect(getImportStatus(setup.request)).resolves.toEqual({
      status: 'received',
      sizeBytes: '125',
      checksumMd5: 'a'.repeat(32),
      jobId: JOB_ID,
      error: null,
    });
    expect(setup.query.leftJoin).toHaveBeenCalledWith('jobs as job', 'job.id', 'upload.job_id');
    expect(setup.query.where).toHaveBeenCalledWith('upload.id', '=', UPLOAD_ID);
  });

  it('maps worker loss and arbitrary handler codes to generic safe messages', async () => {
    const workerLost = makeRequest({
      row: {
        status: 'failed',
        size_bytes: 125,
        checksum_md5: null,
        job_id: JOB_ID,
        error_code: 'WORKER_LOST',
      },
    });
    await expect(getImportStatus(workerLost.request)).resolves.toMatchObject({
      error: { code: 'WORKER_LOST', message: 'The worker stopped before this job completed.' },
    });

    const handlerFailed = makeRequest({
      row: {
        status: 'failed',
        size_bytes: 125,
        checksum_md5: null,
        job_id: JOB_ID,
        error_code: 'sensitive exception details',
      },
    });
    await expect(getImportStatus(handlerFailed.request)).resolves.toMatchObject({
      error: { code: 'JOB_HANDLER_FAILED', message: 'The job handler failed.' },
    });
  });

  it('rejects invalid params, missing uploads, uploads without jobs and malformed rows', async () => {
    const invalidParams = makeRequest({ params: { uploadId: 'invalid' } });
    await expect(getImportStatus(invalidParams.request)).rejects.toThrow();
    expect(invalidParams.database.selectFrom).not.toHaveBeenCalled();

    const missing = makeRequest({ missing: true });
    await expect(getImportStatus(missing.request)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const noJob = makeRequest({
      row: {
        status: 'received',
        size_bytes: '1',
        checksum_md5: null,
        job_id: null,
        error_code: null,
      },
    });
    await expect(getImportStatus(noJob.request)).rejects.toThrow(
      'Import upload has no associated job.',
    );

    const malformed = makeRequest({
      row: {
        status: 'mystery',
        size_bytes: '-1',
        checksum_md5: null,
        job_id: JOB_ID,
        error_code: null,
      },
    });
    await expect(getImportStatus(malformed.request)).rejects.toThrow();
  });
});
