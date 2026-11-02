import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  insertAuditLog: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/db/repositories/audit-logs', () => ({
  AUDIT_ACTIONS: {
    intervalCreate: 'interval.created',
    intervalUpdate: 'interval.updated',
    intervalDelete: 'interval.deleted',
  },
  insertAuditLog: mocks.insertAuditLog,
}));
vi.mock('kysely', () => ({ sql: mocks.sql }));

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Interval } from '../../src/db/schema';
import {
  deleteInterval,
  getIntervals,
  patchInterval,
  postInterval,
} from '../../src/modules/admin/intervals-route';

const ID = '00000000-0000-4000-8000-000000000001';
const COUNTRY_ID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-02T12:00:00Z');

function interval(overrides: Partial<Interval> = {}): Interval {
  return {
    id: ID,
    name: 'Daily Finland',
    frequency: 'daily',
    time_of_day: '03:00:00',
    weekday: null,
    day_of_month: null,
    keep_versions: 3,
    only_if_changed: true,
    enabled: true,
    next_run_at: NOW,
    created_by: ADMIN_ID,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as Interval;
}
const ADMIN_ID = '00000000-0000-4000-8000-000000000003';

type Results = Partial<Record<string, Partial<Record<string, unknown[]>>>>;
function setup(results: Results = {}, auth: boolean | null = true) {
  const queues: Record<string, Record<string, unknown[]>> = {};
  for (const [table, methods] of Object.entries(results)) {
    if (methods === undefined) continue;
    const tableQueues: Record<string, unknown[]> = {};
    for (const [method, values] of Object.entries(methods)) {
      if (values !== undefined) tableQueues[method] = values;
    }
    queues[table] = tableQueues;
  }
  const next = (table: string, method: string) => queues[table]?.[method]?.shift();
  function builder(table: string) {
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of [
      'select',
      'selectAll',
      'where',
      'orderBy',
      'distinctOn',
      'limit',
      'offset',
      'forUpdate',
      'forKeyShare',
      'innerJoin',
      'values',
      'returning',
      'set',
    ])
      query[method] = vi.fn(() => query);
    query.execute = vi.fn(() => next(table, 'execute') ?? []);
    query.executeTakeFirst = vi.fn(() => next(table, 'executeTakeFirst'));
    query.executeTakeFirstOrThrow = vi.fn(() => {
      const row = next(table, 'executeTakeFirstOrThrow');
      if (row === undefined) throw new Error(`No ${table} row configured`);
      return row;
    });
    return query;
  }
  const trx = {
    selectFrom: vi.fn((table: string) => builder(table)),
    insertInto: vi.fn((table: string) => builder(table)),
    updateTable: vi.fn((table: string) => builder(table)),
    deleteFrom: vi.fn((table: string) => builder(table)),
  };
  const transaction = {
    setIsolationLevel: vi.fn(() => transaction),
    execute: vi.fn((callback: (executor: unknown) => unknown) => callback(trx)),
  };
  const database = { ...trx, transaction: vi.fn(() => transaction) };
  mocks.withTransaction.mockImplementation(
    (_database: unknown, callback: (executor: unknown) => unknown) => callback(trx),
  );
  mocks.sql.mockImplementation(() => ({
    as: vi.fn(() => ({ as: vi.fn() })),
    execute: vi.fn(() => ({ rows: [{ database_now: NOW }] })),
  }));
  const request = {
    authenticatedAdmin: auth === null ? null : { id: ADMIN_ID, username: 'operator' },
    body: undefined,
    params: { id: ID },
    query: {},
    ip: '127.0.0.1',
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{
    Params: { id: string };
    Querystring: { force?: 'true' | 'false' };
  }>;
  const replyCode = vi.fn();
  const reply = { code: replyCode } as unknown as FastifyReply;
  return { request, reply, replyCode, database, trx, transaction };
}

function lastAuditMetadata(): unknown {
  const calls: unknown = mocks.insertAuditLog.mock.calls;
  if (!Array.isArray(calls)) return undefined;
  const lastCall: unknown = calls.at(-1);
  if (!Array.isArray(lastCall)) return undefined;
  const payload: unknown = lastCall[1];
  if (typeof payload !== 'object' || payload === null) return undefined;
  return Reflect.get(payload, 'metadata');
}

function configured(...entries: [string, string, unknown[]][]): Results {
  const result: Results = {};
  for (const [table, method, values] of entries) {
    result[table] ??= {};
    result[table][method] = values;
  }
  return result;
}

const createBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Daily Finland',
  frequency: 'daily',
  countryIds: [COUNTRY_ID],
  ...overrides,
});
const memberships = [
  { interval_id: ID, country_id: COUNTRY_ID, country_name: 'Finland', country_slug: 'finland' },
];
const viewRows = (row = interval()) =>
  configured(
    ['countries', 'execute', [[{ id: COUNTRY_ID }]]],
    ['intervals', 'executeTakeFirstOrThrow', [{ id: ID }, row]],
    ['interval_countries', 'execute', [[], memberships]],
    ['interval_runs', 'execute', [[]]],
  );

