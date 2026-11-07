import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  ProxyApplyResponseSchema,
  ProxyHealthReportSchema,
  type ProxyHealthReport,
} from '@mapirror/shared';

const healthMock = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../../src/modules/network/proxy-health', () => ({
  checkGeofabrikProxy: healthMock.check,
}));

import { buildApp, parseEnv } from '../../src/index';
import { AUDIT_ACTIONS } from '../../src/db/repositories/audit-logs';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const ENDPOINT = 'http://proxy.example.test:8080';

function report(endpoint: string | null, passed = true): ProxyHealthReport {
  const ids: ProxyHealthReport['checks'][number]['id'][] = [
    'geofabrik-index',
    'geofabrik-region-page',
    'geofabrik-pbf-head',
    'geofabrik-md5',
    'geofabrik-pbf-range',
  ];
  return {
    checkedAt: '2026-11-07T12:00:00.000Z',
    proxyUsed: endpoint !== null,
    endpoint,
    passed,
    checks: ids.map((id) => ({
      id,
      label: id,
      method: id === 'geofabrik-pbf-head' ? 'HEAD' : 'GET',
      url: `https://download.geofabrik.de/${id}`,
      status: id === 'geofabrik-pbf-range' ? 206 : passed ? 200 : 503,
      statusText: passed ? 'OK' : 'Service Unavailable',
      expected: 'Expected status and valid source response',
      passed,
      reason: passed
        ? 'HTTP response and source content validated.'
        : 'HTTP 503 Service Unavailable.',
      durationMs: 3,
    })),
  };
}

async function withProxyApp(
  run: (context: { app: FastifyInstance; token: string }) => Promise<void>,
) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'proxy-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const { token } = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const app = await buildApp({ config: parseEnv({ DATABASE_URL: dsnFor(name) }), database });
      try {
        await run({ app, token });
      } finally {
        await app.close();
      }
    },
    { prefix: 'proxyapi', migrate: true },
  );
}

function request(
  app: FastifyInstance,
  token: string | undefined,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

describe.skipIf(skipReason !== null)('admin outbound proxy API', () => {
  it('protects every endpoint and validates requests before performing health checks', async () => {
    await withProxyApp(async ({ app, token }) => {
      for (const [method, url] of [
        ['GET', '/_admin/api/network/proxy'],
        ['POST', '/_admin/api/network/proxy/check'],
        ['PUT', '/_admin/api/network/proxy'],
        ['DELETE', '/_admin/api/network/proxy'],
      ] as const) {
        expect((await request(app, undefined, method, url, {})).statusCode).toBe(401);
      }

      const invalid = await request(app, token, 'PUT', '/_admin/api/network/proxy', {
        endpoint: 'http://user:secret@proxy.example.test:8080',
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain('secret');
      expect(healthMock.check).not.toHaveBeenCalled();
      expect(
        await app.db.db
          .selectFrom('settings')
          .select('key')
          .where('key', '=', 'network.outboundProxy')
          .executeTakeFirst(),
      ).toBeUndefined();
    });
  });

  it('tests a draft endpoint without persisting or activating it', async () => {
    healthMock.check.mockReset().mockResolvedValue(report(ENDPOINT));
    await withProxyApp(async ({ app, token }) => {
      const response = await request(app, token, 'POST', '/_admin/api/network/proxy/check', {
        endpoint: ENDPOINT,
      });
      expect(response.statusCode).toBe(200);
      const health = ProxyHealthReportSchema.parse(response.json<unknown>());
      expect(health.passed).toBe(true);
      expect(health.checks).toHaveLength(5);
      expect(healthMock.check).toHaveBeenCalledWith(
        expect.objectContaining({
          proxyEndpoint: ENDPOINT,
          baseUrl: 'https://download.geofabrik.de',
        }),
      );
      expect(app.outboundProxy.endpoint).toBeNull();
      expect(
        await app.db.db
          .selectFrom('settings')
          .select('key')
          .where('key', '=', 'network.outboundProxy')
          .executeTakeFirst(),
      ).toBeUndefined();
    });
  });

  it('applies a healthy endpoint, stores no credentials, and audits only the setting key', async () => {
    healthMock.check.mockReset().mockResolvedValue(report(ENDPOINT));
    await withProxyApp(async ({ app, token }) => {
      const response = await request(app, token, 'PUT', '/_admin/api/network/proxy', {
        endpoint: ENDPOINT,
      });
      expect(response.statusCode).toBe(200);
      const applied = ProxyApplyResponseSchema.parse(response.json<unknown>());
      expect(applied).toMatchObject({
        applied: true,
        configuration: { configured: true, endpoint: ENDPOINT },
      });
      expect(applied.health.passed).toBe(true);
      expect(applied.health.checks).toHaveLength(5);
      expect(app.outboundProxy.endpoint).toBe(ENDPOINT);

      const stored = await app.db.db
        .selectFrom('settings')
        .select('value')
        .where('key', '=', 'network.outboundProxy')
        .executeTakeFirstOrThrow();
      expect(stored.value).toBe(ENDPOINT);

      const audit = await app.db.db
        .selectFrom('audit_logs')
        .select(['actor_name', 'action', 'metadata'])
        .where('action', '=', AUDIT_ACTIONS.settingsUpdate)
        .execute();
      expect(audit).toEqual([
        {
          actor_name: 'proxy-admin',
          action: 'settings.update',
          metadata: { keys: ['network.outboundProxy'] },
        },
      ]);
      expect(JSON.stringify(audit)).not.toContain(ENDPOINT);
    });
  });

  it('keeps an applied endpoint active when checks fail, then removes it idempotently', async () => {
    healthMock.check.mockReset().mockResolvedValue(report(ENDPOINT, false));
    await withProxyApp(async ({ app, token }) => {
      const failed = await request(app, token, 'PUT', '/_admin/api/network/proxy', {
        endpoint: ENDPOINT,
      });
      expect(failed.statusCode).toBe(200);
      const applyResult = ProxyApplyResponseSchema.parse(failed.json<unknown>());
      expect(applyResult).toMatchObject({
        applied: true,
        configuration: { configured: true, endpoint: ENDPOINT },
        health: { passed: false },
      });
      expect(app.outboundProxy.endpoint).toBe(ENDPOINT);

      healthMock.check.mockResolvedValue(report(ENDPOINT));
      await request(app, token, 'PUT', '/_admin/api/network/proxy', { endpoint: ENDPOINT });
      const removed = await request(app, token, 'DELETE', '/_admin/api/network/proxy');
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ configured: false, endpoint: null });
      expect(app.outboundProxy.endpoint).toBeNull();
      expect(
        await app.db.db
          .selectFrom('settings')
          .select('key')
          .where('key', '=', 'network.outboundProxy')
          .executeTakeFirst(),
      ).toBeUndefined();

      const audit = await app.db.db
        .selectFrom('audit_logs')
        .select('metadata')
        .where('action', '=', AUDIT_ACTIONS.settingsUpdate)
        .execute();
      expect(audit).toEqual([
        { metadata: { keys: ['network.outboundProxy'] } },
        { metadata: { keys: ['network.outboundProxy'] } },
        { metadata: { keys: ['network.outboundProxy'], removed: true } },
      ]);
    });
  });
});
