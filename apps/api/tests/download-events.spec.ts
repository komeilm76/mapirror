import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config/env';
import { recordDownloadEvent } from '../src/modules/download-events';

type SelectResult = { value: unknown } | undefined;

function makeDatabase(reads: SelectResult[] = []) {
  const selectQuery = {
    select: vi.fn(() => selectQuery),
    where: vi.fn(() => selectQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve(reads.shift())),
  };
  const settingInsert = {
    values: vi.fn((_row: unknown) => settingInsert),
    onConflict: vi.fn((callback: (conflict: never) => unknown) => {
      const doNothing = vi.fn(() => conflict);
      const conflict = { column: vi.fn(() => ({ doNothing })) };
      callback(conflict as never);
      return settingInsert;
    }),
    execute: vi.fn(() => Promise.resolve()),
  };
  const eventInsert = {
    values: vi.fn(() => eventInsert),
    execute: vi.fn(() => Promise.resolve()),
  };
  const database = {
    selectFrom: vi.fn(() => selectQuery),
    insertInto: vi.fn((table: string) => (table === 'settings' ? settingInsert : eventInsert)),
  };
  return { database, selectQuery, settingInsert, eventInsert };
}

function makeRequest(overrides: Record<string, unknown> = {}): FastifyRequest {
  return {
    ip: '203.0.113.9',
    raw: { socket: { remoteAddress: '127.0.0.1' } },
    headers: { 'user-agent': 'audit-test' },
    log: { warn: vi.fn() },
    ...overrides,
  } as unknown as FastifyRequest;
}

function makeConfig(ipHashSalt?: string): AppConfig {
  return { ipHashSalt } as AppConfig;
}

const OPTIONS = {
  countryId: '00000000-0000-4000-8000-000000000001',
  versionId: '00000000-0000-4000-8000-000000000002',
  bytesSent: 42n,
  channel: 'public' as const,
};

describe('privacy-safe download event recording', () => {
  it('uses a configured salt and hashes only a normalized address', async () => {
    const { database, eventInsert, selectQuery } = makeDatabase();
    const request = makeRequest();

    await recordDownloadEvent(database as never, makeConfig('persisted-salt'), request, OPTIONS);

    const expectedHash = createHash('sha256')
      .update('203.0.113.9persisted-salt', 'utf8')
      .digest('hex');
    expect(database.selectFrom).not.toHaveBeenCalled();
    expect(eventInsert.values).toHaveBeenCalledWith({
      country_id: OPTIONS.countryId,
      version_id: OPTIONS.versionId,
      channel: 'public',
      bytes_sent: 42n,
      ip_hash: expectedHash,
      user_agent: 'audit-test',
    });
    expect(selectQuery.executeTakeFirst).not.toHaveBeenCalled();
  });

  it('loads the existing persisted salt and stores nulls for invalid IPs and non-string agents', async () => {
    const { database, eventInsert, selectQuery } = makeDatabase([{ value: 'stored-salt' }]);
    const request = makeRequest({ ip: 'not-an-ip', headers: { 'user-agent': ['multi', 'value'] } });

    await recordDownloadEvent(database as never, makeConfig(), request, {
      ...OPTIONS,
      channel: 'admin',
    });

    expect(selectQuery.executeTakeFirst).toHaveBeenCalledTimes(1);
    expect(eventInsert.values).toHaveBeenCalledWith({
      country_id: OPTIONS.countryId,
      version_id: OPTIONS.versionId,
      channel: 'admin',
      bytes_sent: 42n,
      ip_hash: null,
      user_agent: null,
    });
  });

  it('creates a missing salt once, rereads the persisted value, and uses the socket address fallback', async () => {
    let persistedValue: string | undefined;
    const { database, eventInsert, selectQuery, settingInsert } = makeDatabase();
    selectQuery.executeTakeFirst.mockImplementation(() =>
      Promise.resolve(persistedValue === undefined ? undefined : { value: persistedValue }),
    );
    settingInsert.values.mockImplementation((row: unknown) => {
      persistedValue = (row as { value: string }).value;
      return settingInsert;
    });
    const request = makeRequest({
      ip: undefined,
      raw: { socket: { remoteAddress: '[2001:db8::9]:443' } },
    });

    await recordDownloadEvent(database as never, makeConfig(), request, OPTIONS);

    expect(selectQuery.executeTakeFirst).toHaveBeenCalledTimes(2);
    expect(settingInsert.values.mock.calls[0]?.[0]).toEqual({
      key: 'privacy.ipHashSalt',
      value: persistedValue,
    });
    expect(settingInsert.onConflict).toHaveBeenCalledTimes(1);
    expect(eventInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        ip_hash: createHash('sha256')
          .update(`2001:db8::9${persistedValue ?? ''}`, 'utf8')
          .digest('hex'),
      }),
    );
  });

  it('logs recording failures without rejecting a completed transfer', async () => {
    const warning = vi.fn<(fields: unknown, message: string) => void>();
    const request = makeRequest({ log: { warn: warning } });
    const eventInsert = {
      values: vi.fn(() => eventInsert),
      execute: vi.fn(() => Promise.reject(new Error('database unavailable'))),
    };
    const database = {
      insertInto: vi.fn(() => eventInsert),
      selectFrom: vi.fn(),
    };

    await expect(
      recordDownloadEvent(database as never, makeConfig('salt'), request, OPTIONS),
    ).resolves.toBeUndefined();

    expect(warning.mock.calls[0]?.[0]).toMatchObject({
      countryId: OPTIONS.countryId,
      versionId: OPTIONS.versionId,
      channel: 'public',
    });
    expect(warning.mock.calls[0]?.[1]).toBe('could not record map download event');
  });

  it('warns when the generated salt cannot be read back after persistence', async () => {
    const warning = vi.fn<(fields: unknown, message: string) => void>();
    const request = makeRequest({ log: { warn: warning } });
    const { database } = makeDatabase([undefined, undefined]);

    await recordDownloadEvent(database as never, makeConfig(), request, OPTIONS);

    const fields = warning.mock.calls[0]?.[0] as { err?: unknown } | undefined;
    expect(fields?.err).toBeInstanceOf(Error);
    expect(warning.mock.calls[0]?.[1]).toBe('could not record map download event');
  });
});
