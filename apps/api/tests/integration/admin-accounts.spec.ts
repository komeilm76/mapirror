import { describe, expect, it } from 'vitest';

import {
  ensureAdmin,
  parseAdminUsername,
  AdminUsernameError,
} from '../../src/modules/auth/admin-accounts';
import { AUDIT_ACTIONS } from '../../src/db/repositories/audit-logs';
import { verifyPassword } from '../../src/modules/auth/password';
import { sql } from 'kysely';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';
import { createDatabase } from '../../src/db/client';
import { parseEnv } from '../../src/config/env';

/**
 * `ensureAdmin` on a real database (`P1-AUTH-06`).
 *
 * `scripts/tests/init-admin.spec.ts` proves what the operator sees. This file proves the three properties that only a
 * real database can settle, because each one is about a commit, an index or a race:
 *
 * 1. **All or nothing.** The account and its audit row are one transaction, so a failure after the insert leaves no
 *    account behind. A bootstrap script that can create an unaudited admin is a script that can create an admin nobody
 *    knows about.
 * 2. **The unique index is the arbiter.** Two runs at once — the normal case when a Compose stack scales to two API
 *    containers — must produce one account and two `exists`/`created` answers, never a crash and never a duplicate.
 *    Two separate connections are needed: a single handle serialises its own statements and would never exercise the
 *    `23505` branch (the same reason `integration/transaction.spec.ts` opens two).
 * 3. **The stored password is verifiable and the input is not stored.** Hash, not password; and the login path's
 *    verifier accepts exactly the string that was supplied — which also proves the policy did not quietly normalise it.
 */

const skipReason = await freshDatabaseSkipReason();

/** Every case needs the schema: `withFreshDatabase` creates an empty database and does not migrate unless asked. */
const MIGRATED = { prefix: 'ensure', migrate: true } as const;

const PASSWORD = 'zebra-quartz-58-lantern';

describe('parseAdminUsername', () => {
  it('trims surrounding whitespace, which is the only silent change made to the input', () => {
    expect(parseAdminUsername('  admin  ')).toBe('admin');
    expect(parseAdminUsername('owner')).toBe('owner');
  });

  it('accepts exactly the longest name the login contract accepts', () => {
    expect(parseAdminUsername('a'.repeat(64))).toHaveLength(64);
    expect(() => parseAdminUsername('a'.repeat(65))).toThrow(AdminUsernameError);
  });

  it('counts code points, so a 64-character name of emoji is accepted and 65 is not', () => {
    // `[...name].length`, not `name.length`: `'👤'.length` is 2, so a length check would refuse a name the login route
    // (which counts the same way) accepts.
    expect([...parseAdminUsername('👤'.repeat(64))]).toHaveLength(64);
    expect(() => parseAdminUsername('👤'.repeat(65))).toThrow(AdminUsernameError);
  });

  it('refuses an empty or whitespace-only name', () => {
    expect(() => parseAdminUsername('')).toThrow(AdminUsernameError);
    expect(() => parseAdminUsername('   ')).toThrow(AdminUsernameError);
  });

  it('refuses control characters, including one hidden inside an otherwise fine name', () => {
    // A newline would break the audit line and the operator's terminal; a NUL would truncate it in some consumers.
    expect(() => parseAdminUsername('adm\nin')).toThrow(/control characters/u);
    expect(() => parseAdminUsername('admin\u0000')).toThrow(/control characters/u);
    expect(() => parseAdminUsername('ad\u009bmin')).toThrow(/control characters/u);
  });

  it('reports every problem at once', () => {
    // One run, one message: the operator is at a prompt, not editing a form field.
    try {
      parseAdminUsername(`${'a'.repeat(65)}\n`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminUsernameError);
      const rules = (error as AdminUsernameError).problems.map((problem) => problem.rule);
      expect(rules).toEqual(['too-long', 'control-character']);
    }
  });

  it('does not echo the name in the message it returns', () => {
    // The name is the thing being rejected; a log line that contains it can carry a newline to a log parser, and a
    // message capped at "too long" is all the operator needs to fix it.
    try {
      parseAdminUsername('secretname'.repeat(7));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('secretname');
    }
  });
});

