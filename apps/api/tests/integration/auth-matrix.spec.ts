import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { statusFor, type ErrorCode } from '@mapirror/shared';
import { buildApp, parseEnv, requiresAdminToken, type SqlDatabase } from '../../src/index';
import { issueToken, type TokenVerdict } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * The auth matrix (`P1-AUTH-08`): every credential state, on every authenticated surface, as one table.
 *
 * The suites that already exist each test one axis. `me-logout.spec.ts` walks the four refusals against `/me` and
 * `/logout`; `admin-guard-db.spec.ts` walks them against one admin route; `credential-transport.spec.ts` walks the
 * transport vectors against every admin route. What none of them can show is the invariant the contract actually
 * states — **a credential state has one answer, and every authenticated surface gives it** (`04-api.md` §1: logout's
 * errors are "the same four as `/me`"). If `/logout` answered `UNAUTHENTICATED` for an expired token while the guard
 * answered `TOKEN_EXPIRED`, every suite above would still be green and the SPA would have two different stories about
 * one session.
 *
 * So the matrix is the cross-product, and it is **data**, not prose:
 *
 * - The surfaces are the *real* route table, filtered by the same `requiresAdminToken` predicate the guard uses, plus
 *   the two auth routes that authenticate themselves. A new admin route is covered the day it is registered.
 * - The refusal states come from the token service's own verdict union: `CODE_FOR_VERDICT` is a
 *   `Record<Exclude<TokenVerdict['status'], 'valid'>, ErrorCode>`, so **adding a verdict to `tokens.ts` without adding a
 *   row here fails the typecheck**, not the review.
 * - The expected status is `statusFor(code)` from `@mapirror/shared`, not a literal: the answer is checked against the
 *   contract's own mapping rather than a copy of it.
 *
 * The transport refusals (cookie, query string, `X-Api-Key`, `Basic`) are included as rows too. They are the
 * *absence* of a credential as far as this API is concerned, so the expected answer is `UNAUTHENTICATED` — the same as
 * no header at all, which is the point.
 */

const skipReason = await freshDatabaseSkipReason();

/** A refusal the token service can report: every verdict except `valid`. */
type RefusalVerdict = Exclude<TokenVerdict['status'], 'valid'>;

/**
 * The error code each verdict must produce.
 *
 * `satisfies Record<RefusalVerdict, ErrorCode>` is the completeness guard: a fifth verdict in `tokens.ts` is a
 * compile error here until this table says what it means.
 */
const CODE_FOR_VERDICT = {
  unknown: 'UNAUTHENTICATED',
  expired: 'TOKEN_EXPIRED',
  revoked: 'TOKEN_REVOKED',
  disabled: 'ACCOUNT_DISABLED',
} as const satisfies Record<RefusalVerdict, ErrorCode>;

/** The two auth routes that authenticate themselves rather than relying on the admin guard. */
const SELF_AUTHENTICATED_ROUTES = ['GET /_auth/api/me', 'POST /_auth/api/logout'] as const;

/** What a case gets: a live app over its own database, the route table, and two accounts in different states. */
interface Fixture {
  readonly app: FastifyInstance;
  readonly database: SqlDatabase;
  /** `METHOD /path` for every route the instance registered, `HEAD` skipped (implied by `GET`). */
  readonly routes: readonly string[];
  /** Id of the active account. */
  readonly activeAdminId: string;
  /** Id of the account whose `is_active` is false. */
  readonly inactiveAdminId: string;
}

/** A credential offered to a surface: headers, and optionally a query string. */
interface Offered {
  readonly headers: Readonly<Record<string, string>>;
  readonly query?: string;
}

/** One row of the matrix. */
interface MatrixRow {
  /** Names the row in a failure message. */
  readonly name: string;
  /** The documented code the surface must answer with. */
  readonly code: ErrorCode;
  /** Builds the credential for one attempt. Called per (row, surface), so a row may issue a token of its own. */
  readonly offer: (fixture: Fixture) => Promise<Offered>;
}

/** Collects the route table the guards actually run against. */
function collectRoutes(): {
  routes: string[];
  observer: (route: { readonly url: string; readonly method: string | string[] }) => void;
} {
  const routes: string[] = [];
  return {
    routes,
    observer: (route) => {
      const methods = typeof route.method === 'string' ? [route.method] : route.method;
      for (const method of methods) {
        if (method === 'HEAD') continue;
        routes.push(`${method} ${route.url}`);
      }
    },
  };
}

