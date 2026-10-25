import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app';

import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';
import { createDatabase } from '../../src/db/client';
import { parseEnv } from '../../src/config/env';
import {
  ensureAdmin,
  resetAdminPassword,
  AdminNotFoundError,
} from '../../src/modules/auth/admin-accounts';
import { verifyPassword } from '../../src/modules/auth/password';
import { issueToken, verifyToken } from '../../src/modules/auth/tokens';
import { AUDIT_ACTIONS } from '../../src/db/repositories/audit-logs';

/**
 * `resetAdminPassword` on a real database (`P1-AUTH-07`, AUTH-4).
 *
 * The script's own suite (`scripts/tests/reset-admin-password.spec.ts`) proves what an operator sees. This file proves
 * the two properties only a database can settle:
 *
 * 1. **The hash and the revocations commit together.** A reset that wrote the hash and then failed before revoking
 *    would leave a live session holding the account the operator was trying to lock out — the exact situation a reset
 *    exists to end. The failure is forced by dropping `audit_logs`, which makes the third statement of the transaction
 *    fail after the first two succeeded.
 * 2. **Revocation is per account and idempotent.** Another admin's session survives, and a second reset counts zero
 *    rather than claiming it ended sessions that were already gone (the number is what an operator reads to decide
 *    whether the reset did what they feared it would).
 */

const skipReason = await freshDatabaseSkipReason();

const OLD_PASSWORD = 'old-horse-battery-staple';
const NEW_PASSWORD = 'zebra-quartz-58-lantern';

/** Every case needs the schema. */
const MIGRATED = { prefix: 'resetpw', migrate: true } as const;

/** When the fixture account was created — before any case's clock, so `created_at < updated_at` is a fact, not luck. */
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * Creates `admin` with a token, and runs the case in a freshly migrated database.
 *
 * The account is created with an explicit clock: the alternative is comparing `created_at` with an injected reset
 * instant and passing or failing depending on the year the suite is run in (measured — the first version asserted the
 * account predated a 2026-03-04 reset while `ensureAdmin` had used the real clock).
 *
 * @param run - Receives the database, its name and a live token.
 */
async function withAccount(
  run: (context: {
    database: Parameters<Parameters<typeof withFreshDatabase>[0]>[0];
    name: string;
    token: string;
  }) => Promise<void>,
): Promise<void> {
  await withFreshDatabase(async (database, name) => {
    const admin = await ensureAdmin(database.db, {
      username: 'admin',
      password: OLD_PASSWORD,
      now: CREATED_AT,
    });
    const issued = await issueToken(database.db, admin.admin.id, { ttlHours: 12 });
    await run({ database, name, token: issued.token });
  }, MIGRATED);
}

