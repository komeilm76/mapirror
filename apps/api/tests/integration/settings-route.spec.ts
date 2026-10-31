import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv } from '../../src/index';
import { AUDIT_ACTIONS } from '../../src/db/repositories/audit-logs';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

async function withSettingsApp(
  run: (context: { app: FastifyInstance; token: string }) => Promise<void>,
) {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        .values({ username: 'settings-admin', password_hash: 'unused' })
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
    { prefix: 'settingsapi', migrate: true },
  );
}

function settingsRequest(app: FastifyInstance, token?: string) {
  return app.inject({
    method: 'GET',
    url: '/_admin/api/settings',
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}

function patchSettings(app: FastifyInstance, token: string, payload: unknown) {
  return app.inject({
    method: 'PATCH',
    url: '/_admin/api/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
}

describe.skipIf(skipReason !== null)('admin settings API', () => {
  it('requires authentication and returns only safe editable settings with config fallbacks', async () => {
    await withSettingsApp(async ({ app, token }) => {
      expect((await settingsRequest(app)).statusCode).toBe(401);
      await app.db.db
        .insertInto('settings')
        .values([
          { key: 'privacy.ipHashSalt', value: JSON.stringify('do-not-return-this') },
          { key: 'source.catalogSyncedAt', value: JSON.stringify('2026-10-31T12:00:00.000Z') },
          { key: 'database.password', value: JSON.stringify('never-return-this') },
          { key: 'branding.displayName', value: JSON.stringify('Mirror North') },
          { key: 'cache.keepVersions', value: JSON.stringify(5) },
        ])
        .execute();

      const response = await settingsRequest(app, token);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        settings: {
          branding: { displayName: 'Mirror North' },
          cache: { keepVersions: 5, diskReserveBytes: 2_147_483_648 },
          public: { downloadsPerMinute: 10 },
          source: { catalogTtlMinutes: 360 },
        },
      });
      expect(response.body).not.toContain('do-not-return-this');
      expect(response.body).not.toContain('never-return-this');
      expect(response.body).not.toContain('catalogSyncedAt');
    });
  });

  it('updates only supplied editable values and writes one key-only audit record', async () => {
    await withSettingsApp(async ({ app, token }) => {
      await app.db.db
        .insertInto('settings')
        .values({ key: 'privacy.ipHashSalt', value: JSON.stringify('preserve-this-secret') })
        .execute();

      const response = await patchSettings(app, token, {
        branding: { displayName: '  North Mirror  ' },
        cache: { keepVersions: 4, diskReserveBytes: 536_870_912 },
        public: { downloadsPerMinute: 20 },
        source: { catalogTtlMinutes: 90 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        settings: {
          branding: { displayName: 'North Mirror' },
          cache: { keepVersions: 4, diskReserveBytes: 536_870_912 },
          public: { downloadsPerMinute: 20 },
          source: { catalogTtlMinutes: 90 },
        },
      });
      expect(response.body).not.toContain('preserve-this-secret');

      const salt = await app.db.db
        .selectFrom('settings')
        .select('value')
        .where('key', '=', 'privacy.ipHashSalt')
        .executeTakeFirstOrThrow();
      expect(salt.value).toBe('preserve-this-secret');
      const audit = await app.db.db
        .selectFrom('audit_logs')
        .select(['actor_name', 'action', 'target_type', 'target_id', 'metadata'])
        .where('action', '=', AUDIT_ACTIONS.settingsUpdate)
        .execute();
      expect(audit).toEqual([
        {
          actor_name: 'settings-admin',
          action: 'settings.update',
          target_type: 'settings',
          target_id: null,
          metadata: {
            keys: [
              'branding.displayName',
              'cache.keepVersions',
              'cache.diskReserveBytes',
              'public.downloadsPerMinute',
              'source.catalogTtlMinutes',
            ],
          },
        },
      ]);
      expect(JSON.stringify(audit)).not.toContain('North Mirror');
    });
  });

  it('rejects empty, unknown and out-of-range updates without changing settings', async () => {
    await withSettingsApp(async ({ app, token }) => {
      for (const payload of [
        {},
        { privacy: { ipHashSalt: 'attempt' } },
        { cache: { keepVersions: 11 } },
      ]) {
        const response = await patchSettings(app, token, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
      }
      await expect(app.db.db.selectFrom('settings').selectAll().execute()).resolves.toEqual([]);
      const query = await app.inject({
        method: 'GET',
        url: '/_admin/api/settings?includeSecrets=true',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(query.statusCode).toBe(400);
    });
  });

  it('rolls back setting changes when the audit insert fails', async () => {
    await withSettingsApp(async ({ app, token }) => {
      await sql`alter table audit_logs add constraint reject_settings_audit check (action <> 'settings.update')`.execute(
        app.db.db,
      );
      const response = await patchSettings(app, token, {
        branding: { displayName: 'Uncommitted' },
      });
      expect(response.statusCode).toBe(500);
      await expect(
        app.db.db
          .selectFrom('settings')
          .selectAll()
          .where('key', '=', 'branding.displayName')
          .execute(),
      ).resolves.toEqual([]);
    });
  });
});