/**
 * Runs a case against a fresh, migrated database with one active and one deactivated account.
 *
 * @param run - The case body.
 */
async function withMatrix(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withFreshDatabase(
    async (database, name) => {
      // Not digests: no route in this file verifies a password, and two Argon2 hashes would add 150 ms per case for
      // nothing. The column is `text`, and the value never reaches a comparison here.
      const active = await database.db
        .insertInto('admins')
        .values({ username: 'admin', password_hash: 'not-a-digest', is_active: true })
        .returning('id')
        .executeTakeFirstOrThrow();
      const inactive = await database.db
        .insertInto('admins')
        .values({ username: 'dormant', password_hash: 'not-a-digest', is_active: false })
        .returning('id')
        .executeTakeFirstOrThrow();

      const collected = collectRoutes();
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
        routeObserver: collected.observer,
      });

      try {
        await run({
          app,
          database,
          routes: collected.routes,
          activeAdminId: active.id,
          inactiveAdminId: inactive.id,
        });
      } finally {
        await app.close();
      }
    },
    { prefix: 'matrix', migrate: true },
  );
}

/** Every route that must refuse a request that is not properly authenticated: the guard's set, plus the two above. */
function authenticatedSurfaces(routes: readonly string[]): string[] {
  return routes.filter((route) => {
    const url = route.split(' ')[1] ?? '';
    return (
      requiresAdminToken(url) || (SELF_AUTHENTICATED_ROUTES as readonly string[]).includes(route)
    );
  });
}

/** Sends one request to one surface, offering the credential the way the row describes. */
async function offer(
  app: FastifyInstance,
  surface: string,
  offered: Offered,
): Promise<{ readonly statusCode: number; readonly code: string | undefined }> {
  const [method, url] = surface.split(' ') as [string, string];
  const response = await app.inject({
    method: method as 'GET',
    url: offered.query === undefined ? url : `${url}?${offered.query}`,
    headers: { ...offered.headers },
  });
  // A success has no envelope — `/logout` answers `204` with no body at all, and `JSON.parse('')` throws.
  const body = response.body === '' ? {} : response.json<{ error?: { code?: string } }>();
  return { statusCode: response.statusCode, code: body.error?.code };
}

/** A token for the active account, valid now. */
async function liveToken(fixture: Fixture): Promise<string> {
  const issued = await issueToken(fixture.database.db, fixture.activeAdminId, { ttlHours: 12 });
  return issued.token;
}

/**
 * The rows driven by the token service's verdicts, one per refusal it can report.
 *
 * `unknown` is a well-formed token that was never issued — the shape matters, because a malformed one never reaches the
 * database and would be refused by the parser rather than by the lookup.
 */
const VERDICT_CASES = {
  unknown: {
    name: 'a well-formed token that was never issued',
    code: CODE_FOR_VERDICT.unknown,
    offer: () => Promise.resolve({ headers: { authorization: `Bearer mm_${'A'.repeat(43)}` } }),
  },
  expired: {
    name: 'an expired token',
    code: CODE_FOR_VERDICT.expired,
    offer: async (fixture) => {
      // Issued two hours ago with a one-hour TTL: expired by exactly one hour, so the verdict cannot be a boundary
      // artefact.
      const stale = await issueToken(fixture.database.db, fixture.activeAdminId, {
        ttlHours: 1,
        now: new Date(Date.now() - 2 * 3_600_000),
      });
      return { headers: { authorization: `Bearer ${stale.token}` } };
    },
  },
  revoked: {
    name: 'a token that was signed out',
    code: CODE_FOR_VERDICT.revoked,
    offer: async (fixture) => {
      const issued = await issueToken(fixture.database.db, fixture.activeAdminId, { ttlHours: 12 });
      await fixture.database.db
        .updateTable('admin_tokens')
        .set({ revoked_at: new Date() })
        .where('id', '=', issued.tokenId)
        .execute();
      return { headers: { authorization: `Bearer ${issued.token}` } };
    },
  },
  disabled: {
    name: 'a live token on a deactivated account',
    code: CODE_FOR_VERDICT.disabled,
    offer: async (fixture) => {
      const issued = await issueToken(fixture.database.db, fixture.inactiveAdminId, {
        ttlHours: 12,
      });
      return { headers: { authorization: `Bearer ${issued.token}` } };
    },
  },
} as const satisfies Record<RefusalVerdict, MatrixRow>;