describe.skipIf(skipReason !== null)('resetAdminPassword — against a real database', () => {
  it('replaces the hash, revokes every open session and audits both', async () => {
    await withAccount(async ({ database, token }) => {
      const now = new Date('2026-03-04T05:06:07.000Z');
      const result = await resetAdminPassword(database.db, {
        username: 'admin',
        password: NEW_PASSWORD,
        now,
        actorName: 'reset-admin-password',
      });

      expect(result.revokedTokens).toBe(1);
      expect(result.admin.username).toBe('admin');
      expect(result.admin.isActive).toBe(true);

      const stored = await database.db
        .selectFrom('admins')
        .select(['password_hash', 'created_at', 'updated_at'])
        .executeTakeFirstOrThrow();
      await expect(verifyPassword(stored.password_hash, NEW_PASSWORD)).resolves.toBe(true);
      await expect(verifyPassword(stored.password_hash, OLD_PASSWORD)).resolves.toBe(false);
      // The reset moves `updated_at` and leaves `created_at` where it was: a reset is not a new account.
      expect(new Date(stored.updated_at).toISOString()).toBe(now.toISOString());
      expect(new Date(stored.created_at).toISOString()).toBe(CREATED_AT.toISOString());

      // The verifier the API uses, not the database's own claim.
      expect((await verifyToken(database.db, token)).status).toBe('revoked');

      const audit = await database.db
        .selectFrom('audit_logs')
        .select([
          'action',
          'actor_id',
          'actor_name',
          'target_type',
          'target_id',
          'metadata',
          'created_at',
        ])
        .where('action', '=', AUDIT_ACTIONS.passwordReset)
        .executeTakeFirstOrThrow();
      expect(audit.actor_id).toBeNull();
      expect(audit.actor_name).toBe('reset-admin-password');
      expect(audit.target_type).toBe('admin');
      expect(audit.target_id).toBe(result.admin.id);
      expect(audit.metadata).toEqual({ username: 'admin', revokedTokens: 1 });
      expect(new Date(audit.created_at).toISOString()).toBe(now.toISOString());
    });
  });

  it('leaves the hash and the sessions alone when the audit write fails', async () => {
    // Forced, not simulated: the UPDATE and the revocations have already run when `insertAuditLog` fails, so this is
    // the only way to see whether the transaction actually covers all three statements.
    await withAccount(async ({ database, token }) => {
      await database.db.schema.dropTable('audit_logs').execute();

      await expect(
        resetAdminPassword(database.db, { username: 'admin', password: NEW_PASSWORD }),
      ).rejects.toThrow();

      const stored = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .executeTakeFirstOrThrow();
      await expect(verifyPassword(stored.password_hash, OLD_PASSWORD)).resolves.toBe(true);
      expect((await verifyToken(database.db, token)).status).toBe('valid');
    });
  });

  it('signs the old session out and lets the new password in, over HTTP', async () => {
    // The acceptance criterion AUTH-4 names, as a client experiences it: the token an open tab holds stops working, and
    // the password the operator just set is the one that logs in. The module-level tests prove the rows; this proves the
    // two endpoints agree with them.
    await withFreshDatabase(async (database, name) => {
      await ensureAdmin(database.db, { username: 'admin', password: OLD_PASSWORD });
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
      });

      try {
        const login = await app.inject({
          method: 'POST',
          url: '/_auth/api/login',
          payload: { username: 'admin', password: OLD_PASSWORD },
        });
        expect(login.statusCode).toBe(200);
        const { token } = login.json<{ token: string }>();
        const headers = { authorization: `Bearer ${token}` };

        expect(
          (await app.inject({ method: 'GET', url: '/_auth/api/me', headers })).statusCode,
        ).toBe(200);

        await resetAdminPassword(database.db, { username: 'admin', password: NEW_PASSWORD });

        const after = await app.inject({ method: 'GET', url: '/_auth/api/me', headers });
        expect(after.statusCode).toBe(401);
        expect(after.json<{ error: { code: string } }>().error.code).toBe('TOKEN_REVOKED');

        const stale = await app.inject({
          method: 'POST',
          url: '/_auth/api/login',
          payload: { username: 'admin', password: OLD_PASSWORD },
        });
        expect(stale.statusCode).toBe(401);
        expect(stale.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');

        const fresh = await app.inject({
          method: 'POST',
          url: '/_auth/api/login',
          payload: { username: 'admin', password: NEW_PASSWORD },
        });
        expect(fresh.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    }, MIGRATED);
  });

  it('counts only sessions that were still open', async () => {
    await withAccount(async ({ database }) => {
      const first = await resetAdminPassword(database.db, {
        username: 'admin',
        password: NEW_PASSWORD,
      });
      const second = await resetAdminPassword(database.db, {
        username: 'admin',
        password: 'another good passphrase',
      });

      expect(first.revokedTokens).toBe(1);
      // The already-revoked token keeps its first `revoked_at`, so the second run revokes nothing.
      expect(second.revokedTokens).toBe(0);

      const audits = await database.db
        .selectFrom('audit_logs')
        .select('metadata')
        .where('action', '=', AUDIT_ACTIONS.passwordReset)
        .orderBy('id')
        .execute();
      expect(audits.map((row) => row.metadata)).toEqual([
        { username: 'admin', revokedTokens: 1 },
        { username: 'admin', revokedTokens: 0 },
      ]);
    });
  });

  it('does not touch another account or its sessions', async () => {
    await withFreshDatabase(async (database) => {
      const admin = await ensureAdmin(database.db, { username: 'admin', password: OLD_PASSWORD });
      const other = await ensureAdmin(database.db, { username: 'owner', password: OLD_PASSWORD });
      const adminToken = await issueToken(database.db, admin.admin.id, { ttlHours: 12 });
      const otherToken = await issueToken(database.db, other.admin.id, { ttlHours: 12 });

      await resetAdminPassword(database.db, { username: 'admin', password: NEW_PASSWORD });

      expect((await verifyToken(database.db, adminToken.token)).status).toBe('revoked');
      expect((await verifyToken(database.db, otherToken.token)).status).toBe('valid');

      const stored = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .where('username', '=', 'owner')
        .executeTakeFirstOrThrow();
      await expect(verifyPassword(stored.password_hash, OLD_PASSWORD)).resolves.toBe(true);
    }, MIGRATED);
  });

  it('matches the account in any case, and stores the name it already had', async () => {
    await withFreshDatabase(async (database) => {
      await ensureAdmin(database.db, { username: 'Admin', password: OLD_PASSWORD });

      const result = await resetAdminPassword(database.db, {
        username: '  ADMIN  ',
        password: NEW_PASSWORD,
      });

      expect(result.admin.username).toBe('Admin');
      const rows = await database.db.selectFrom('admins').select('username').execute();
      expect(rows).toEqual([{ username: 'Admin' }]);
    }, MIGRATED);
  });

  it('reports a missing account when it disappears between the lookup and the update', async () => {
    // The race a real deployment can hit: the account is deleted after `findAdminByUsername` saw it. A trigger that
    // returns `null` makes the UPDATE affect no row — exactly what "the row is gone" looks like to the query — without
    // needing to time a concurrent DELETE.
    await withAccount(async ({ database }) => {
      await sql`
        create function admins_skip_update() returns trigger language plpgsql as $$
        begin
          return null;
        end;
        $$
      `.execute(database.db);
      await sql`
        create trigger admins_skip_update before update on admins
        for each row execute function admins_skip_update()
      `.execute(database.db);

      await expect(
        resetAdminPassword(database.db, { username: 'admin', password: NEW_PASSWORD }),
      ).rejects.toBeInstanceOf(AdminNotFoundError);

      // Nothing was audited for a reset that did not happen.
      const resets = await database.db
        .selectFrom('audit_logs')
        .select('id')
        .where('action', '=', AUDIT_ACTIONS.passwordReset)
        .execute();
      expect(resets).toEqual([]);
    });
  });

  it('reports a missing account, and audits nothing', async () => {
    await withAccount(async ({ database }) => {
      await expect(
        resetAdminPassword(database.db, { username: 'nobody', password: NEW_PASSWORD }),
      ).rejects.toBeInstanceOf(AdminNotFoundError);

      const resets = await database.db
        .selectFrom('audit_logs')
        .select('id')
        .where('action', '=', AUDIT_ACTIONS.passwordReset)
        .execute();
      expect(resets).toEqual([]);
    });
  });

  it('resets a deactivated account without re-enabling it', async () => {
    await withAccount(async ({ database }) => {
      await database.db.updateTable('admins').set({ is_active: false }).execute();

      const result = await resetAdminPassword(database.db, {
        username: 'admin',
        password: NEW_PASSWORD,
      });

      expect(result.admin.isActive).toBe(false);
      const row = await database.db
        .selectFrom('admins')
        .select('is_active')
        .executeTakeFirstOrThrow();
      expect(row.is_active).toBe(false);
    });
  });

  it('rejects a weak password before writing anything', async () => {
    await withAccount(async ({ database, token }) => {
      await expect(
        resetAdminPassword(database.db, { username: 'admin', password: 'admin-is-my-password' }),
      ).rejects.toThrow(/username/u);
      await expect(
        resetAdminPassword(database.db, { username: 'admin', password: 'short' }),
      ).rejects.toThrow(/at least 12/u);

      expect((await verifyToken(database.db, token)).status).toBe('valid');
      const stored = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .executeTakeFirstOrThrow();
      await expect(verifyPassword(stored.password_hash, OLD_PASSWORD)).resolves.toBe(true);
    });
  });

  it('leaves one whole password in place when two resets race', async () => {
    // Two operators, two terminals, one account. Either reset may land last; what must not happen is a hash that
    // matches neither (a torn write) or a surviving session. Two pools, so the transactions genuinely interleave.
    await withAccount(async ({ database, name }) => {
      const second = createDatabase(parseEnv({ DATABASE_URL: dsnFor(name) }));
      try {
        const passwords = [NEW_PASSWORD, 'another good passphrase'];
        const results = await Promise.all(
          passwords.map((password) =>
            resetAdminPassword(database.db, { username: 'admin', password }).then(
              () => 'ok',
              () => 'failed',
            ),
          ),
        );
        expect(results).toEqual(['ok', 'ok']);

        const stored = await database.db
          .selectFrom('admins')
          .select('password_hash')
          .executeTakeFirstOrThrow();
        const matches: boolean[] = [];
        for (const password of passwords) {
          matches.push(await verifyPassword(stored.password_hash, password));
        }
        // Exactly one of the two, not both and not neither.
        expect(matches.filter(Boolean)).toHaveLength(1);
      } finally {
        await second.close();
      }
    });
  });
});
