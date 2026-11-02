import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

const mocks = vi.hoisted(() => ({ withTransaction: vi.fn(), insertAuditLog: vi.fn() }));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/db/repositories/audit-logs', () => ({
  AUDIT_ACTIONS: { cachePublish: 'cache.publish', cacheUnpublish: 'cache.unpublish' },
  insertAuditLog: mocks.insertAuditLog,
}));

import { postCachePublic } from '../../src/modules/admin/cache-public-route';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const PUBLIC_SINCE = new Date('2026-10-01T00:00:00.000Z');

function makeRequest(
  options: {
    readonly country?: { id: string; slug: string } | null;
    readonly cache?: { is_public: boolean; public_since: Date | null } | null;
    readonly readyVersion?: boolean;
    readonly body?: unknown;
    readonly params?: unknown;
    readonly admin?: { id: string; username: string } | null;
  } = {},
) {
  const country =
    options.country === undefined ? { id: COUNTRY_ID, slug: 'finland' } : options.country;
  const cache =
    options.cache === undefined ? { is_public: false, public_since: null } : options.cache;
  const readyVersion = options.readyVersion ?? true;
  let publicSinceAfterUpdate: Date | null = new Date('2026-11-01T12:00:00Z');
  const updateQuery = {
    set: vi.fn((values: { readonly is_public: boolean }) => {
      publicSinceAfterUpdate = values.is_public ? new Date('2026-11-01T12:00:00Z') : null;
      return updateQuery;
    }),
    where: vi.fn(() => updateQuery),
    returning: vi.fn(() => updateQuery),
    executeTakeFirstOrThrow: vi.fn(() => Promise.resolve({ public_since: publicSinceAfterUpdate })),
  };
  const insertQuery = {
    values: vi.fn(() => insertQuery),
    execute: vi.fn(() => Promise.resolve()),
  };
  const trx = {
    selectFrom: vi.fn((table: string) => {
      const row =
        table === 'countries'
          ? country
          : table === 'country_cache'
            ? cache
            : readyVersion
              ? { id: 'version-id' }
              : undefined;
      const query = {
        select: vi.fn(() => query),
        where: vi.fn(() => query),
        forUpdate: vi.fn(() => query),
        limit: vi.fn(() => query),
        executeTakeFirst: vi.fn(() => Promise.resolve(row ?? undefined)),
      };
      return query;
    }),
    updateTable: vi.fn(() => updateQuery),
    insertInto: vi.fn(() => insertQuery),
  };
  const database = {};
  mocks.withTransaction.mockImplementation(
    async (_database: unknown, work: (trx: unknown) => Promise<unknown>) => work(trx),
  );
  const request = {
    params: options.params ?? { countryId: COUNTRY_ID },
    body: options.body ?? { isPublic: true },
    authenticatedAdmin:
      options.admin === undefined ? { id: 'admin-id', username: 'operator' } : options.admin,
    ip: '::ffff:192.0.2.25',
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { countryId: string } }>;
  return { request, database, trx, updateQuery };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertAuditLog.mockResolvedValue(undefined);
});

describe('postCachePublic', () => {
  it('validates params and body and requires an authenticated administrator', async () => {
    const invalidParams = makeRequest({ params: { countryId: 'bad' } });
    await expect(postCachePublic(invalidParams.request)).rejects.toThrow();
    expect(mocks.withTransaction).not.toHaveBeenCalled();

    const invalidBody = makeRequest({ body: { isPublic: 'yes' } });
    await expect(postCachePublic(invalidBody.request)).rejects.toThrow();

    const unauthenticated = makeRequest({ admin: null });
    await expect(postCachePublic(unauthenticated.request)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('returns not found for missing country or cache rows and refuses publication without a ready version', async () => {
    const noCountry = makeRequest({ country: null });
    await expect(postCachePublic(noCountry.request)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const noCache = makeRequest({ cache: null });
    await expect(postCachePublic(noCache.request)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const noVersion = makeRequest({ readyVersion: false });
    await expect(postCachePublic(noVersion.request)).rejects.toMatchObject({
      code: 'NO_READY_VERSION',
    });
    expect(noVersion.updateQuery.set).not.toHaveBeenCalled();
  });

  it('is idempotent and preserves the original publication timestamp', async () => {
    const setup = makeRequest({
      cache: { is_public: true, public_since: PUBLIC_SINCE },
      body: { isPublic: true },
    });
    await expect(postCachePublic(setup.request)).resolves.toEqual({
      isPublic: true,
      publicSince: PUBLIC_SINCE.toISOString(),
    });
    expect(setup.updateQuery.set).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('publishes and audits an actual visibility change with normalized request metadata', async () => {
    const setup = makeRequest();
    await expect(postCachePublic(setup.request)).resolves.toEqual({
      isPublic: true,
      publicSince: '2026-11-01T12:00:00.000Z',
    });
    const updated = setup.updateQuery.set.mock.calls[0]?.[0];
    expect(updated).toMatchObject({ is_public: true });
    expect(updated).toHaveProperty('public_since');
    expect(updated).toHaveProperty('updated_at');
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: 'admin-id',
        actorName: 'operator',
        action: 'cache.publish',
        targetId: COUNTRY_ID,
        metadata: { slug: 'finland', beforeIsPublic: false, afterIsPublic: true },
      }),
    );
  });

  it('unpublishes without requiring a ready version and clears the public timestamp', async () => {
    const setup = makeRequest({
      cache: { is_public: true, public_since: PUBLIC_SINCE },
      body: { isPublic: false },
      readyVersion: false,
    });
    await expect(postCachePublic(setup.request)).resolves.toEqual({
      isPublic: false,
      publicSince: null,
    });
    expect(setup.updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        is_public: false,
        public_since: null,
      }),
    );
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'cache.unpublish',
        metadata: { slug: 'finland', beforeIsPublic: true, afterIsPublic: false },
      }),
    );
  });
});
