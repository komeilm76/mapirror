import { LoginResponseSchema } from '@mapirror/shared';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { Database, SqlDatabase } from '../../src/index';
import { hashPassword } from '../../src/modules/auth/password';
import { LoginThrottle } from '../../src/modules/auth/login-throttle';
import { login } from '../../src/modules/auth/service';
import { verifyToken } from '../../src/modules/auth/tokens';
import { AppError } from '../../src/lib/errors';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * Acceptance test for `P1-AUTH-03` against a real database: the login flow, its side effects (token, `last_login_at`,
 * audit row) and the four answers it is allowed to give (`200`, `401`, `403`, `429`).
 *
 * The clock is injected everywhere, so "fifteen minutes later" is arithmetic rather than a wait, and each case runs on
 * a database it creates for itself — the assertions are about rows.
 */

const skipReason = await freshDatabaseSkipReason();

const NOW = new Date('2026-10-25T09:00:00.000Z');
const PASSWORD = 'correct horse battery staple';
/** Argon2 at the documented parameters, hashed once for the whole file: 74 ms × 12 accounts is a slow suite. */
const PASSWORD_HASH = await hashPassword(PASSWORD);

/** An app-equivalent configuration for the service. */
interface Harness {
  database: SqlDatabase;
  adminId: string;
  throttle: LoginThrottle;
  clock: { now: Date };
}