/**
 * The rows where the token never reaches the guard, or reaches it in a form it must not accept.
 *
 * Every one of these must be indistinguishable from sending no credential at all — that is the transport law of
 * `14-security.md` §11, asserted here as a *row* so it is checked on every surface rather than on one.
 */
const TRANSPORT_CASES: readonly MatrixRow[] = [
  {
    name: 'no credential at all',
    code: 'UNAUTHENTICATED',
    offer: () => Promise.resolve({ headers: {} }),
  },
  {
    name: 'a token that is not shaped like one',
    code: 'UNAUTHENTICATED',
    offer: () => Promise.resolve({ headers: { authorization: 'Bearer not-a-token' } }),
  },
  {
    name: 'a live token in a cookie',
    code: 'UNAUTHENTICATED',
    offer: async (fixture) => ({
      headers: { cookie: `mapirror_token=${await liveToken(fixture)}` },
    }),
  },
  {
    name: 'a live token in the query string',
    code: 'UNAUTHENTICATED',
    offer: async (fixture) => ({ headers: {}, query: `token=${await liveToken(fixture)}` }),
  },
  {
    name: 'a live token in an X-Api-Key header',
    code: 'UNAUTHENTICATED',
    offer: async (fixture) => ({ headers: { 'x-api-key': await liveToken(fixture) } }),
  },
  {
    name: 'a live token as Basic credentials',
    code: 'UNAUTHENTICATED',
    offer: async (fixture) => {
      const token = await liveToken(fixture);
      return {
        headers: { authorization: `Basic ${Buffer.from(`admin:${token}`).toString('base64')}` },
      };
    },
  },
];

