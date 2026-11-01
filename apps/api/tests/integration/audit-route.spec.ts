import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv, type SqlDatabase } from '../../src/index';
import type { JsonValue } from '../../src/db/schema';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('admin audit log API', () => {
  it('filters by exact action and paginates newest-first without returning IPs or credentials', async () => {
    await withAuditApi(async ({ app, token, database, adminId }) => {
      const base = new Date('2026-10-20T10:00:00.000Z');
      const entries: Array<{ action: string; createdAt: Date; metadata: JsonValue }> = [
        {
          action: 'auth.login_failed',
          createdAt: new Date(base.getTime() + 1_000),
          metadata: {
            reason: 'wrong_password',
            password: 'never-return-this-password',
            userAgent: 'Bearer never-return-this-token',
            nested: {
              clientIp: '203.0.113.42',
              accessToken: 'never-return-this-token',
              retained: 'safe detail',
            },
          },
        },
        {
          action: 'settings.update',
          createdAt: new Date(base.getTime() + 2_000),
          metadata: { keys: ['branding.displayName'] },
        },
        {
          action: 'auth.login_failed',
          createdAt: new Date(base.getTime() + 3_000),
          metadata: { reason: 'unknown_username' },
        },
      ];

      for (const entry of entries) {
        await database.db
          .insertInto('audit_logs')
          .values({
            actor_id: adminId,
            actor_name: 'audit-admin',
            action: entry.action,
            target_type: null,
            target_id: null,
            metadata: entry.metadata,
            ip: '192.0.2.25',
            created_at: entry.createdAt,
          })
          .execute();
      }

      const page = await getAudit(
        app,
        token,
        '/_admin/api/audit?action=auth.login_failed&page=2&limit=1',
      );
      expect(page.statusCode).toBe(200);
      const body = page.json<{
        data: Array<Record<string, unknown>>;
        meta: { page: number; limit: number; total: number; totalPages: number };
      }>();
      expect(body.meta).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        actorName: 'audit-admin',
        action: 'auth.login_failed',
        metadata: { reason: 'wrong_password', nested: { retained: 'safe detail' } },
      });
      expect(body.data[0]).not.toHaveProperty('ip');
      expect(body.data[0]).not.toHaveProperty('actorId');
      for (const secret of [
        '192.0.2.25',
        '203.0.113.42',
        'never-return-this-password',
        'never-return-this-token',
      ]) {
        expect(page.body).not.toContain(secret);
      }

      const filtered = await getAudit(app, token, '/_admin/api/audit?action=settings.update');
      expect(filtered.statusCode).toBe(200);
      expect(
        filtered.json<{ data: Array<{ action: string }>; meta: { total: number } }>(),
      ).toMatchObject({
        data: [{ action: 'settings.update' }],
        meta: { total: 1 },
      });
    });
  });

  it('requires admin auth and rejects undeclared query parameters', async () => {
    await withAuditApi(async ({ app, token }) => {
      expect((await app.inject({ method: 'GET', url: '/_admin/api/audit' })).statusCode).toBe(401);
      const invalid = await getAudit(app, token, '/_admin/api/audit?includeIp=true');
      expect(invalid.statusCode).toBe(400);
    });
  });
});

async function withAuditApi(run: (harness: AuditApiHarness) => Promise<void>) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'audit-admin', password_hash: 'unused' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const issued = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
        logger: false,
      });
      try {
        await run({ app, token: issued.token, database, adminId: admin.id });
      } finally {
        await app.close();
      }
    },
    { prefix: 'auditapi', migrate: true },
  );
}

interface AuditApiHarness {
  readonly app: FastifyInstance;
  readonly token: string;
  readonly database: SqlDatabase;
  readonly adminId: string;
}

function getAudit(app: FastifyInstance, token: string, url: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}
