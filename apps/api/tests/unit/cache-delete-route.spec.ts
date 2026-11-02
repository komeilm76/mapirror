import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/env';
import type { FastifyReply, FastifyRequest } from 'fastify';

const mocks = vi.hoisted(() => ({
  findCountryCache: vi.fn(),
  listActiveCountryJobs: vi.fn(),
  insertAuditLog: vi.fn<
    (
      trx: unknown,
      entry: {
        action: string;
        targetId: string;
        metadata: Record<string, unknown>;
      },
    ) => Promise<void>
  >(),
  requestJobCancellation: vi.fn(),
  withTransaction: vi.fn(),
  withCacheCountryMutationLock: vi.fn(),
  createCacheStorage: vi.fn(),
}));
vi.mock('../../src/db/repositories/cache', () => ({
  findCountryCache: mocks.findCountryCache,
  listActiveCountryJobs: mocks.listActiveCountryJobs,
}));
vi.mock('../../src/db/repositories/audit-logs', () => ({
  AUDIT_ACTIONS: { cacheDeleteCountry: 'cache.delete_country' },
  insertAuditLog: mocks.insertAuditLog,
}));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/modules/jobs/cancellation', () => ({
  requestJobCancellation: mocks.requestJobCancellation,
}));
vi.mock('../../src/modules/admin/cache-mutation-lock', () => ({
  withCacheCountryMutationLock: mocks.withCacheCountryMutationLock,
}));
vi.mock('../../src/modules/storage/storage', () => ({
  createCacheStorage: mocks.createCacheStorage,
}));

import { createCacheDeleteHandler } from '../../src/modules/admin/cache-delete-route';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const JOB_ID = '00000000-0000-4000-8000-000000000002';
const PATH_ONE = 'finland/261101/one.osm.pbf';
const PATH_TWO = 'finland/261101/two.osm.pbf';

function makeSetup(
  options: {
    readonly params?: unknown;
    readonly query?: unknown;
    readonly body?: unknown;
    readonly admin?: { id: string; username: string } | null;
    readonly country?: { id: string; slug: string } | null;
    readonly cache?: { is_public: boolean; total_size_bytes: string } | null;
    readonly paths?: string[];
    readonly activeJobs?: Array<{ id: string }>;
    readonly activeJobStates?: Array<Array<{ id: string }>>;
    readonly removeResults?: Record<string, boolean | Error>;
  } = {},
) {
  const country =
    options.country === undefined ? { id: COUNTRY_ID, slug: 'finland' } : options.country;
  const cache =
    options.cache === undefined ? { is_public: true, total_size_bytes: '1250' } : options.cache;
  const paths = options.paths ?? [PATH_ONE, PATH_TWO];
  let activeStateIndex = 0;
  const versionFileAt = vi.fn((storagePath: string) => ({
    remove: vi.fn(() => {
      const result = options.removeResults?.[storagePath] ?? true;
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    }),
  }));
  const storage = { versionFileAt };
  const deleteQueries: Array<{
    where: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  }> = [];
  const trx = {
    selectFrom: vi.fn((table: string) => {
      const query = {
        select: vi.fn(() => query),
        where: vi.fn(() => query),
        forUpdate: vi.fn(() => query),
        executeTakeFirst: vi.fn(() =>
          Promise.resolve(table === 'countries' ? (country ?? undefined) : undefined),
        ),
        execute: vi.fn(() =>
          Promise.resolve(
            table === 'map_versions' ? paths.map((storage_path) => ({ storage_path })) : [],
          ),
        ),
      };
      return query;
    }),
    deleteFrom: vi.fn(() => {
      const query = {
        where: vi.fn(() => query),
        execute: vi.fn(() => Promise.resolve()),
      };
      deleteQueries.push(query);
      return query;
    }),
  };
  const connection = {};
  const database = {
    connection: vi.fn(() => ({
      execute: (work: (connection: object) => Promise<unknown>) => work(connection),
    })),
  };
  mocks.withTransaction.mockImplementation(
    async (_connection: unknown, work: (trx: unknown) => Promise<unknown>) => work(trx),
  );
  mocks.withCacheCountryMutationLock.mockImplementation(
    async (_connection: unknown, _countryId: string, _log: unknown, work: () => Promise<unknown>) =>
      work(),
  );
  mocks.findCountryCache.mockImplementation(() => Promise.resolve(cache));
  mocks.listActiveCountryJobs.mockImplementation(() => {
    const state = options.activeJobStates?.[activeStateIndex++] ?? options.activeJobs ?? [];
    return Promise.resolve(state);
  });
  mocks.requestJobCancellation.mockResolvedValue(undefined);
  mocks.createCacheStorage.mockReturnValue(storage);
  const config = { cacheDir: '/unused' } as AppConfig;
  const handler = createCacheDeleteHandler({ config });
  const request = {
    params: options.params ?? { countryId: COUNTRY_ID },
    query: options.query ?? { confirm: 'finland' },
    body: options.body,
    authenticatedAdmin:
      options.admin === undefined ? { id: 'admin-id', username: 'operator' } : options.admin,
    ip: '::ffff:192.0.2.25',
    log: { warn: vi.fn(), error: vi.fn() },
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { countryId: string } }>;
  const replyHolder: { current?: FastifyReply } = {};
  const code = vi.fn((_status: number) => replyHolder.current);
  const send = vi.fn(() => replyHolder.current);
  const reply = { code, send } as unknown as FastifyReply;
  replyHolder.current = reply;
  return {
    handler,
    request,
    reply,
    code,
    send,
    database,
    connection,
    trx,
    deleteQueries,
    storage,
    config,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertAuditLog.mockResolvedValue(undefined);
  mocks.requestJobCancellation.mockResolvedValue(undefined);
  mocks.listActiveCountryJobs.mockResolvedValue([]);
});

