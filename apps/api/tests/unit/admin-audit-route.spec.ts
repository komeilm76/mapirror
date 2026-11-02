import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

vi.mock('kysely', () => ({ sql: () => ({ as: vi.fn() }) }));

import { listAuditLog } from '../../src/modules/admin/audit-route';

function makeRequest(options: { query?: unknown; total?: string; rows?: unknown[] } = {}) {
  const rows = options.rows ?? [
    {
      id: '101',
      actor_name: 'operator',
      action: 'cache.public.enable',
      target_type: 'country',
      target_id: 'finland',
      metadata: {
        visible: true,
        token: 'root-secret',
        nested: { count: 2, apiKey: 'hidden', ok: 'safe' },
        list: [{ cookie: 'hidden', keep: null }, 'value'],
      },
      created_at: new Date('2026-11-01T12:00:00Z'),
    },
  ];
  const queries: Array<{
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    offset: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    executeTakeFirstOrThrow: ReturnType<typeof vi.fn>;
  }> = [];
  const trx = {
    selectFrom: vi.fn(() => {
      const query = {
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn(() => query),
        offset: vi.fn(() => query),
        execute: vi.fn(() => Promise.resolve(rows)),
        executeTakeFirstOrThrow: vi.fn(() => Promise.resolve({ total: options.total ?? '1' })),
      };
      queries.push(query);
      return {
        select: vi.fn(() => query),
      };
    }),
  };
  const transaction = {
    setIsolationLevel: vi.fn(),
    execute: vi.fn((callback: (trx: unknown) => Promise<unknown>) => callback(trx)),
  };
  transaction.setIsolationLevel.mockImplementation(() => transaction);
  const request = {
    query: options.query ?? {},
    server: { db: { db: { transaction: vi.fn(() => transaction) } } },
  } as unknown as FastifyRequest;
  return { request, transaction, trx, queries };
}

describe('listAuditLog', () => {
  it('filters, pages and recursively removes sensitive metadata', async () => {
    const setup = makeRequest({ query: { page: '2', limit: '10', action: 'cache.public.enable' } });
    const response = await listAuditLog(setup.request);
    expect(setup.transaction.setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(setup.queries[0]?.where).toHaveBeenCalledWith('action', '=', 'cache.public.enable');
    expect(setup.queries[0]?.orderBy).toHaveBeenCalledTimes(2);
    expect(setup.queries[0]?.limit).toHaveBeenCalledWith(10);
    expect(setup.queries[0]?.offset).toHaveBeenCalledWith(10);
    expect(response.data[0]?.metadata).toEqual({
      visible: true,
      nested: { count: 2, ok: 'safe' },
      list: [{ keep: null }, 'value'],
    });
    expect(response.meta).toMatchObject({ page: 2, limit: 10, total: 1 });
  });

  it('omits the action filter when absent and returns an empty page', async () => {
    const setup = makeRequest({ rows: [], total: '0' });
    const response = await listAuditLog(setup.request);
    expect(setup.queries[0]?.where).not.toHaveBeenCalled();
    expect(response.data).toEqual([]);
    expect(response.meta.total).toBe(0);
  });

  it('rejects invalid filters and invalid or unsafe database counts', async () => {
    await expect(
      listAuditLog(makeRequest({ query: { unexpected: true } }).request),
    ).rejects.toThrow();
    await expect(listAuditLog(makeRequest({ total: '-1' }).request)).rejects.toThrow(
      'audit row count is not a non-negative decimal integer',
    );
    await expect(listAuditLog(makeRequest({ total: '9007199254740992' }).request)).rejects.toThrow(
      'audit row count exceeds the JSON safe integer range',
    );
  });
});
