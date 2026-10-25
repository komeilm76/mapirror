import { LoginRateLimitDetailsSchema, LoginResponseSchema } from '@mapirror/shared';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv, type SqlDatabase } from '../../src/index';
import { hashPassword } from '../../src/modules/auth/password';
import { LoginThrottle } from '../../src/modules/auth/login-throttle';
import { APP_LOGIN_PASSWORD_MAX } from '../helpers/contract-limits';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * `POST /_auth/api/login` as a **route**, through the real pipeline: validation, the error envelope, the headers, and
 * the `429` that carries both `Retry-After` and `details`.
 *
 * The service-level behaviour (order of checks, audit rows, timing) is covered in `tests/integration/login.spec.ts`;
 * this file is about the HTTP surface, which is where the contract lives. It needs a real database because the route
 * reaches one — the stub in `tests/helpers/test-app.ts` would answer `500` by design.
 */

const skipReason = await freshDatabaseSkipReason();

/** The error body this route can return: `code` and `message`, plus the id stamped by the envelope. */
interface LoginErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly details?: unknown;
}

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

/** Builds the app on a real database, with a throttle the test controls. */
async function withApp(
  run: (context: {
    app: FastifyInstance;
    clock: { now: Date };
    database: SqlDatabase;
  }) => Promise<void>,
  options: { readonly isActive?: boolean; readonly maxAttempts?: number } = {},
): Promise<void> {
  await withFreshDatabase(
    async (database: SqlDatabase, name) => {
      await database.db
        .insertInto('admins')
        .values({
          username: 'admin',
          password_hash: PASSWORD_HASH,
          is_active: options.isActive ?? true,
        })
        .execute();

      const clock = { now: new Date('2026-10-25T09:00:00.000Z') };
      const config = parseEnv({ DATABASE_URL: dsnFor(name) });
      const app = await buildApp({
        config,
        database,
        loginThrottle: new LoginThrottle({
          maxAttempts: options.maxAttempts ?? 10,
          windowMs: 15 * 60_000,
          now: () => clock.now,
        }),
      });

      try {
        await run({ app, clock, database });
      } finally {
        await app.close();
      }
    },
    { prefix: 'route', migrate: true },
  );
}

/** Posts a login body from a given address. */
function post(
  app: FastifyInstance,
  payload: unknown,
  options: { ip?: string; headers?: Record<string, string> } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/_auth/api/login',
    headers: { 'content-type': 'application/json', ...options.headers },
    payload: payload as Record<string, unknown>,
    remoteAddress: options.ip ?? '203.0.113.9',
  });
}

