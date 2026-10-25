import { LoginResponseSchema, MeResponseSchema } from '@mapirror/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv, type SqlDatabase } from '../../src/index';
import { hashPassword } from '../../src/modules/auth/password';
import { issueToken, revokeToken, verifyToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * `GET /_auth/api/me` and `POST /_auth/api/logout` (`P1-AUTH-04`), through the real pipeline and a real database.
 *
 * The acceptance criterion is one sentence — *"logout revokes only presented token"* — and it is the reason for the
 * two-token cases below: a logout that revokes **all** of an admin's tokens passes every single-token test in the
 * suite and signs the person out of their phone when they close a tab. The rest of the file is the four verdicts a
 * bearer token can produce, each of which the contract names separately.
 *
 * `expiresAt`/`lastUsedAt` are the token's facts, not the account's: a token minted one minute ago on a second device
 * has its own clock, and the SPA renders *that*.
 */

const skipReason = await freshDatabaseSkipReason();

/**
 * The real clock, read once.
 *
 * **Not** a fixed instant: these routes verify against the system clock and take no injectable `now`, so a token minted
 * at a hard-coded `2026-10-25T09:00Z` would start the suite green and expire twelve hours later — a test that fails on
 * the day after it was written, in CI, for a reason that has nothing to do with the change under review. Expiry is
 * produced by issuing a token in the past instead: relative, and still deterministic.
 */
const NOW = new Date();

/** What a case gets: the app, the database and one live token for `admin`. */
interface Harness {
  readonly app: FastifyInstance;
  readonly database: SqlDatabase;
  readonly adminId: string;
  readonly token: string;
  /** When the harness's token stops working, as `issueToken` computed it. */
  readonly expiresAt: string;
}

/**
 * Builds the app on a fresh database with one admin and one token.
 *
 * @param run - The case body.
 * @param options - `isActive: false` creates a deactivated account (whose token is still live — that is the point).
 */
async function withSession(
  run: (harness: Harness) => Promise<void>,
  options: { readonly isActive?: boolean } = {},
): Promise<void> {
  await withFreshDatabase(
    async (database, name) => {
      const row = await database.db
        .insertInto('admins')
        .values({
          username: 'admin',
          // A real Argon2id digest is not needed here: these routes never look at the password, and hashing costs 74 ms
          // per case. The column is only ever read by the login flow, which has its own tests.
          password_hash: 'not-used-by-these-routes',
          is_active: options.isActive ?? true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const issued = await issueToken(database.db, row.id, { ttlHours: 12, now: NOW });
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
      });

      try {
        await run({
          app,
          database,
          adminId: row.id,
          token: issued.token,
          expiresAt: issued.expiresAt.toISOString(),
        });
      } finally {
        await app.close();
      }
    },
    { prefix: 'session', migrate: true },
  );
}

/** `GET /_auth/api/me` with an arbitrary `Authorization` header. */
function getMe(app: FastifyInstance, authorization?: string) {
  return app.inject({
    method: 'GET',
    url: '/_auth/api/me',
    headers: authorization === undefined ? {} : { authorization },
  });
}

/** `POST /_auth/api/logout` with an arbitrary `Authorization` header. */
function postLogout(app: FastifyInstance, authorization?: string) {
  return app.inject({
    method: 'POST',
    url: '/_auth/api/logout',
    headers: authorization === undefined ? {} : { authorization },
    remoteAddress: '203.0.113.9',
  });
}

/** The `code` of an error envelope, typed. */
function errorCode(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

/** One token row by id. */
async function tokenRow(database: SqlDatabase, id: string) {
  return database.db
    .selectFrom('admin_tokens')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

describe.skipIf(skipReason !== null)('GET /_auth/api/me', () => {
  it('answers the documented body, parsed by the contract schema', async () => {
    await withSession(async ({ app, adminId, token, expiresAt }) => {
      const response = await getMe(app, `Bearer ${token}`);

      expect(response.statusCode).toBe(200);
      // Parsed by the schema the SPA will use, so the two cannot disagree about the shape.
      const body = MeResponseSchema.parse(response.json());
      expect(body.admin).toEqual({ id: adminId, username: 'admin' });
      // The instant `issueToken` computed, not one recomputed here: a test that recomputes the TTL checks its own
      // arithmetic rather than the route's.
      expect(body.expiresAt).toBe(expiresAt);
      // The first request with a token records its use, and the answer reports what the row now holds.
      expect(body.lastUsedAt).not.toBeNull();
    });
  });

  it('reports the same lastUsedAt the database holds', async () => {
    await withSession(async ({ app, database, token }) => {
      const response = await getMe(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(200);

      const row = await database.db
        .selectFrom('admin_tokens')
        .select(['last_used_at'])
        .executeTakeFirstOrThrow();
      // Both sides are ISO strings at millisecond precision: the column is `timestamptz`, the body is a serialised
      // `Date`, and comparing them as strings is the only comparison that proves the API reports the stored value
      // rather than the clock at serialisation time.
      expect(MeResponseSchema.parse(response.json()).lastUsedAt).toBe(
        row.last_used_at?.toISOString(),
      );
    });
  });

  it('reports the recorded instant, not the clock, when the write is throttled', async () => {
    // `last_used_at` is written at most once a minute (`03-data-model.md` §2.2), so the second call reads the row rather
    // than touching it. If the answer were recomputed from the clock, a sessions screen would show a session being used
    // every second — and it would be describing a write that never happened.
    await withSession(async ({ app, token }) => {
      const first = MeResponseSchema.parse((await getMe(app, `Bearer ${token}`)).json());
      const second = MeResponseSchema.parse((await getMe(app, `Bearer ${token}`)).json());

      expect(first.lastUsedAt).not.toBeNull();
      expect(second.lastUsedAt).toBe(first.lastUsedAt);
    });
  });

  it('is not cacheable', async () => {
    await withSession(async ({ app, token }) => {
      const response = await getMe(app, `Bearer ${token}`);
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  it('accepts a lowercase scheme', async () => {
    await withSession(async ({ app, token }) => {
      expect((await getMe(app, `bearer ${token}`)).statusCode).toBe(200);
    });
  });

  it('answers 401 UNAUTHENTICATED without a header, and with a header that is not a bearer credential', async () => {
    await withSession(async ({ app }) => {
      for (const header of [undefined, '', 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer not-a-token']) {
        const response = await getMe(app, header);
        expect(response.statusCode, String(header)).toBe(401);
        expect(errorCode(response.body), String(header)).toBe('UNAUTHENTICATED');
      }
    });
  });

  it('answers 401 UNAUTHENTICATED for a well-formed token that does not exist', async () => {
    await withSession(async ({ app }) => {
      // Same shape as a real token (43 base64url characters after the marker), so it reaches the database query rather
      // than being rejected by the format check — the case where "unknown" has to look like "wrong".
      const response = await getMe(app, `Bearer mm_${'z'.repeat(43)}`);
      expect(response.statusCode).toBe(401);
      expect(errorCode(response.body)).toBe('UNAUTHENTICATED');
    });
  });

  it('answers 401 TOKEN_EXPIRED, distinctly from UNAUTHENTICATED', async () => {
    await withSession(async ({ app, database, adminId }) => {
      // Issued two hours ago with a one-hour TTL: expired without waiting, and without a clock the route cannot see.
      const stale = await issueToken(database.db, adminId, {
        ttlHours: 1,
        now: new Date(Date.now() - 2 * 3_600_000),
      });

      const response = await getMe(app, `Bearer ${stale.token}`);
      expect(response.statusCode).toBe(401);
      expect(errorCode(response.body)).toBe('TOKEN_EXPIRED');
    });
  });

  it('answers 401 TOKEN_REVOKED for a token that was signed out', async () => {
    await withSession(async ({ app, database, token }) => {
      await revokeToken(database.db, token, { now: NOW });

      const response = await getMe(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(401);
      expect(errorCode(response.body)).toBe('TOKEN_REVOKED');
    });
  });

  it('answers 403 ACCOUNT_DISABLED when the account is deactivated, token notwithstanding', async () => {
    // A live token on a deactivated account is a 403, not a 401: the credential is fine, the account may not act. The
    // SPA shows a different message for it, which is why the distinction is in the contract at all.
    await withSession(
      async ({ app, token }) => {
        const response = await getMe(app, `Bearer ${token}`);
        expect(response.statusCode).toBe(403);
        expect(errorCode(response.body)).toBe('ACCOUNT_DISABLED');
      },
      { isActive: false },
    );
  });

  it('does not record use when the answer is a refusal', async () => {
    await withSession(async ({ app, database }) => {
      await getMe(app, `Bearer mm_${'q'.repeat(43)}`);

      const rows = await database.db.selectFrom('admin_tokens').select('last_used_at').execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.last_used_at).toBeNull();
    });
  });
});

describe.skipIf(skipReason !== null)('POST /_auth/api/logout', () => {
  it('answers 204 with no body and revokes the presented token', async () => {
    await withSession(async ({ app, database, token }) => {
      const response = await postLogout(app, `Bearer ${token}`);

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');

      const verdict = await verifyToken(database.db, token);
      expect(verdict.status).toBe('revoked');
    });
  });

  it('revokes only the presented token', async () => {
    // The acceptance criterion, and the bug it exists to prevent: a logout that clears every session signs the person
    // out of the desktop when they close a tab on their phone.
    await withSession(async ({ app, database, adminId, token }) => {
      const other = await issueToken(database.db, adminId, { ttlHours: 12, now: NOW });

      expect((await postLogout(app, `Bearer ${token}`)).statusCode).toBe(204);

      expect((await verifyToken(database.db, token)).status).toBe('revoked');
      expect((await verifyToken(database.db, other.token)).status).toBe('valid');
      // ...and the other session still works over HTTP, not just in the database.
      expect((await getMe(app, `Bearer ${other.token}`)).statusCode).toBe(200);
    });
  });

  it('writes one auth.logout audit row naming the token, never the token itself', async () => {
    await withSession(async ({ app, database, adminId, token }) => {
      const issued = await database.db
        .selectFrom('admin_tokens')
        .select('id')
        .executeTakeFirstOrThrow();

      await postLogout(app, `Bearer ${token}`);

      const rows = await database.db.selectFrom('audit_logs').selectAll().execute();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.action).toBe('auth.logout');
      expect(row?.actor_id).toBe(adminId);
      expect(row?.actor_name).toBe('admin');
      expect(row?.target_type).toBe('admin_token');
      expect(row?.target_id).toBe(issued.id);
      expect(row?.ip).toBe('203.0.113.9');
      // The credential must appear nowhere in the row: not in the target, not in metadata.
      expect(JSON.stringify(row)).not.toContain(token);
    });
  });

  it('answers 401 TOKEN_REVOKED when the token was already signed out, and writes no second row', async () => {
    // Revocation itself is idempotent at the database level (`revoked_at` keeps its first value). The *HTTP* answer for
    // an already-revoked token is `401 TOKEN_REVOKED`, because the token is no longer a credential — pretending the
    // second logout succeeded would tell the caller nothing about whether the first one did.
    await withSession(async ({ app, database, token }) => {
      expect((await postLogout(app, `Bearer ${token}`)).statusCode).toBe(204);
      const first = await database.db
        .selectFrom('admin_tokens')
        .select('revoked_at')
        .executeTakeFirstOrThrow();

      const second = await postLogout(app, `Bearer ${token}`);
      expect(second.statusCode).toBe(401);
      expect(errorCode(second.body)).toBe('TOKEN_REVOKED');

      const rows = await database.db.selectFrom('audit_logs').select('action').execute();
      expect(rows).toHaveLength(1);

      // The original revocation instant is untouched: a later request cannot rewrite when the session ended.
      const after = await database.db
        .selectFrom('admin_tokens')
        .select('revoked_at')
        .executeTakeFirstOrThrow();
      expect(after.revoked_at?.toISOString()).toBe(first.revoked_at?.toISOString());
    });
  });

  it('ends one session once, even when two logouts arrive together', async () => {
    // The race a probe found: both requests verify as valid before either commits, so only the revocation itself can
    // say which one ended the session. Answering `204` twice would also write two `auth.logout` rows for one session,
    // and an audit trail that reports a session ending twice is worse than no audit trail.
    await withSession(async ({ app, database, token }) => {
      const [first, second] = await Promise.all([
        postLogout(app, `Bearer ${token}`),
        postLogout(app, `Bearer ${token}`),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([204, 401]);
      const refused = first.statusCode === 401 ? first : second;
      expect(errorCode(refused.body)).toBe('TOKEN_REVOKED');

      const audits = await database.db.selectFrom('audit_logs').select('action').execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe('auth.logout');
    });
  });

  it('stores a junk client address as NULL, and still signs the session out', async () => {
    // The pass-22 lesson, re-applied: `request.ip` is a header when a proxy is trusted, and `inet` refuses
    // `not-an-ip` with `22P02`. An audit row is a write path like any other, so the address is normalised before it
    // reaches the column — and losing an address is cheaper than a 500 on the logout route.
    await withSession(async ({ app, database, token }) => {
      const response = await app.inject({
        method: 'POST',
        url: '/_auth/api/logout',
        headers: { authorization: `Bearer ${token}` },
        remoteAddress: 'not-an-ip',
      });

      expect(response.statusCode).toBe(204);
      const audit = await database.db
        .selectFrom('audit_logs')
        .select('ip')
        .executeTakeFirstOrThrow();
      expect(audit.ip).toBeNull();
    });
  });

  it('requires a bearer token', async () => {
    await withSession(async ({ app }) => {
      for (const header of [undefined, 'Basic dXNlcjpwYXNz', 'Bearer']) {
        const response = await postLogout(app, header);
        expect(response.statusCode, String(header)).toBe(401);
        expect(errorCode(response.body), String(header)).toBe('UNAUTHENTICATED');
      }
    });
  });

  it('refuses a deactivated account with 403, without revoking anything', async () => {
    await withSession(
      async ({ app, database, token }) => {
        const response = await postLogout(app, `Bearer ${token}`);
        expect(response.statusCode).toBe(403);
        expect(errorCode(response.body)).toBe('ACCOUNT_DISABLED');

        // Not revoked: the session was refused, not ended. An operator who re-enables the account finds it as it was.
        expect((await tokenRow(database, await onlyTokenId(database))).revoked_at).toBeNull();
      },
      { isActive: false },
    );
  });

  it('revokes nothing when the audit row cannot be written', async () => {
    // Revocation and audit commit together, so a refusal here leaves the session usable and says so: the alternative is
    // a session that ended with no record of ending, which is exactly what the audit log exists to prevent.
    await withSession(async ({ app, database, token }) => {
      // `not valid` applies to new rows only, and the table is empty — a `REVOKE INSERT` would be a no-op for the test
      // role, which is a superuser.
      await sql`alter table audit_logs add constraint logout_probe check (false) not valid`.execute(
        database.db,
      );

      try {
        const response = await postLogout(app, `Bearer ${token}`);
        expect(response.statusCode).toBe(500);
        expect((await verifyToken(database.db, token)).status).toBe('valid');
      } finally {
        await sql`alter table audit_logs drop constraint logout_probe`.execute(database.db);
      }
    });
  });
});

describe.skipIf(skipReason !== null)('the seam with login', () => {
  it('accepts the token login just handed out, and invalidates it on logout', async () => {
    // Each route has its own tests; this is the one that would catch the two disagreeing — a token whose format login
    // mints and the bearer parser refuses, or a TTL the session route reads differently from the one login wrote.
    // Two routes, one credential, end to end.
    const password = 'correct horse battery staple';
    const passwordHash = await hashPassword(password);

    await withFreshDatabase(
      async (database, name) => {
        await database.db
          .insertInto('admins')
          .values({ username: 'admin', password_hash: passwordHash })
          .execute();
        const app = await buildApp({
          config: parseEnv({ DATABASE_URL: dsnFor(name) }),
          database,
        });

        try {
          const login = await app.inject({
            method: 'POST',
            url: '/_auth/api/login',
            payload: { username: 'admin', password },
          });
          expect(login.statusCode).toBe(200);
          const { token } = LoginResponseSchema.parse(login.json());

          const me = await getMe(app, `Bearer ${token}`);
          expect(me.statusCode).toBe(200);
          // The TTL the login response promised is the one `/me` reports: two routes, one row.
          expect(MeResponseSchema.parse(me.json()).expiresAt).toBe(
            LoginResponseSchema.parse(login.json()).expiresAt,
          );

          expect((await postLogout(app, `Bearer ${token}`)).statusCode).toBe(204);
          // ...and the token `/me` accepted a moment ago is now refused, by the same code path.
          const after = await getMe(app, `Bearer ${token}`);
          expect(after.statusCode).toBe(401);
          expect(errorCode(after.body)).toBe('TOKEN_REVOKED');
        } finally {
          await app.close();
        }
      },
      { prefix: 'seam', migrate: true },
    );
  });
});

describe.skipIf(skipReason !== null)('the auth namespace stays narrow', () => {
  it('does not serve /me or /logout at another method', async () => {
    await withSession(async ({ app, token }) => {
      for (const [method, url] of [
        ['POST', '/_auth/api/me'],
        ['GET', '/_auth/api/logout'],
        ['PUT', '/_auth/api/logout'],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    });
  });
});

/** The single token id in the database, for a harness whose token the case no longer has. */
async function onlyTokenId(database: SqlDatabase): Promise<string> {
  const row = await database.db.selectFrom('admin_tokens').select('id').executeTakeFirstOrThrow();
  return row.id;
}