describe('cached-country deletion handler', () => {
  it('validates parameters, confirmation, strict body/query schemas and authentication', async () => {
    const invalidParams = makeSetup({ params: { countryId: 'bad' } });
    await expect(
      invalidParams.handler(invalidParams.request, invalidParams.reply),
    ).rejects.toThrow();
    expect(invalidParams.database.connection).not.toHaveBeenCalled();

    const invalidQuery = makeSetup({ query: { confirm: 'finland', extra: true } });
    await expect(invalidQuery.handler(invalidQuery.request, invalidQuery.reply)).rejects.toThrow();

    const invalidBody = makeSetup({ body: { confirm: 1 } });
    await expect(invalidBody.handler(invalidBody.request, invalidBody.reply)).rejects.toThrow();

    const mismatchedConfirmation = makeSetup({
      query: { confirm: 'finland' },
      body: { confirm: 'sweden' },
    });
    await expect(
      mismatchedConfirmation.handler(mismatchedConfirmation.request, mismatchedConfirmation.reply),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });

    const wrongSlug = makeSetup({ query: { confirm: 'not-finland' } });
    await expect(wrongSlug.handler(wrongSlug.request, wrongSlug.reply)).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });

    const unauthenticated = makeSetup({ admin: null });
    await expect(
      unauthenticated.handler(unauthenticated.request, unauthenticated.reply),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('does not delete for missing countries/cache rows or uncancelled active jobs', async () => {
    const noCountry = makeSetup({ country: null });
    await expect(noCountry.handler(noCountry.request, noCountry.reply)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const noCache = makeSetup({ cache: null });
    await expect(noCache.handler(noCache.request, noCache.reply)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const active = makeSetup({ activeJobs: [{ id: JOB_ID }] });
    await expect(active.handler(active.request, active.reply)).rejects.toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
      details: { jobIds: [JOB_ID] },
    });
    expect(active.deleteQueries).toHaveLength(0);
    expect(mocks.requestJobCancellation).not.toHaveBeenCalled();
  });

  it('deletes rows transactionally, unlinks files after commit, audits and returns 204', async () => {
    const cleanupError = new Error('disk unavailable');
    const setup = makeSetup({
      removeResults: { [PATH_ONE]: true, [PATH_TWO]: cleanupError },
    });
    await setup.handler(setup.request, setup.reply);

    expect(setup.deleteQueries).toHaveLength(3);
    expect(setup.trx.deleteFrom.mock.calls).toEqual([
      ['map_versions'],
      ['interval_countries'],
      ['country_cache'],
    ]);
    expect(mocks.insertAuditLog.mock.calls[0]?.[1]).toMatchObject({
      action: 'cache.delete_country',
      targetId: COUNTRY_ID,
      metadata: {
        slug: 'finland',
        versionCount: 2,
        totalSizeBytes: '1250',
        wasPublic: true,
      },
    });
    expect(setup.storage.versionFileAt.mock.calls).toEqual([[PATH_ONE], [PATH_TWO]]);
    expect(setup.request.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: cleanupError, countryId: COUNTRY_ID, storagePath: PATH_TWO }),
      'cache country was deleted from the database but a file could not be removed; orphan sweep required',
    );
    expect(setup.code).toHaveBeenCalledWith(204);
    expect(setup.send).toHaveBeenCalledOnce();
  });

  it('warns if a symlink-safe cleanup returns false without changing the successful response', async () => {
    const setup = makeSetup({ removeResults: { [PATH_ONE]: false } });
    await setup.handler(setup.request, setup.reply);
    expect(setup.request.log.warn).toHaveBeenCalledWith(
      { countryId: COUNTRY_ID, storagePath: PATH_ONE },
      'cache file row was deleted but an ancestor symlink blocked leaf cleanup; orphan sweep required',
    );
    expect(setup.code).toHaveBeenCalledWith(204);
  });

  it('cancels active work cooperatively, waits for cleanup, then retries the transaction', async () => {
    const setup = makeSetup({
      query: { confirm: 'finland', cancelJobs: 'true' },
      activeJobStates: [[{ id: JOB_ID }], [], []],
      paths: [],
    });
    await setup.handler(setup.request, setup.reply);
    expect(mocks.requestJobCancellation).toHaveBeenCalledWith(setup.connection, JOB_ID);
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2);
    expect(setup.deleteQueries).toHaveLength(3);
    expect(setup.code).toHaveBeenCalledWith(204);
  });

  it('leaves rows intact when a cancelled job misses the cleanup deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(4000);
    const setup = makeSetup({
      query: { confirm: 'finland', cancelJobs: 'true' },
      activeJobs: [{ id: JOB_ID }],
      paths: [],
    });
    try {
      await expect(setup.handler(setup.request, setup.reply)).rejects.toMatchObject({
        code: 'JOB_ALREADY_RUNNING',
        message: 'Active work has not finished cleanup yet. Try deleting again shortly.',
      });
      expect(mocks.requestJobCancellation).toHaveBeenCalledWith(setup.connection, JOB_ID);
      expect(setup.deleteQueries).toHaveLength(0);
    } finally {
      now.mockRestore();
    }
  });
});