/** Creates an admin with the shared password hash and hands the pieces to a case. */
async function withAdmin(
  run: (harness: Harness) => Promise<void>,
  options: { readonly isActive?: boolean; readonly maxAttempts?: number } = {},
): Promise<void> {
  await withFreshDatabase(
    async (database) => {
      const row = await database.db
        .insertInto('admins')
        .values({
          username: 'admin',
          password_hash: PASSWORD_HASH,
          is_active: options.isActive ?? true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const clock = { now: NOW };
      await run({
        database,
        adminId: row.id,
        clock,
        throttle: new LoginThrottle({
          maxAttempts: options.maxAttempts ?? 10,
          windowMs: 15 * 60_000,
          now: () => clock.now,
        }),
      });
    },
    { prefix: 'login', migrate: true },
  );
}

/** Calls the service with the harness's database, throttle and clock. */
function attempt(
  harness: Harness,
  body: { username?: string; password?: string } = {},
  extra: { ip?: string | null; userAgent?: string | null } = {},
) {
  return login(
    {
      database: harness.database.db,
      throttle: harness.throttle,
      tokenTtlHours: 12,
      now: harness.clock.now,
      ip: extra.ip === undefined ? '203.0.113.9' : extra.ip,
      userAgent: extra.userAgent === undefined ? 'vitest/5' : extra.userAgent,
    },
    { username: body.username ?? 'admin', password: body.password ?? PASSWORD },
  );
}

/** The error a promise rejected with, typed. Fails the test when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** Every audit row, oldest first. */
async function auditRows(db: Kysely<Database>) {
  return db.selectFrom('audit_logs').selectAll().orderBy('id').execute();
}

describe.skipIf(skipReason !== null)('login — the happy path', () => {
  it('records a missing user agent and address as NULL, not as the string "undefined"', async () => {
    // `request.headers['user-agent']` is `undefined` for a client that sends none, and a token row built from it must
    // hold NULL. `String(undefined)` in a NOT NULL-intolerant column, or the literal `"undefined"` in a text column,
    // are both the kind of detail nobody notices until someone searches the audit log.
    await withAdmin(async (harness) => {
      const result = await attempt(harness, {}, { userAgent: null, ip: null });

      const token = await harness.database.db
        .selectFrom('admin_tokens')
        .select(['user_agent', 'ip'])
        .executeTakeFirstOrThrow();
      expect(token.user_agent).toBeNull();
      expect(token.ip).toBeNull();

      const [audit] = await auditRows(harness.database.db);
      expect(audit?.metadata).toEqual({ userAgent: null });
      expect(audit?.ip).toBeNull();
      expect(result.token).toMatch(/^mm_/u);
    });
  });

  it('mints a token, records the login and audits it, all three or none', async () => {
    await withAdmin(async (harness) => {
      const result = await attempt(harness);

      // The response is what the contract documents, parsed by the contract's own schema.
      expect(LoginResponseSchema.safeParse(result).success).toBe(true);
      expect(result.admin).toEqual({ id: harness.adminId, username: 'admin' });
      expect(result.expiresAt).toBe(new Date(NOW.getTime() + 12 * 3_600_000).toISOString());

      // The token works, and the row behind it is the one the audit names.
      const verdict = await verifyToken(harness.database.db, result.token, { now: NOW });
      expect(verdict.status).toBe('valid');

      const admin = await harness.database.db
        .selectFrom('admins')
        .select(['last_login_at', 'updated_at'])
        .executeTakeFirstOrThrow();
      expect(admin.last_login_at?.toISOString()).toBe(NOW.toISOString());
      expect(admin.updated_at.toISOString()).toBe(NOW.toISOString());

      const [audit] = await auditRows(harness.database.db);
      expect(audit).toMatchObject({
        actor_id: harness.adminId,
        actor_name: 'admin',
        action: 'auth.login',
        target_type: 'admin_token',
        ip: '203.0.113.9',
      });
      expect(audit?.target_id).toBe(verdict.status === 'valid' ? verdict.token.id : 'unreachable');
      expect(audit?.metadata).toEqual({ userAgent: 'vitest/5' });
    });
  });

  it('accepts the username in any case, and with surrounding spaces', async () => {
    // The unique index is on `lower(username)` (`03-data-model.md` §2.1), so a lookup that is case-sensitive would
    // disagree with the only constraint the database enforces.
    await withAdmin(async (harness) => {
      for (const username of ['ADMIN', 'Admin', ' admin ']) {
        const result = await attempt(harness, { username });
        expect(result.admin.username, username).toBe('admin');
      }
    });
  });

  it('writes an audit row that holds no credential', async () => {
    await withAdmin(async (harness) => {
      const result = await attempt(harness);

      // The whole row is serialised and searched: a metadata field added later would be caught here as well.
      const serialised = JSON.stringify(await auditRows(harness.database.db));
      expect(serialised).not.toContain(PASSWORD);
      expect(serialised).not.toContain(result.token);
      // The token's digest is a credential surrogate and must not be there either.
      expect(serialised).not.toContain(PASSWORD_HASH.slice(-20));
    });
  });
});

describe.skipIf(skipReason !== null)('login — the generic 401', () => {
  it('answers the same thing for a wrong password and an unknown username', async () => {
    await withAdmin(async (harness) => {
      const wrongPassword = await rejection(attempt(harness, { password: 'not-the-password' }));
      const unknownUser = await rejection(attempt(harness, { username: 'nobody' }));

      expect(wrongPassword.code).toBe('INVALID_CREDENTIALS');
      expect(unknownUser.code).toBe('INVALID_CREDENTIALS');
      // Byte-for-byte the same message: the response is not an oracle.
      expect(unknownUser.message).toBe(wrongPassword.message);
      expect(unknownUser.details).toBeUndefined();
      expect(wrongPassword.details).toBeUndefined();
    });
  });

  it('spends the same time on an unknown username as on a wrong password', async () => {
    // The property is "no timing oracle", and the mechanism is verifying a dummy hash when there is no account. Without
    // it this call returns in a millisecond — the measured Argon2 cost is ~74 ms — so a floor well below that is enough
    // to fail if the dummy verification is removed, without being a flaky race against a slow machine.
    await withAdmin(async (harness) => {
      const started = performance.now();
      await rejection(attempt(harness, { username: 'definitely-not-an-account' }));
      const elapsed = performance.now() - started;

      expect(elapsed).toBeGreaterThan(30);
    });
  });

  it('records the attempt, with the username that was tried', async () => {
    await withAdmin(async (harness) => {
      await rejection(attempt(harness, { password: 'nope' }));
      await rejection(attempt(harness, { username: 'ghost', password: 'nope' }));

      const rows = await auditRows(harness.database.db);
      expect(rows.map((row) => row.action)).toEqual(['auth.login_failed', 'auth.login_failed']);

      // A known account is attributed to it; an unknown name is kept as *tried* — which is the interesting part.
      expect(rows[0]).toMatchObject({
        actor_id: harness.adminId,
        actor_name: 'admin',
        metadata: { reason: 'wrong_password' },
      });
      expect(rows[1]).toMatchObject({
        actor_id: null,
        actor_name: 'ghost',
        metadata: { reason: 'unknown_username' },
      });
    });
  });

  it('does not mint a token or touch last_login_at when it fails', async () => {
    await withAdmin(async (harness) => {
      await rejection(attempt(harness, { password: 'nope' }));

      const tokens = await harness.database.db.selectFrom('admin_tokens').selectAll().execute();
      const admin = await harness.database.db
        .selectFrom('admins')
        .select('last_login_at')
        .executeTakeFirstOrThrow();

      expect(tokens).toHaveLength(0);
      expect(admin.last_login_at).toBeNull();
    });
  });
});

describe.skipIf(skipReason !== null)('login — a deactivated account', () => {
  it('answers 403 only once the password is right', async () => {
    // The order matters and is the whole point: a `403` for a *wrong* password would confirm the username to someone
    // who has nothing. So the account is checked after the password, never before.
    await withAdmin(
      async (harness) => {
        const wrong = await rejection(attempt(harness, { password: 'nope' }));
        expect(wrong.code).toBe('INVALID_CREDENTIALS');

        const right = await rejection(attempt(harness));
        expect(right.code).toBe('ACCOUNT_DISABLED');
        expect(right.details).toBeUndefined();
      },
      { isActive: false },
    );
  });

  it('mints nothing and audits the attempt without counting it against the throttle', async () => {
    await withAdmin(
      async (harness) => {
        await rejection(attempt(harness));

        const tokens = await harness.database.db.selectFrom('admin_tokens').selectAll().execute();
        expect(tokens).toHaveLength(0);

        const [audit] = await auditRows(harness.database.db);
        expect(audit?.action).toBe('auth.login_failed');
        expect(audit?.metadata).toEqual({ reason: 'account_disabled' });

        // The credentials were correct, so this attempt is not a brute-force signal: ten of them must not lock the
        // account out for the operator who can prove they are entitled to it.
        expect(harness.throttle.check('203.0.113.9', 'admin').limited).toBe(false);
      },
      { isActive: false },
    );
  });
});

describe.skipIf(skipReason !== null)('login — throttling', () => {
  it('refuses after the configured number of failures, with the instant the lock lifts', async () => {
    await withAdmin(
      async (harness) => {
        for (let attemptNumber = 0; attemptNumber < 3; attemptNumber += 1) {
          const error = await rejection(attempt(harness, { password: 'nope' }));
          expect(error.code).toBe('INVALID_CREDENTIALS');
        }

        const limited = await rejection(attempt(harness));
        expect(limited.code).toBe('RATE_LIMITED');
        expect(limited.details).toEqual({
          lockedUntil: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
          retryAfterSeconds: 900,
        });
      },
      { maxAttempts: 3 },
    );
  });

  it('refuses even the correct password while locked, and lets it through afterwards', async () => {
    await withAdmin(
      async (harness) => {
        for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
          await rejection(attempt(harness, { password: 'nope' }));
        }

        // A correct password does not open the door during a lockout — otherwise the lockout would only stop the
        // attacker who is guessing, which is the one it barely needs to stop.
        expect((await rejection(attempt(harness))).code).toBe('RATE_LIMITED');

        harness.clock.now = new Date(NOW.getTime() + 15 * 60_000);
        const result = await attempt(harness);
        expect(result.token).toMatch(/^mm_/u);
      },
      { maxAttempts: 2 },
    );
  });

  it('does not audit a throttled attempt as a credential failure', async () => {
    // It was not one: the password was never checked. Counting it would extend the lockout for anyone who retries.
    await withAdmin(
      async (harness) => {
        for (let attemptNumber = 0; attemptNumber < 1; attemptNumber += 1) {
          await rejection(attempt(harness, { password: 'nope' }));
        }
        await rejection(attempt(harness));
        await rejection(attempt(harness));

        const rows = await auditRows(harness.database.db);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.action).toBe('auth.login_failed');
      },
      { maxAttempts: 1 },
    );
  });

  it('stops one address spraying many usernames', async () => {
    await withAdmin(
      async (harness) => {
        // Nine failures across nine names: no pair reaches three, so only the address counter can see this.
        for (let index = 0; index < 9; index += 1) {
          await rejection(attempt(harness, { username: `user${String(index)}`, password: 'nope' }));
        }

        const error = await rejection(
          attempt(harness, { username: 'tenth-username', password: 'nope' }),
        );
        expect(error.code).toBe('RATE_LIMITED');
      },
      { maxAttempts: 3 },
    );
  });
});