describe.skipIf(skipReason !== null)('POST /_auth/api/login', () => {
  it('answers 200 with the documented body, and forbids caching it', async () => {
    await withApp(async ({ app }) => {
      const response = await post(app, { username: 'admin', password: PASSWORD });

      expect(response.statusCode).toBe(200);
      const body = LoginResponseSchema.parse(response.json());
      expect(body.admin.id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(body.admin.username).toBe('admin');
      expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

      // A login response contains a bearer token. A proxy or browser that cached it would hand a credential to the
      // next visitor, so the absence of a caching header is not good enough.
      expect(response.headers['cache-control']).toBe('no-store');
      // Bearer only: no cookie is set, so there is no ambient credential a CSRF or a shared machine could reuse.
      expect(response.headers['set-cookie']).toBeUndefined();
      // And the token never appears in a header, only in the body the client asked for.
      expect(JSON.stringify(response.headers)).not.toContain(body.token);
    });
  });

  it('answers 400 VALIDATION_ERROR with issues for a body that cannot be parsed', async () => {
    await withApp(async ({ app }) => {
      const cases: readonly (readonly [unknown, string])[] = [
        [{}, 'password'], // missing both
        [{ username: 'admin' }, 'password'],
        [{ password: PASSWORD }, 'username'],
        [{ username: '', password: PASSWORD }, 'username'],
        [{ username: 'x'.repeat(65), password: PASSWORD }, 'username'],
        [{ username: 'admin', password: '' }, 'password'],
        [{ username: 'admin', password: 'x'.repeat(APP_LOGIN_PASSWORD_MAX + 1) }, 'password'],
        [{ username: 42, password: PASSWORD }, 'username'],
      ];

      for (const [payload, field] of cases) {
        const response = await post(app, payload);
        const body = response.json<{
          error: { code: string; details?: { issues: { path: string }[] } };
        }>();

        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(body.error.code).toBe('VALIDATION_ERROR');
        // The field is named, which is what a form needs to mark the right input.
        expect(body.error.details?.issues.map((issue) => issue.path)).toContain(field);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  it('accepts a 256-unit password at the boundary the login schema documents', async () => {
    // The ceiling is UTF-16 code units (`LOGIN_PASSWORD_MAX`), and a password at exactly the limit must reach the
    // handler — here it fails the *credential* check, which proves validation let it through.
    await withApp(async ({ app }) => {
      const response = await post(app, { username: 'admin', password: 'x'.repeat(256) });

      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  it('answers a generic 401 for both a wrong password and an unknown username', async () => {
    await withApp(async ({ app }) => {
      const wrongPassword = await post(app, { username: 'admin', password: 'nope' });
      const unknownUser = await post(app, { username: 'ghost', password: 'nope' });

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownUser.statusCode).toBe(401);

      const first = wrongPassword.json<{ error: LoginErrorBody }>().error;
      const second = unknownUser.json<{ error: LoginErrorBody }>().error;

      expect(first.code).toBe('INVALID_CREDENTIALS');
      expect(second.code).toBe('INVALID_CREDENTIALS');
      expect(second.message).toBe(first.message);
      // The envelope still identifies the request, so a screenshot can be traced to a log line.
      expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    });
  });

  it('answers 403 ACCOUNT_DISABLED for a deactivated account with the right password', async () => {
    await withApp(
      async ({ app }) => {
        const response = await post(app, { username: 'admin', password: PASSWORD });

        expect(response.statusCode).toBe(403);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('ACCOUNT_DISABLED');
      },
      { isActive: false },
    );
  });

  it('answers 429 with Retry-After and the same instant in details', async () => {
    await withApp(
      async ({ app, clock }) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect((await post(app, { username: 'admin', password: 'nope' })).statusCode).toBe(401);
        }

        const response = await post(app, { username: 'admin', password: PASSWORD });
        const body = response.json<{ error: { code: string; details: unknown } }>();

        expect(response.statusCode).toBe(429);
        expect(body.error.code).toBe('RATE_LIMITED');

        // The header is what an HTTP client honours; the body field is what the SPA shows to a person. They describe
        // the same instant, and the schema both applications share is the assertion.
        const details = LoginRateLimitDetailsSchema.parse(body.error.details);
        expect(response.headers['retry-after']).toBe(String(details.retryAfterSeconds));
        expect(details.retryAfterSeconds).toBe(900);
        // The instant comes from the throttle's own clock (injected here), not from `Date.now()` — which is the point of
        // injecting it: the assertion is about arithmetic, not about how fast the suite ran.
        expect(details.lockedUntil).toBe(new Date(clock.now.getTime() + 15 * 60_000).toISOString());
      },
      { maxAttempts: 2 },
    );
  });

  it('does not set Retry-After on any other answer', async () => {
    // A `Retry-After` on a 401 would tell a client to wait, which is a lie: the next attempt is allowed immediately.
    await withApp(async ({ app }) => {
      expect(
        (await post(app, { username: 'admin', password: 'nope' })).headers['retry-after'],
      ).toBeUndefined();
      expect(
        (await post(app, { username: 'admin', password: PASSWORD })).headers['retry-after'],
      ).toBeUndefined();
      expect((await post(app, {})).headers['retry-after']).toBeUndefined();
    });
  });

  it('counts failures per address, so one client cannot lock out another', async () => {
    await withApp(
      async ({ app }) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await post(app, { username: 'admin', password: 'nope' }, { ip: '198.51.100.7' });
        }

        // The fumbling client is locked out...
        expect(
          (await post(app, { username: 'admin', password: PASSWORD }, { ip: '198.51.100.7' }))
            .statusCode,
        ).toBe(429);
        // ...and a different address is not, which is what keeps a shared NAT from becoming a denial of service.
        expect(
          (await post(app, { username: 'admin', password: PASSWORD }, { ip: '203.0.113.9' }))
            .statusCode,
        ).toBe(200);
      },
      { maxAttempts: 2 },
    );
  });

  it('is still only POST, and only under its prefix', async () => {
    await withApp(async ({ app }) => {
      for (const [method, url] of [
        ['GET', '/_auth/api/login'],
        ['PUT', '/_auth/api/login'],
        ['POST', '/_auth/api/login/extra'],
        ['POST', '/_auth/login'],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    });
  });

  it('stores a NULL user agent when the client sends none', async () => {
    // `request.headers['user-agent']` is `undefined` for a client that sends none, and the row must hold NULL rather
    // than the string `"undefined"` — which is what a careless `String(...)` would write, and which no query for
    // "requests from an unknown client" would ever find again.
    await withApp(async ({ app, database }) => {
      // `inject` fills in `lightMyRequest` unless the header is explicitly `undefined`, so the ordinary helper cannot
      // express "no user agent" — this is the one place the request has to be built by hand.
      const response = await app.inject({
        method: 'POST',
        url: '/_auth/api/login',
        headers: { 'content-type': 'application/json', 'user-agent': undefined },
        payload: { username: 'admin', password: PASSWORD },
        remoteAddress: '203.0.113.9',
      });
      expect(response.statusCode).toBe(200);

      const token = await database.db
        .selectFrom('admin_tokens')
        .select('user_agent')
        .executeTakeFirstOrThrow();
      expect(token.user_agent).toBeNull();
    });
  });

  it('locks out on the throttle the configuration describes, with no test double involved', async () => {
    // Every other case here injects a throttle so it can move a clock. This one does not: `AUTH_MAX_LOGIN_ATTEMPTS=2`
    // goes in through `parseEnv` and the request path has to reach the very counter `app.ts` built from it — which is
    // what makes "one throttle per process" a fact rather than a comment. It also proves the `Retry-After` header the
    // route sets agrees with the `details` the service computed, on the real error path.
    await withFreshDatabase(
      async (database, name) => {
        await database.db
          .insertInto('admins')
          .values({ username: 'admin', password_hash: PASSWORD_HASH })
          .execute();

        const app = await buildApp({
          config: parseEnv({ DATABASE_URL: dsnFor(name), AUTH_MAX_LOGIN_ATTEMPTS: '2' }),
          database,
        });

        try {
          for (const attempt of [1, 2]) {
            const response = await post(app, { username: 'admin', password: 'wrong password' });
            expect(response.statusCode, `attempt ${String(attempt)}`).toBe(401);
          }

          const limited = await post(app, { username: 'admin', password: 'wrong password' });
          expect(limited.statusCode).toBe(429);

          const details = LoginRateLimitDetailsSchema.parse(
            limited.json<{ error: { details: unknown } }>().error.details,
          );
          expect(limited.headers['retry-after']).toBe(String(details.retryAfterSeconds));
          // The header is an integer number of seconds: `Retry-After: 899.7` is not a value any client parses.
          expect(limited.headers['retry-after']).toMatch(/^\d+$/u);

          // And the same throttle refuses the *right* password too — a lockout that only blocks wrong guesses is not a
          // lockout, and an attacker who finds the password during the window must not get in.
          const correct = await post(app, { username: 'admin', password: PASSWORD });
          expect(correct.statusCode).toBe(429);
        } finally {
          await app.close();
        }
      },
      { prefix: 'throttle', migrate: true },
    );
  });
});
