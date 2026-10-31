import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { AppError } from '../src/lib/errors';
import {
  postCacheUpdateCheck,
  postCacheUpdateChecks,
} from '../src/modules/admin/cache-update-check-route';
import { UpdateCheckNotCachedError, type UpdateChecker } from '../src/modules/updates/update-check';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const JOB_ID = '00000000-0000-4000-8000-000000000002';

function makeRequest(
  input: {
    readonly body?: unknown;
    readonly params?: unknown;
    readonly cachedIds?: readonly string[];
    readonly adminId?: string | null;
  } = {},
) {
  const where = vi.fn(() => query);
  const execute = vi.fn(() =>
    Promise.resolve((input.cachedIds ?? []).map((country_id) => ({ country_id }))),
  );
  const query = { select: vi.fn(() => query), where, execute };
  const executeTakeFirstOrThrow = vi.fn(() => Promise.resolve({ id: JOB_ID }));
  const returning = vi.fn(() => ({ executeTakeFirstOrThrow }));
  const values = vi.fn(() => ({ returning }));
  const insertInto = vi.fn(() => ({ values }));
  const database = { selectFrom: vi.fn(() => query), insertInto };
  const request = {
    body: input.body,
    params: input.params ?? { countryId: COUNTRY_ID },
    authenticatedAdmin: input.adminId === null ? null : { id: input.adminId ?? 'admin-id' },
    server: { db: { db: database } },
  } as unknown as FastifyRequest;
  const setStatus = vi.fn(() => reply);
  const reply = { code: setStatus } as unknown as FastifyReply;
  return { request, reply, database, where, values, executeTakeFirstOrThrow, setStatus };
}

function checker(result?: Awaited<ReturnType<UpdateChecker['check']>>): UpdateChecker {
  return {
    check: vi.fn(() =>
      result === undefined
        ? Promise.reject(new UpdateCheckNotCachedError(COUNTRY_ID))
        : Promise.resolve(result),
    ),
  };
}

describe('cache update-check routes', () => {
  it('returns source and cached identities for a successful inline check', async () => {
    const timestamp = new Date('2026-10-31T00:00:00.000Z');
    const check = checker({
      state: 'update_available',
      availableVersion: '261031',
      availableSizeBytes: 2000,
      availableAt: timestamp,
      reason: null,
      cached: { version: '261030', dataTimestamp: timestamp, sizeBytes: '1000' },
      source: { version: '261031', dataTimestamp: timestamp, sizeBytes: 2000 },
      checkedAt: timestamp,
    });
    const { request } = makeRequest({ body: {} });
    await expect(postCacheUpdateCheck(request, check)).resolves.toEqual({
      state: 'update_available',
      cached: { version: '261030', dataTimestamp: timestamp.toISOString(), sizeBytes: 1000 },
      source: { version: '261031', dataTimestamp: timestamp.toISOString(), sizeBytes: 2000 },
      checkedAt: timestamp.toISOString(),
      reason: null,
    });
  });

  it('returns unknown on source failure, not an up-to-date state', async () => {
    const check = checker({
      state: 'unknown',
      availableVersion: null,
      availableSizeBytes: null,
      availableAt: null,
      reason: 'The map source could not be checked.',
      cached: { version: '261030', dataTimestamp: null, sizeBytes: 1000 },
      source: null,
      checkedAt: new Date('2026-10-31T00:00:00.000Z'),
    });
    const request = makeRequest({ body: {} }).request;
    await expect(postCacheUpdateCheck(request, check)).resolves.toMatchObject({
      state: 'unknown',
      source: null,
      reason: 'The map source could not be checked.',
    });
  });

  it('returns not-found for uncached countries and preserves invalid-body validation', async () => {
    const { request } = makeRequest({ body: { unknown: true } });
    await expect(postCacheUpdateCheck(request, checker())).rejects.toBeInstanceOf(ZodError);
    const validRequest = makeRequest({ body: {} }).request;
    await expect(postCacheUpdateCheck(validRequest, checker())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('queues omitted-country requests for all cached countries and returns 202', async () => {
    const { request, reply, database, values, executeTakeFirstOrThrow, setStatus } = makeRequest({
      body: {},
    });
    await expect(postCacheUpdateChecks(request, reply)).resolves.toEqual({ jobId: JOB_ID });
    expect(setStatus).toHaveBeenCalledWith(202);
    expect(database.selectFrom).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith({
      type: 'update_check',
      payload: {},
      created_by: 'admin-id',
    });
    expect(executeTakeFirstOrThrow).toHaveBeenCalledOnce();
  });

  it('validates selected countries before queueing and rejects uncached ids', async () => {
    const { request, reply, where, values } = makeRequest({
      body: { countryIds: [COUNTRY_ID] },
      cachedIds: [COUNTRY_ID],
    });
    await postCacheUpdateChecks(request, reply);
    expect(where).toHaveBeenCalledWith('country_id', 'in', [COUNTRY_ID]);
    expect(values).toHaveBeenCalledWith({
      type: 'update_check',
      payload: { countryIds: [COUNTRY_ID] },
      created_by: 'admin-id',
    });

    const missing = makeRequest({ body: { countryIds: [COUNTRY_ID] } });
    await expect(postCacheUpdateChecks(missing.request, missing.reply)).rejects.toBeInstanceOf(
      AppError,
    );
    expect(missing.values).not.toHaveBeenCalled();
  });
});