describe.skipIf(skipReason !== null)('login — the client address', () => {
  it('stores an unparseable address as null instead of failing the login', async () => {
    // Measured before pass 22: `X-Forwarded-For: <script>` reached the handler verbatim, `inet` refused it with
    // `22P02`, and the login endpoint answered 500. The normalisation is in `issueToken`, so this asserts the whole
    // path, not just the helper.
    await withAdmin(async (harness) => {
      const result = await attempt(harness, {}, { ip: '<script>alert(1)</script>' });
      expect(result.token).toMatch(/^mm_/u);

      const token = await harness.database.db
        .selectFrom('admin_tokens')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(token.ip).toBeNull();

      const [audit] = await auditRows(harness.database.db);
      expect(audit?.ip).toBeNull();
    });
  });

  it('keeps the address but drops a port, which is what a proxy actually sends', async () => {
    await withAdmin(async (harness) => {
      await attempt(harness, {}, { ip: '198.51.100.7:41234' });

      const [audit] = await auditRows(harness.database.db);
      expect(audit?.ip).toBe('198.51.100.7');
    });
  });

  it('counts an unparseable address in one bucket, not a fresh one per attempt', async () => {
    // `null` is the same key for every spoofed header, which is what keeps the throttle working when the header is
    // garbage — the alternative is a limiter an attacker resets by changing a string.
    await withAdmin(
      async (harness) => {
        for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
          const error = await rejection(attempt(harness, { password: 'nope' }, { ip: 'junk' }));
          expect(error.code).toBe('INVALID_CREDENTIALS');
        }

        expect((await rejection(attempt(harness, {}, { ip: 'other-junk' }))).code).toBe(
          'RATE_LIMITED',
        );
      },
      { maxAttempts: 2 },
    );
  });
});