describe.skipIf(skipReason !== null)('ensureAdmin — against a real database', () => {
  it('creates the account and its audit row in one commit', async () => {
    await withFreshDatabase(async (database) => {
      const outcome = await ensureAdmin(database.db, { username: 'admin', password: PASSWORD });

      expect(outcome.status).toBe('created');

      const stored = await database.db
        .selectFrom('admins')
        .select(['id', 'username', 'password_hash', 'is_active'])
        .executeTakeFirstOrThrow();
      expect(stored.id).toBe(outcome.admin.id);
      expect(stored.username).toBe('admin');
      expect(stored.is_active).toBe(true);
      expect(stored.password_hash).not.toContain(PASSWORD);
      await expect(verifyPassword(stored.password_hash, PASSWORD)).resolves.toBe(true);

      const audit = await database.db
        .selectFrom('audit_logs')
        .select(['action', 'actor_id', 'actor_name', 'target_type', 'target_id', 'metadata'])
        .executeTakeFirstOrThrow();
      expect(audit.action).toBe(AUDIT_ACTIONS.adminCreated);
      expect(audit.target_id).toBe(stored.id);
      expect(audit.actor_id).toBeNull();
      expect(audit.actor_name).toBe('init-admin');
      expect(audit.metadata).toEqual({ username: 'admin' });
    }, MIGRATED);
  });

  it('leaves no account behind when the audit insert fails', async () => {
    // Forced, not simulated: dropping the table makes `insertAuditLog` fail inside the transaction, after the account
    // row was inserted. If the two were not one transaction, the account would survive — silently unaudited.
    await withFreshDatabase(async (database, name) => {
      await database.db.schema.dropTable('audit_logs').execute();

      await expect(
        ensureAdmin(database.db, { username: 'admin', password: PASSWORD }),
      ).rejects.toThrow();

      const rows = await database.db.selectFrom('admins').select('id').execute();
      expect(rows).toEqual([]);

      // And the database is still usable afterwards: the failed transaction released its connection.
      const fresh = createDatabase(parseEnv({ DATABASE_URL: dsnFor(name) }));
      try {
        await expect(fresh.db.selectFrom('admins').select('id').execute()).resolves.toEqual([]);
      } finally {
        await fresh.close();
      }
    }, MIGRATED);
  });

  it('does not overwrite an existing account, even with a different password', async () => {
    await withFreshDatabase(async (database) => {
      const first = await ensureAdmin(database.db, { username: 'admin', password: PASSWORD });
      const before = await database.db.selectFrom('admins').selectAll().executeTakeFirstOrThrow();

      const second = await ensureAdmin(database.db, {
        username: 'admin',
        password: 'a completely different passphrase',
      });

      expect(first.status).toBe('created');
      expect(second.status).toBe('exists');
      expect(second.admin.id).toBe(first.admin.id);

      const after = await database.db.selectFrom('admins').selectAll().executeTakeFirstOrThrow();
      expect(after.password_hash).toBe(before.password_hash);
      expect(after.updated_at).toEqual(before.updated_at);
      // One creation, one audit row: the second call wrote nothing at all.
      const audits = await database.db.selectFrom('audit_logs').select('id').execute();
      expect(audits).toHaveLength(1);
    }, MIGRATED);
  });

  it('matches an existing account in a different case, through the lower(username) index', async () => {
    await withFreshDatabase(async (database) => {
      await ensureAdmin(database.db, { username: 'Admin', password: PASSWORD });
      const outcome = await ensureAdmin(database.db, { username: 'ADMIN', password: PASSWORD });

      expect(outcome.status).toBe('exists');
      // The stored name keeps the case it was created with; only the comparison is case-insensitive.
      expect(outcome.admin.username).toBe('Admin');
      const rows = await database.db.selectFrom('admins').select('username').execute();
      expect(rows).toHaveLength(1);
    }, MIGRATED);
  });

  it('reports `exists` for a deactivated account instead of re-activating it', async () => {
    await withFreshDatabase(async (database) => {
      await ensureAdmin(database.db, { username: 'admin', password: PASSWORD });
      await database.db.updateTable('admins').set({ is_active: false }).execute();

      const outcome = await ensureAdmin(database.db, { username: 'admin', password: PASSWORD });

      expect(outcome.status).toBe('exists');
      expect(outcome.admin.isActive).toBe(false);
      const row = await database.db
        .selectFrom('admins')
        .select('is_active')
        .executeTakeFirstOrThrow();
      expect(row.is_active).toBe(false);
    }, MIGRATED);
  });

  it('survives two concurrent creations: one account, one audit row, one 23505 path', async () => {
    // Two pools, so the two inserts are genuinely concurrent — one handle would queue them and never hit the race.
    await withFreshDatabase(async (database, name) => {
      const second = createDatabase(parseEnv({ DATABASE_URL: dsnFor(name) }));
      try {
        const outcomes = await Promise.all([
          ensureAdmin(database.db, { username: 'admin', password: PASSWORD }),
          ensureAdmin(second.db, { username: 'admin', password: PASSWORD }),
        ]);

        // Exactly one created, exactly one found — in either order.
        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['created', 'exists']);
        expect(new Set(outcomes.map((outcome) => outcome.admin.id)).size).toBe(1);

        const admins = await database.db.selectFrom('admins').select('id').execute();
        expect(admins).toHaveLength(1);
        const audits = await database.db.selectFrom('audit_logs').select('action').execute();
        expect(audits).toEqual([{ action: AUDIT_ACTIONS.adminCreated }]);
      } finally {
        await second.close();
      }
    }, MIGRATED);
  });

  it('re-throws a unique violation that is not about this username', async () => {
    // A `23505` arrives from *some* unique constraint. If the row it collided with cannot be found, the collision was
    // not ours — a trigger, a future second index — and swallowing it would report "already exists" for an account that
    // does not exist. Simulated with a trigger, which is the only way to raise `23505` without storing a row.
    await withFreshDatabase(async (database) => {
      await sql`
        create function admins_reject_insert() returns trigger
        language plpgsql as $$
        begin
          raise exception 'duplicate key value violates unique constraint'
            using errcode = '23505';
        end;
        $$
      `.execute(database.db);
      await sql`
        create trigger admins_reject_insert before insert on admins
        for each row execute function admins_reject_insert()
      `.execute(database.db);

      await expect(
        ensureAdmin(database.db, { username: 'admin', password: PASSWORD }),
      ).rejects.toThrow(/duplicate key/u);

      expect(await database.db.selectFrom('admins').select('id').execute()).toEqual([]);
    }, MIGRATED);
  });

  it('refuses a weak password before touching the database, and stores nothing', async () => {
    await withFreshDatabase(async (database) => {
      // The username is in the password, which the policy refuses (`password.ts`).
      await expect(
        ensureAdmin(database.db, { username: 'admin', password: 'admin-is-my-password' }),
      ).rejects.toThrow(/username/u);

      await expect(
        ensureAdmin(database.db, { username: 'admin', password: 'short' }),
      ).rejects.toThrow(/at least 12/u);

      expect(await database.db.selectFrom('admins').select('id').execute()).toEqual([]);
    }, MIGRATED);
  });

  it('refuses an unusable username before hashing', async () => {
    // Measured: with an unusable name the promise settles in well under a hash. The assertion is on the outcome, not on
    // a stopwatch — `parseAdminUsername` throwing first is what makes it fast, and that is what is checked.
    await withFreshDatabase(async (database) => {
      await expect(
        ensureAdmin(database.db, { username: '   ', password: PASSWORD }),
      ).rejects.toBeInstanceOf(AdminUsernameError);
      expect(await database.db.selectFrom('admins').select('id').execute()).toEqual([]);
    }, MIGRATED);
  });

  it('records the supplied clock and actor', async () => {
    await withFreshDatabase(async (database) => {
      const now = new Date('2026-02-03T04:05:06.000Z');
      await ensureAdmin(database.db, {
        username: 'owner',
        password: PASSWORD,
        now,
        actorName: 'reset-admin-password',
      });

      const audit = await database.db
        .selectFrom('audit_logs')
        .select(['actor_name', 'created_at'])
        .executeTakeFirstOrThrow();
      expect(audit.actor_name).toBe('reset-admin-password');
      expect(new Date(audit.created_at).toISOString()).toBe(now.toISOString());

      const admin = await database.db
        .selectFrom('admins')
        .select('created_at')
        .executeTakeFirstOrThrow();
      expect(new Date(admin.created_at).toISOString()).toBe(now.toISOString());
    }, MIGRATED);
  });
});
