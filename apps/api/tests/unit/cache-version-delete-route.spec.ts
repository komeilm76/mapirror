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
  withTransaction: vi.fn(),
  withCacheCountryMutationLock: vi.fn(),
  createCacheStorage: vi.fn(),
}));
vi.mock('../../src/db/repositories/cache', () => ({
  findCountryCache: mocks.findCountryCache,
  listActiveCountryJobs: mocks.listActiveCountryJobs,
}));
vi.mock('../../src/db/repositories/audit-logs', () => ({
  AUDIT_ACTIONS: { versionDelete: 'version.delete' },
  insertAuditLog: mocks.insertAuditLog,
}));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/modules/admin/cache-mutation-lock', () => ({
  withCacheCountryMutationLock: mocks.withCacheCountryMutationLock,
}));
vi.mock('../../src/modules/storage/storage', () => ({
  createCacheStorage: mocks.createCacheStorage,
}));

import { createCacheVersionDeleteHandler } from '../../src/modules/admin/cache-version-delete-route';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const VERSION_ID = '00000000-0000-4000-8000-000000000002';

function makeSetup(
  options: {
    readonly params?: unknown;
    readonly query?: unknown;
    readonly body?: unknown;
    readonly admin?: { id: string; username: string } | null;
    readonly country?: { id: string; slug: string } | null;
    readonly cache?: { is_public: boolean; public_since: Date | null } | null;
    readonly version?: Record<string, unknown> | null;
    readonly remaining?: { version_count: string; ready_count: string; total_size_bytes: string };
    readonly activeJobs?: Array<{ id: string }>;
    readonly removeResult?: boolean;
    readonly removeError?: Error;
  } = {},
) {
  const country =
    options.country === undefined ? { id: COUNTRY_ID, slug: 'finland' } : options.country;
  const version =
    options.version === undefined
      ? {
          id: VERSION_ID,
          version: '261101',
          origin: 'geofabrik_snapshot',
          file_size_bytes: '100',
          checksum_md5: 'a'.repeat(32),
          checksum_sha256: null,
          storage_path: 'finland/261101/finland.osm.pbf',
          status: 'ready',
        }
      : options.version;
  const remaining = options.remaining ?? {
    version_count: '1',
    ready_count: '1',
    total_size_bytes: '200',
  };
  const versionFile = {
    remove: vi.fn(() =>
      options.removeError
        ? Promise.reject(options.removeError)
        : Promise.resolve(options.removeResult ?? true),
    ),
  };
  const storage = { versionFileAt: vi.fn(() => versionFile) };
  const updateQuery = {
    set: vi.fn((_values: unknown) => updateQuery),
    where: vi.fn(() => updateQuery),
    execute: vi.fn(() => Promise.resolve()),
  };
  const deleteQuery = {
    where: vi.fn(() => deleteQuery),
    execute: vi.fn(() => Promise.resolve()),
  };
  const trx = {
    selectFrom: vi.fn((table: string) => {
      let countQuery = false;
      const query = {
        select: vi.fn((columns: unknown) => {
          countQuery = Array.isArray(columns) && typeof columns[0] !== 'string';
          return query;
        }),
        where: vi.fn(() => query),
        forUpdate: vi.fn(() => query),
        executeTakeFirst: vi.fn(() =>
          Promise.resolve(table === 'countries' ? (country ?? undefined) : (version ?? undefined)),
        ),
        executeTakeFirstOrThrow: vi.fn(() => Promise.resolve(countQuery ? remaining : {})),
      };
      return query;
    }),
    updateTable: vi.fn(() => updateQuery),
    deleteFrom: vi.fn(() => deleteQuery),
  };
  const connection = {};
  const database = {
    connection: vi.fn(() => ({
      execute: (work: (connection: object) => Promise<unknown>) => work(connection),
    })),
  };
  mocks.withTransaction.mockImplementation(
    async (_db: unknown, work: (trx: unknown) => Promise<unknown>) => work(trx),
  );
  mocks.withCacheCountryMutationLock.mockImplementation(
    async (_connection: unknown, _countryId: string, _log: unknown, work: () => Promise<unknown>) =>
      work(),
  );
  mocks.findCountryCache.mockResolvedValue(
    options.cache === undefined ? { is_public: false, public_since: null } : options.cache,
  );
  mocks.listActiveCountryJobs.mockResolvedValue(options.activeJobs ?? []);
  mocks.createCacheStorage.mockReturnValue(storage);
  const config = { cacheDir: '/unused' } as AppConfig;
  const handler = createCacheVersionDeleteHandler({ config });
  const request = {
    params: options.params ?? { countryId: COUNTRY_ID, versionId: VERSION_ID },
    query: options.query ?? { confirm: 'true' },
    body: options.body,
    authenticatedAdmin:
      options.admin === undefined ? { id: 'admin-id', username: 'operator' } : options.admin,
    ip: '192.0.2.25',
    log: { warn: vi.fn(), error: vi.fn() },
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { countryId: string; versionId: string } }>;
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
    database,
    connection,
    trx,
    updateQuery,
    deleteQuery,
    storage,
    versionFile,
    config,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertAuditLog.mockResolvedValue(undefined);
  mocks.listActiveCountryJobs.mockResolvedValue([]);
});

