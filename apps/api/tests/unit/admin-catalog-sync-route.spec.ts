import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const mocks = vi.hoisted(() => ({ enqueueCatalogSyncJob: vi.fn() }));
vi.mock('../../src/modules/jobs/enqueue-catalog-sync', () => ({
  enqueueCatalogSyncJob: mocks.enqueueCatalogSyncJob,
}));

import { postCatalogSync } from '../../src/modules/admin/catalog-sync-route';

const JOB_ID = '00000000-0000-4000-8000-000000000001';

function makeSetup(
  options: {
    body?: unknown;
    admin?: { id: string; username: string } | null;
  } = {},
) {
  const database = {};
  const request = {
    body: options.body,
    authenticatedAdmin:
      options.admin === undefined ? { id: 'admin-id', username: 'operator' } : options.admin,
    server: { db: { db: database } },
  } as unknown as FastifyRequest;
  const code = vi.fn();
  const reply = { code } as unknown as FastifyReply;
  return { request, reply, code, database };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enqueueCatalogSyncJob.mockResolvedValue(JOB_ID);
});

describe('postCatalogSync', () => {
  it('queues or reuses the sync job and responds with 202', async () => {
    const setup = makeSetup();
    await expect(postCatalogSync(setup.request, setup.reply)).resolves.toEqual({ jobId: JOB_ID });
    expect(mocks.enqueueCatalogSyncJob).toHaveBeenCalledWith(setup.database, {
      createdBy: 'admin-id',
    });
    expect(setup.code).toHaveBeenCalledWith(202);
  });

  it('defaults an omitted body to the strict empty request and rejects extra data', async () => {
    const omittedBody = makeSetup();
    await postCatalogSync(omittedBody.request, omittedBody.reply);

    const invalidBody = makeSetup({ body: { force: true } });
    await expect(postCatalogSync(invalidBody.request, invalidBody.reply)).rejects.toThrow();
    expect(mocks.enqueueCatalogSyncJob).toHaveBeenCalledOnce();
  });

  it('requires an authenticated administrator before enqueueing', async () => {
    const setup = makeSetup({ admin: null });
    await expect(postCatalogSync(setup.request, setup.reply)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(mocks.enqueueCatalogSyncJob).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted job ids rather than returning an invalid response', async () => {
    mocks.enqueueCatalogSyncJob.mockResolvedValue('bad-id');
    const setup = makeSetup();
    await expect(postCatalogSync(setup.request, setup.reply)).rejects.toThrow();
    expect(setup.code).not.toHaveBeenCalled();
  });
});
