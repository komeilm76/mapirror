import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

const mocks = vi.hoisted(() => ({ withTransaction: vi.fn(), insertAuditLog: vi.fn() }));
vi.mock('kysely', () => ({ sql: () => ({}) }));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/db/repositories/audit-logs', () => ({
  AUDIT_ACTIONS: { settingsUpdate: 'settings.update' },
  insertAuditLog: mocks.insertAuditLog,
}));

import { parseEnv } from '../../src/config/env';
import { getAdminSettings, patchAdminSettings } from '../../src/modules/admin/settings-route';

const config = parseEnv({});

function makeGetRequest(
  options: { query?: unknown; rows?: Array<{ key: string; value: unknown }> } = {},
) {
  const query = options.rows ?? [];
  const builder = {
    select: vi.fn(() => builder),
    where: vi.fn(() => builder),
    execute: vi.fn(() => Promise.resolve(query)),
  };
  const database = { selectFrom: vi.fn(() => builder) };
  const request = {
    query: options.query ?? {},
    log: { warn: vi.fn() },
    server: { db: { db: database } },
  } as unknown as FastifyRequest;
  return { request, database, builder };
}

function makePatchRequest(
  options: {
    body?: unknown;
    admin?: { id: string; username: string } | null;
    rows?: Array<{ key: string; value: unknown }>;
  } = {},
) {
  const insertQuery = {
    values: vi.fn(() => insertQuery),
    onConflict: vi.fn((callback: (conflict: unknown) => unknown) => {
      const conflict = {
        column: vi.fn(() => conflict),
        doUpdateSet: vi.fn(() => conflict),
      };
      callback(conflict);
      return insertQuery;
    }),
    execute: vi.fn(() => Promise.resolve()),
  };
  const selectQuery = {
    select: vi.fn(() => selectQuery),
    where: vi.fn(() => selectQuery),
    execute: vi.fn(() => Promise.resolve(options.rows ?? [])),
  };
  const trx = {
    insertInto: vi.fn(() => insertQuery),
    selectFrom: vi.fn(() => selectQuery),
  };
  const database = {};
  mocks.withTransaction.mockImplementation(
    async (_database: unknown, work: (trx: unknown) => Promise<unknown>) => work(trx),
  );
  const request = {
    body: options.body,
    authenticatedAdmin:
      options.admin === undefined ? { id: 'admin-id', username: 'operator' } : options.admin,
    ip: '::ffff:192.0.2.25',
    log: { warn: vi.fn() },
    server: { db: { db: database } },
  } as unknown as FastifyRequest;
  return { request, database, trx, insertQuery, selectQuery };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertAuditLog.mockResolvedValue(undefined);
});

describe('admin settings route handlers', () => {
  it('reads only the editable key allow-list and returns the strict settings projection', async () => {
    const setup = makeGetRequest({
      rows: [
        { key: 'branding.displayName', value: 'Mirror North' },
        { key: 'cache.keepVersions', value: 5 },
        { key: 'database.password', value: 'must-not-leak' },
      ],
    });
    await expect(getAdminSettings(setup.request, config)).resolves.toEqual({
      settings: {
        branding: { displayName: 'Mirror North' },
        cache: { keepVersions: 5, diskReserveBytes: config.diskReserveBytes },
        public: { downloadsPerMinute: config.publicDownloadsPerMinute },
        source: { catalogTtlMinutes: config.catalogTtlMinutes },
      },
    });
    expect(setup.database.selectFrom).toHaveBeenCalledWith('settings');
    expect(setup.builder.where).toHaveBeenCalledWith('key', 'in', [
      'branding.displayName',
      'cache.keepVersions',
      'cache.diskReserveBytes',
      'public.downloadsPerMinute',
      'source.catalogTtlMinutes',
    ]);
  });

  it('warns and falls back for invalid persisted GET values and rejects unknown query fields', async () => {
    const setup = makeGetRequest({ rows: [{ key: 'cache.keepVersions', value: 100 }] });
    const response = await getAdminSettings(setup.request, config);
    expect(response.settings.cache.keepVersions).toBe(3);
    expect(setup.request.log.warn).toHaveBeenCalledWith(
      { key: 'cache.keepVersions' },
      'Ignoring invalid persisted admin setting.',
    );

    await expect(
      getAdminSettings(makeGetRequest({ query: { leak: true } }).request, config),
    ).rejects.toThrow();
  });

  it('upserts only supplied editable values and audits their keys in the same transaction', async () => {
    const setup = makePatchRequest({
      body: {
        branding: { displayName: '  North mirror  ' },
        cache: { keepVersions: 4, diskReserveBytes: 4_000_000_000 },
        public: { downloadsPerMinute: 25 },
      },
      rows: [
        { key: 'branding.displayName', value: 'North mirror' },
        { key: 'cache.keepVersions', value: 4 },
        { key: 'cache.diskReserveBytes', value: 4_000_000_000 },
        { key: 'public.downloadsPerMinute', value: 25 },
      ],
    });
    const response = await patchAdminSettings(setup.request, config);
    expect(setup.trx.insertInto).toHaveBeenCalledTimes(4);
    expect(setup.insertQuery.values).toHaveBeenNthCalledWith(1, {
      key: 'branding.displayName',
      value: JSON.stringify('North mirror'),
    });
    expect(mocks.insertAuditLog.mock.calls[0]?.[1]).toMatchObject({
      action: 'settings.update',
      metadata: {
        keys: [
          'branding.displayName',
          'cache.keepVersions',
          'cache.diskReserveBytes',
          'public.downloadsPerMinute',
        ],
      },
    });
    expect(response.settings.branding.displayName).toBe('North mirror');
  });

  it('rejects empty, unknown and invalid updates before transaction and requires authentication', async () => {
    const empty = makePatchRequest({ body: {} });
    await expect(patchAdminSettings(empty.request, config)).rejects.toThrow();
    expect(mocks.withTransaction).not.toHaveBeenCalled();

    const extra = makePatchRequest({ body: { secret: 'x' } });
    await expect(patchAdminSettings(extra.request, config)).rejects.toThrow();

    const invalidValue = makePatchRequest({ body: { cache: { keepVersions: 0 } } });
    await expect(patchAdminSettings(invalidValue.request, config)).rejects.toThrow();

    const unauthenticated = makePatchRequest({ body: { cache: { keepVersions: 4 } }, admin: null });
    await expect(patchAdminSettings(unauthenticated.request, config)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});