describe.skipIf(skipReason !== null)('the auth matrix', () => {
  it('finds the surfaces it claims to cover, so no row below is vacuous', async () => {
    await withMatrix(async ({ app, routes }) => {
      const surfaces = authenticatedSurfaces(routes);

      // At least one admin route, plus both self-authenticated auth routes: a table that lost the auth namespace, or
      // that never registered an admin route, would make every sweep in this file pass while testing one route.
      expect(surfaces.filter((route) => route.includes('/_admin/api/')).length).toBeGreaterThan(0);
      expect(surfaces).toContain('GET /_auth/api/me');
      expect(surfaces).toContain('POST /_auth/api/logout');
      // `/login` is the one route under the auth prefix that must stay anonymous; it is not in the matrix because
      // there is no credential to present to it.
      expect(surfaces).not.toContain('POST /_auth/api/login');

      // ...and the predicate is the guard's, not a list that could drift from it.
      expect(
        routes
          .filter((route) => requiresAdminToken(route.split(' ')[1] ?? ''))
          .every((route) => surfaces.includes(route)),
      ).toBe(true);

      // The app answers, so `surfaces` is not a table of names.
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    });
  });

  for (const [verdict, row] of Object.entries(VERDICT_CASES)) {
    it(`answers ${row.name} with ${row.code} (${verdict}) on every surface`, async () => {
      await withMatrix(async (fixture) => {
        const surfaces = authenticatedSurfaces(fixture.routes);
        expect(surfaces.length).toBeGreaterThanOrEqual(3);

        for (const surface of surfaces) {
          const offered = await row.offer(fixture);
          const answer = await offer(fixture.app, surface, offered);

          // `statusFor` is the contract's own mapping. Asserting `401` here instead would pass even if
          // `ERROR_STATUS` and the routes disagreed, which is exactly the drift this row exists to catch.
          expect(answer.statusCode, `${row.name} on ${surface}`).toBe(statusFor(row.code));
          expect(answer.code, `${row.name} on ${surface}`).toBe(row.code);
        }
      });
    });
  }

  it('answers every misplaced credential with UNAUTHENTICATED on every surface', async () => {
    await withMatrix(async (fixture) => {
      const surfaces = authenticatedSurfaces(fixture.routes);

      for (const row of TRANSPORT_CASES) {
        for (const surface of surfaces) {
          const answer = await offer(fixture.app, surface, await row.offer(fixture));
          const where = `${row.name} on ${surface}`;

          expect(answer.statusCode, where).toBe(statusFor(row.code));
          expect(answer.code, where).toBe(row.code);
        }
      }
    });
  });

  it('lets a live token through, with the answer each surface documents', async () => {
    // The other half of the matrix: if every surface refused everything, the rows above would all pass and the API
    // would be unusable. Each attempt gets a fresh token, because `/logout` revokes the one it was given.
    await withMatrix(async (fixture) => {
      const refusals = new Set<ErrorCode>(Object.values(CODE_FOR_VERDICT));

      for (const surface of authenticatedSurfaces(fixture.routes)) {
        const answer = await offer(fixture.app, surface, {
          headers: { authorization: `Bearer ${await liveToken(fixture)}` },
        });

        if (surface === 'GET /_auth/api/me') {
          expect(answer.statusCode, surface).toBe(200);
        } else if (surface === 'POST /_auth/api/logout') {
          expect(answer.statusCode, surface).toBe(204);
        } else {
          // An admin route: today a `503 NOT_READY` stub. Deliberately not pinned to that number — the matrix is about
          // authentication, and `P2`/`P3` replace the stubs with real answers. What must hold forever is that a live
          // token is not answered with a refusal.
          expect(
            refusals.has(answer.code as ErrorCode),
            `${surface} → ${String(answer.code)}`,
          ).toBe(false);
          expect([401, 403], surface).not.toContain(answer.statusCode);
        }
      }
    });
  });

  it('writes nothing on a refusal: no audit row, no last-used stamp', async () => {
    // A refusal that still wrote would leak the existence of a session to whoever holds an expired token, and turn a
    // flood of bad credentials into a flood of writes — the opposite of what the rate limiter is for.
    await withMatrix(async (fixture) => {
      const surfaces = authenticatedSurfaces(fixture.routes);
      const rows = [...Object.values(VERDICT_CASES), ...TRANSPORT_CASES];

      for (const row of rows) {
        for (const surface of surfaces) await offer(fixture.app, surface, await row.offer(fixture));
      }

      const audits = await fixture.database.db
        .selectFrom('audit_logs')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow();
      expect(audits.count).toBe('0');

      const tokens = await fixture.database.db
        .selectFrom('admin_tokens')
        .select(['revoked_at', 'last_used_at'])
        .execute();
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) expect(token.last_used_at).toBeNull();

      // Exactly the rows the `revoked` case created are revoked, one per surface. A refused `/logout` that ended a
      // session anyway would make this count too high — the one side effect a 401 must never have.
      const revoked = tokens.filter((token) => token.revoked_at !== null);
      expect(revoked.length).toBe(surfaces.length);
    });
  });
});

describe('the matrix agrees with 04-api.md', () => {
  it('names exactly the codes the matrix covers, at the statuses the contract maps them to', () => {
    const doc = readFileSync(resolve(import.meta.dirname, '../../../../docs/04-api.md'), 'utf8');
    const start = doc.indexOf('### `GET /_auth/api/me`');
    expect(start, '04-api.md must document /me').toBeGreaterThan(-1);
    const paragraph = doc.slice(start, doc.indexOf('\n\n', doc.indexOf('Errors:', start)));

    const documented = [...paragraph.matchAll(/`(\d{3}) ([A-Z_]+)`/gu)].map((match) => ({
      status: Number(match[1]),
      code: match[2] as ErrorCode,
    }));
    expect(documented.length).toBeGreaterThan(0);

    const matrix = new Set<ErrorCode>([...Object.values(CODE_FOR_VERDICT), 'UNAUTHENTICATED']);
    expect(new Set(documented.map((entry) => entry.code))).toEqual(matrix);
    for (const entry of documented) expect(entry.status).toBe(statusFor(entry.code));

    // `04-api.md` says logout answers "the same four as `/me`". That sentence is the reason this file exists, so the
    // two paragraphs are compared rather than trusted.
    const logoutStart = doc.indexOf('### `POST /_auth/api/logout`');
    const logout = doc.slice(logoutStart, doc.indexOf('\n\n', doc.indexOf('Errors:', logoutStart)));
    expect(logout).toContain('the same four as `/me`');
  });
});