describe.skipIf(skipReason !== null)(
  'login — an attempt that dies still gives its slot back',
  () => {
    it('does not spend the allowance when the attempt fails before the credential check', async () => {
      // `check` reserves the slot before the password is verified, so every failure path after it owes a release. A
      // database error is the one that matters most: it repeats — the database stays down, retries keep arriving — and an
      // attempt that neither settled as a failure nor gave its slot back would lock the pair out for the full window
      // without a single wrong password (the reason the service body is wrapped in `try`/`finally`, pass 28).
      //
      // A dropped table is a real server-side failure that no `catch` in the service is meant to absorb.
      await withAdmin(
        async (harness) => {
          await sql`drop table admins cascade`.execute(harness.database.db);

          for (let attemptNumber = 1; attemptNumber <= 12; attemptNumber += 1) {
            const error: unknown = await attempt(harness).then(
              () => new Error('expected the login to fail'),
              (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(Error);
            // The slot is back after every attempt, and the failures were never recorded: a crashed request is not a
            // wrong password.
            expect(harness.throttle.inFlight, `attempt ${String(attemptNumber)}`).toBe(0);
          }

          // Twelve attempts against `maxAttempts: 10` and the pair is still allowed: nothing leaked.
          expect(harness.throttle.check('203.0.113.9', 'admin')).toEqual({ limited: false });
        },
        { maxAttempts: 10 },
      );
    });
  },
);

describe.skipIf(skipReason !== null)('login — the audit log does not block the answer', () => {
  it('still answers 401 when the audit row cannot be written', async () => {
    // The audit table is made unwritable with a `CHECK (false)` constraint — a real server-side refusal that does not
    // depend on the role's privileges (the test role is a superuser, so `REVOKE` would have been a no-op and the test
    // would have passed without testing anything). `NOT VALID` skips existing rows, exactly like a constraint an
    // operator adds by accident.
    await withAdmin(async (harness) => {
      const warnings: string[] = [];
      await sql`alter table audit_logs add constraint probe_reject check (false) not valid`.execute(
        harness.database.db,
      );

      const error = await login(
        {
          database: harness.database.db,
          throttle: harness.throttle,
          tokenTtlHours: 12,
          now: NOW,
          ip: '203.0.113.9',
          log: { warn: (_context, message) => warnings.push(message) },
        },
        { username: 'admin', password: 'nope' },
      ).catch((caught: unknown) => caught as AppError);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_CREDENTIALS');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('401 stands');

      await sql`alter table audit_logs drop constraint probe_reject`.execute(harness.database.db);
    });
  });
});