describe('cached-version deletion handler', () => {
  it('requires valid route, exact confirmation and an authenticated administrator', async () => {
    const invalidParams = makeSetup({ params: { countryId: 'bad', versionId: VERSION_ID } });
    await expect(
      invalidParams.handler(invalidParams.request, invalidParams.reply),
    ).rejects.toThrow();
    expect(invalidParams.database.connection).not.toHaveBeenCalled();

    const missingConfirmation = makeSetup({ query: {} });
    await expect(
      missingConfirmation.handler(missingConfirmation.request, missingConfirmation.reply),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    const conflictConfirmation = makeSetup({
      query: { confirm: 'true' },
      body: { confirm: false },
    });
    await expect(
      conflictConfirmation.handler(conflictConfirmation.request, conflictConfirmation.reply),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    const unauthenticated = makeSetup({ admin: null });
    await expect(
      unauthenticated.handler(unauthenticated.request, unauthenticated.reply),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects missing countries, cache state, versions and active work before deleting', async () => {
    const noCountry = makeSetup({ country: null });
    await expect(noCountry.handler(noCountry.request, noCountry.reply)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const noCache = makeSetup({ cache: null });
    await expect(noCache.handler(noCache.request, noCache.reply)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const noVersion = makeSetup({ version: null });
    await expect(noVersion.handler(noVersion.request, noVersion.reply)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const active = makeSetup({ activeJobs: [{ id: 'busy-job' }] });
    await expect(active.handler(active.request, active.reply)).rejects.toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
    });
    expect(active.deleteQuery.execute).not.toHaveBeenCalled();
  });

  it('deletes a version, recomputes the cache summary, audits and removes the file after commit', async () => {
    const setup = makeSetup({
      remaining: { version_count: '1', ready_count: '1', total_size_bytes: '200' },
    });
    await setup.handler(setup.request, setup.reply);
    expect(setup.deleteQuery.execute).toHaveBeenCalledOnce();
    expect(setup.updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({
        is_public: false,
        versions_ready_count: 1,
        total_size_bytes: '200',
        update_state: 'unknown',
      }),
    );
    expect(mocks.insertAuditLog.mock.calls[0]?.[1]).toMatchObject({
      action: 'version.delete',
      targetId: VERSION_ID,
      metadata: { wasLastVersion: false, unpublished: false },
    });
    expect(setup.versionFile.remove).toHaveBeenCalledOnce();
    expect(setup.code.mock.calls[0]?.[0]).toBe(204);
  });

  it('deletes the cache row with the last version and records publication removal', async () => {
    const setup = makeSetup({
      cache: { is_public: true, public_since: new Date('2026-01-01T00:00:00Z') },
      remaining: { version_count: '0', ready_count: '0', total_size_bytes: '0' },
    });
    await setup.handler(setup.request, setup.reply);
    expect(setup.deleteQuery.execute).toHaveBeenCalledTimes(2);
    expect(mocks.insertAuditLog.mock.calls[0]?.[1].metadata).toMatchObject({
      wasLastVersion: true,
      wasPublic: true,
      unpublished: true,
    });
  });

  it('logs a failed post-commit cleanup without rolling back the database deletion', async () => {
    const setup = makeSetup({ removeError: new Error('disk unavailable') });
    await setup.handler(setup.request, setup.reply);
    expect(setup.request.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ countryId: COUNTRY_ID, versionId: VERSION_ID }),
      'map version was deleted from the database but its file could not be removed; orphan sweep required',
    );
    expect(setup.code.mock.calls[0]?.[0]).toBe(204);
  });
});