describe('admin intervals handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertAuditLog.mockResolvedValue(undefined);
  });

  it('returns an empty list without membership or recent-run queries', async () => {
    const state = setup(configured(['intervals', 'execute', [[]]]));
    await expect(getIntervals(state.request)).resolves.toEqual({ data: [] });
  });

  it('projects interval memberships and most recent run values from a repeatable-read snapshot', async () => {
    const row = interval();
    const state = setup(
      configured(
        ['intervals', 'execute', [[row]]],
        ['interval_countries', 'execute', [memberships]],
        [
          'interval_runs',
          'execute',
          [
            [
              {
                id: COUNTRY_ID,
                interval_id: ID,
                status: 'succeeded',
                started_at: NOW,
                finished_at: null,
              },
            ],
          ],
        ],
      ),
    );
    const result = await getIntervals(state.request);
    expect(result.data[0]).toMatchObject({
      id: ID,
      countries: [{ countryId: COUNTRY_ID, slug: 'finland' }],
      lastRun: { id: COUNTRY_ID, finishedAt: null },
    });
    expect(state.transaction.setIsolationLevel).toHaveBeenCalledWith('repeatable read');
  });

  it('validates create bodies, requires countries and an authenticated admin, and rejects inconsistent schedules', async () => {
    const invalid = setup();
    invalid.request.body = { unexpected: true };
    await expect(postInterval(invalid.request, invalid.reply)).rejects.toBeInstanceOf(Error);

    const noCountries = setup();
    noCountries.request.body = createBody({ countryIds: [] });
    await expect(postInterval(noCountries.request, noCountries.reply)).rejects.toMatchObject({
      code: 'SEMANTIC_ERROR',
    });

    const notSignedIn = setup({}, null);
    notSignedIn.request.body = createBody();
    await expect(postInterval(notSignedIn.request, notSignedIn.reply)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const badDaily = setup();
    badDaily.request.body = createBody({ weekday: 1 });
    await expect(postInterval(badDaily.request, badDaily.reply)).rejects.toMatchObject({
      code: 'SEMANTIC_ERROR',
    });
    const badWeekly = setup();
    badWeekly.request.body = createBody({ frequency: 'weekly', dayOfMonth: 1 });
    await expect(postInterval(badWeekly.request, badWeekly.reply)).rejects.toMatchObject({
      code: 'SEMANTIC_ERROR',
    });
    const badMonthly = setup();
    badMonthly.request.body = createBody({ frequency: 'monthly', weekday: 1 });
    await expect(postInterval(badMonthly.request, badMonthly.reply)).rejects.toMatchObject({
      code: 'SEMANTIC_ERROR',
    });
  });

  it.each([
    ['daily', {}],
    ['weekly', { frequency: 'weekly', weekday: 5 }],
    ['monthly', { frequency: 'monthly', dayOfMonth: 18 }],
  ])(
    'creates a valid %s interval with defaults, memberships, and audit',
    async (_name, schedule) => {
      const state = setup(viewRows());
      state.request.body = createBody(schedule);
      await expect(postInterval(state.request, state.reply)).resolves.toMatchObject({
        interval: { id: ID, countries: [{ countryId: COUNTRY_ID }] },
      });
      expect(state.replyCode).toHaveBeenCalledWith(201);
      expect(mocks.insertAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'interval.created', targetId: ID }),
      );
    },
  );

  it('rejects create when a selected country is missing from the catalog', async () => {
    const state = setup(configured(['countries', 'execute', []]));
    state.request.body = createBody();
    await expect(postInterval(state.request, state.reply)).rejects.toMatchObject({
      code: 'SEMANTIC_ERROR',
      details: { countryIds: [COUNTRY_ID] },
    });
  });

  it('validates patch params, body semantics, authentication and missing intervals', async () => {
    const invalidParams = setup();
    invalidParams.request.params = { id: 'bad-id' };
    invalidParams.request.body = { name: 'A' };
    await expect(patchInterval(invalidParams.request)).rejects.toBeInstanceOf(Error);

    const emptyPatch = setup();
    emptyPatch.request.body = { confirm: true };
    await expect(patchInterval(emptyPatch.request)).rejects.toBeInstanceOf(Error);

    const badConfirm = setup();
    badConfirm.request.body = { name: 'Updated', confirm: true };
    await expect(patchInterval(badConfirm.request)).rejects.toMatchObject({
      code: 'SEMANTIC_ERROR',
    });

    const noCountries = setup();
    noCountries.request.body = { countryIds: [] };
    await expect(patchInterval(noCountries.request)).rejects.toMatchObject({
      code: 'SEMANTIC_ERROR',
    });

    const notSignedIn = setup({}, null);
    notSignedIn.request.body = { name: 'Updated' };
    await expect(patchInterval(notSignedIn.request)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const missing = setup(configured(['intervals', 'executeTakeFirst', [undefined]]));
    missing.request.body = { name: 'Updated' };
    await expect(patchInterval(missing.request)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updates an interval schedule, retains optional fields, and replaces country memberships when requested', async () => {
    const current = interval();
    const state = setup(
      configured(
        ['intervals', 'executeTakeFirst', [current]],
        ['intervals', 'executeTakeFirstOrThrow', [interval({ name: 'Updated' })]],
        ['interval_countries', 'execute', [[{ country_id: COUNTRY_ID }], memberships]],
        ['interval_runs', 'executeTakeFirst', [undefined]],
        ['countries', 'execute', [[{ id: COUNTRY_ID }]]],
      ),
    );
    state.request.body = { name: 'Updated', frequency: 'weekly', countryIds: [COUNTRY_ID] };
    await expect(patchInterval(state.request)).resolves.toMatchObject({
      interval: { name: 'Updated', frequency: 'daily' },
    });
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'interval.updated' }),
    );
  });

  it('requires confirmation to pause a running interval, then records the run id when confirmed', async () => {
    const active = { id: COUNTRY_ID };
    const needsConfirmation = setup(
      configured(
        ['intervals', 'executeTakeFirst', [interval()]],
        ['interval_countries', 'execute', [[{ country_id: COUNTRY_ID }]]],
        ['interval_runs', 'executeTakeFirst', [active]],
      ),
    );
    needsConfirmation.request.body = { enabled: false };
    await expect(patchInterval(needsConfirmation.request)).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });

    const confirmed = setup(
      configured(
        ['intervals', 'executeTakeFirst', [interval()]],
        ['intervals', 'executeTakeFirstOrThrow', [interval({ enabled: false })]],
        ['interval_countries', 'execute', [[{ country_id: COUNTRY_ID }], memberships]],
        ['interval_runs', 'executeTakeFirst', [active]],
        ['interval_runs', 'execute', [[]]],
      ),
    );
    confirmed.request.body = { enabled: false, confirm: true };
    await expect(patchInterval(confirmed.request)).resolves.toMatchObject({
      interval: { enabled: false },
    });
    expect(lastAuditMetadata()).toMatchObject({ activeRunId: COUNTRY_ID });
  });

  it('rejects invalid schedule changes and missing country records during update', async () => {
    const invalid = setup(
      configured(
        ['intervals', 'executeTakeFirst', [interval()]],
        ['interval_countries', 'execute', [[{ country_id: COUNTRY_ID }]]],
      ),
    );
    invalid.request.body = { frequency: 'daily', weekday: 2 };
    await expect(patchInterval(invalid.request)).rejects.toMatchObject({ code: 'SEMANTIC_ERROR' });

    const countryMissing = setup(
      configured(
        ['intervals', 'executeTakeFirst', [interval()]],
        ['interval_countries', 'execute', [[{ country_id: COUNTRY_ID }]]],
        ['interval_runs', 'executeTakeFirst', [undefined]],
        ['countries', 'execute', []],
      ),
    );
    countryMissing.request.body = { countryIds: [COUNTRY_ID] };
    await expect(patchInterval(countryMissing.request)).rejects.toMatchObject({
      code: 'SEMANTIC_ERROR',
    });
  });

  it('validates deletion, refuses active runs unless forced, and audits forced deletion', async () => {
    const badQuery = setup();
    (badQuery.request as unknown as { query: unknown }).query = { force: 'yes' };
    await expect(deleteInterval(badQuery.request, badQuery.reply)).rejects.toBeInstanceOf(Error);

    const missing = setup(configured(['intervals', 'executeTakeFirst', [undefined]]));
    await expect(deleteInterval(missing.request, missing.reply)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const active = { id: COUNTRY_ID };
    const blocked = setup(
      configured(
        [
          'intervals',
          'executeTakeFirst',
          [{ id: ID, name: 'Daily Finland', frequency: 'daily', enabled: true }],
        ],
        ['interval_runs', 'executeTakeFirst', [active]],
      ),
    );
    await expect(deleteInterval(blocked.request, blocked.reply)).rejects.toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
    });

    const forced = setup(
      configured(
        [
          'intervals',
          'executeTakeFirst',
          [{ id: ID, name: 'Daily Finland', frequency: 'daily', enabled: true }],
        ],
        ['interval_runs', 'executeTakeFirst', [active]],
      ),
    );
    forced.request.query = { force: 'true' };
    await expect(deleteInterval(forced.request, forced.reply)).resolves.toBeUndefined();
    expect(forced.replyCode).toHaveBeenCalledWith(204);
    expect(lastAuditMetadata()).toMatchObject({ force: true, activeRunId: COUNTRY_ID });
  });
});
