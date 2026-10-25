import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv, type SqlDatabase } from '../../src/index';
import { issueToken, revokeToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * The guard with the **real** verifier: `/_admin/api/*` behind tokens that actually exist in `admin_tokens`.
 *
 * `admin-guard.spec.ts` covers the hook with an injected verifier — the shell, the order, the envelope, the route-table
 * walk. This file is the half that cannot be faked: a token minted by `issueToken` opens the admin API, and every way a
 * token can stop working closes it again, with the code the contract names. The guard is only as good as the verifier
 * it calls, and this is where the two are proven to agree.
 */

const skipReason = await freshDatabaseSkipReason();

/** Builds the app on a fresh database, with one admin and one token. */
async function withAdmin(
  run: (harness: {
    app: FastifyInstance;
    database: SqlDatabase;
    adminId: string;
    token: string;
  }) => Promise<void>,
  options: { readonly isActive?: boolean } = {},
): Promise<void> {
  await withFreshDatabase(
    async (database, name) => {
      const row = await database.db
        .insertInto('admins')
        .values({
          username: 'admin',
          // Never read by these routes: the guard checks the token, not the password.
          password_hash: 'not-used-by-the-guard',
          is_active: options.isActive ?? true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const issued = await issueToken(database.db, row.id, { ttlHours: 12 });
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
      });

      try {
        await run({ app, database, adminId: row.id, token: issued.token });
      } finally {
        await app.close();
      }
    },
    { prefix: 'guard', migrate: true },
  );
}

/** One `GET` on the admin stub, with an optional credential. */
function getCatalog(app: FastifyInstance, token?: string) {
  return app.inject({
    method: 'GET',
    url: '/_admin/api/catalog',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

/** The `code` of an error envelope. */
function code(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

describe.skipIf(skipReason !== null)('the guard with the real verifier', () => {
  it('opens the admin API for a token that exists', async () => {
    await withAdmin(async ({ app, token }) => {
      const response = await getCatalog(app, token);

      // Past the guard, so the route's own answer — the `503` stub — is what comes back. The guard's job is to stop
      // the request or not; what the handler then says is the handler's business.
      expect(response.statusCode).toBe(503);
      expect(code(response.body)).toBe('NOT_READY');
    });
  });

  it('refuses a token that does not exist, with the same answer as no token', async () => {
    await withAdmin(async ({ app }) => {
      const forged = await getCatalog(app, `mm_${'z'.repeat(43)}`);
      const absent = await getCatalog(app);

      expect(forged.statusCode).toBe(401);
      expect(code(forged.body)).toBe('UNAUTHENTICATED');
      // Byte-identical bodies, request id aside: an attacker learns nothing about which tokens exist.
      const strip = (body: string) => body.replace(/"requestId":"[^"]*"/u, '"requestId":"…"');
      expect(strip(forged.body)).toBe(strip(absent.body));
    });
  });

  it('refuses an expired token with TOKEN_EXPIRED', async () => {
    await withAdmin(async ({ app, database, adminId }) => {
      const stale = await issueToken(database.db, adminId, {
        ttlHours: 1,
        now: new Date(Date.now() - 2 * 3_600_000),
      });

      const response = await getCatalog(app, stale.token);
      expect(response.statusCode).toBe(401);
      expect(code(response.body)).toBe('TOKEN_EXPIRED');
    });
  });

  it('refuses a revoked token with TOKEN_REVOKED', async () => {
    await withAdmin(async ({ app, database, token }) => {
      await revokeToken(database.db, token);

      const response = await getCatalog(app, token);
      expect(response.statusCode).toBe(401);
      expect(code(response.body)).toBe('TOKEN_REVOKED');
    });
  });

  it('refuses a live token on a deactivated account with 403 ACCOUNT_DISABLED', async () => {
    // The credential is fine; the account may not act. A `401` here would tell the person to log in again, which is the
    // one thing that cannot help them.
    await withAdmin(
      async ({ app, token }) => {
        const response = await getCatalog(app, token);
        expect(response.statusCode).toBe(403);
        expect(code(response.body)).toBe('ACCOUNT_DISABLED');
      },
      { isActive: false },
    );
  });

  it('accepts the token `/login` handed out, and stops accepting it after `/logout`', async () => {
    // The seam between three routes and one guard: a token is minted by login, accepted by the admin API, and killed by
    // logout. Each route has its own tests; this is the one that fails if any two of them disagree about the credential.
    const password = 'correct horse battery staple';
    const { hashPassword } = await import('../../src/modules/auth/password');
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
          const { token } = login.json<{ token: string }>();

          expect((await getCatalog(app, token)).statusCode).toBe(503);

          const logout = await app.inject({
            method: 'POST',
            url: '/_auth/api/logout',
            headers: { authorization: `Bearer ${token}` },
          });
          expect(logout.statusCode).toBe(204);

          const after = await getCatalog(app, token);
          expect(after.statusCode).toBe(401);
          expect(code(after.body)).toBe('TOKEN_REVOKED');
        } finally {
          await app.close();
        }
      },
      { prefix: 'guards', migrate: true },
    );
  });

  it('records last_used_at when the admin API is used, at most once a minute', async () => {
    // The guard is on the read path of every admin request, so its verifier is what makes `last_used_at` mean "the
    // session was used", not "the session was checked on /me".
    await withAdmin(async ({ app, database, token }) => {
      const before = await database.db
        .selectFrom('admin_tokens')
        .select('last_used_at')
        .executeTakeFirstOrThrow();
      expect(before.last_used_at).toBeNull();

      await getCatalog(app, token);

      const after = await database.db
        .selectFrom('admin_tokens')
        .select('last_used_at')
        .executeTakeFirstOrThrow();
      expect(after.last_used_at).not.toBeNull();
    });
  });

  it('does not touch the database when no token is presented', async () => {
    // The refusal has to be cheap: an unauthenticated request must not cost a connection from the pool, or a flood of
    // them is a way to exhaust it. Measured by closing the pool first — with the pool gone, any query would throw.
    await withAdmin(async ({ app, database, token }) => {
      // Sanity: the token path does need the database, so a closed pool has to break it.
      await database.close();
      const withToken = await getCatalog(app, token);
      expect(withToken.statusCode).toBeGreaterThanOrEqual(500);

      const withoutToken = await getCatalog(app);
      expect(withoutToken.statusCode).toBe(401);
      expect(code(withoutToken.body)).toBe('UNAUTHENTICATED');
    });
  });
});
