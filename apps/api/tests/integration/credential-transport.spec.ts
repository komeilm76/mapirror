import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp, parseEnv, type SqlDatabase } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * L2 and the transport half of `14-security.md` §11, as one test (`P1-API-08`).
 *
 * The suite already has the *policy* tests: `admin-guard.spec.ts` walks the route table and proves every admin route
 * refuses a request with no token, and `bearer.spec.ts` proves the header parser accepts exactly one bearer credential.
 * What neither can show is the thing a reviewer actually asks about — **that a valid token is worth nothing unless it
 * arrives in the `Authorization` header**. A guard that also read a cookie, or a query parameter, would pass both:
 * the anonymous walk still sees `401`, and the parser is still strict about the header it never has to read.
 *
 * So this file takes a **real, live, valid token** and offers it in every place a client might hope it counts — a
 * cookie, the query string, an `X-Api-Key` header, a body field, `Basic` credentials, a bare header — against
 * **every** admin route the instance registered, plus the two authenticated routes in the auth namespace. If any of
 * them is ever accepted the request stops being a `401` and this file fails.
 *
 * A live token, not a forged one: a made-up credential would be refused by the *database* rather than by the
 * transport rule, which is the green-but-meaningless shape this project keeps hunting for.
 */

const skipReason = await freshDatabaseSkipReason();

/** What a case gets: the app, its database, the routes it registered, and one live token. */
interface Harness {
  readonly app: FastifyInstance;
  readonly database: SqlDatabase;
  /** `METHOD /path` for every route the instance registered, `HEAD` skipped (implied by `GET`). */
  readonly routes: string[];
  readonly token: string;
}

/** Every registered route as `METHOD /path`, collected from the table the guards actually run against. */
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
 * Builds the app on a fresh database with one admin and one live token.
 *
 * @param run - The case body.
 */
async function withToken(run: (harness: Harness) => Promise<void>): Promise<void> {
  await withFreshDatabase(
    async (database, name) => {
      const admin = await database.db
        .insertInto('admins')
        // Not a digest: no route in this file verifies a password, and Argon2 would add 74 ms per case for nothing.
        .values({ username: 'admin', password_hash: 'not-used-by-these-routes', is_active: true })
        .returning('id')
        .executeTakeFirstOrThrow();

      const issued = await issueToken(database.db, admin.id, { ttlHours: 12 });
      const collected = collectRoutes();
      const app = await buildApp({
        config: parseEnv({ DATABASE_URL: dsnFor(name) }),
        database,
        routeObserver: collected.observer,
      });

      try {
        await run({ app, database, routes: collected.routes, token: issued.token });
      } finally {
        await app.close();
      }
    },
    { prefix: 'transport', migrate: true },
  );
}

/** The admin routes, from the collected table. */
function adminRoutes(routes: readonly string[]): string[] {
  return routes.filter((route) => route.split(' ')[1]?.startsWith('/_admin/api') === true);
}

/**
 * Every place a credential could be offered that is **not** `Authorization: Bearer <token>`.
 *
 * Each entry is a name for the test output and the headers to send; the query-string and body variants are added
 * per request, because they are not headers.
 */
function misplacedCredentials(
  token: string,
): readonly { readonly name: string; readonly headers: Record<string, string> }[] {
  return [
    { name: 'a cookie', headers: { cookie: `mapirror_token=${token}` } },
    { name: 'a session cookie under another name', headers: { cookie: `session=${token}` } },
    { name: 'an X-Api-Key header', headers: { 'x-api-key': token } },
    { name: 'an X-Auth-Token header', headers: { 'x-auth-token': token } },
    {
      name: 'Basic credentials carrying it as the password',
      headers: {
        authorization: `Basic ${Buffer.from(`admin:${token}`).toString('base64')}`,
      },
    },
    {
      name: 'Basic credentials carrying it as the username',
      headers: {
        authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
      },
    },
    { name: 'the bare header value, with no scheme', headers: { authorization: token } },
    { name: 'a bearer header with no value', headers: { authorization: 'Bearer' } },
    {
      name: 'a bearer header with a second credential',
      headers: { authorization: `Bearer ${token} extra` },
    },
    { name: 'another scheme naming the token', headers: { authorization: `Token ${token}` } },
  ];
}

describe.skipIf(skipReason !== null)(
  'the transport law: one bearer header, and nothing else',
  () => {
    it('collects the real route table, including at least one admin route', async () => {
      // The walk below is only worth its runtime if it walked something: a guard test that calls no route is the
      // green-but-empty failure mode. Three route families are named, so a table that lost one fails here rather than
      // silently narrowing every sweep in this file.
      await withToken(async ({ app, routes }) => {
        expect(adminRoutes(routes).length).toBeGreaterThan(0);
        expect(routes).toContain('POST /_auth/api/login');
        expect(routes).toContain('GET /_public/api/countries');
        expect(routes).toContain('GET /healthz');

        // ...and the table describes routes that answer: the probe the sweep collects is a real one, not a name.
        expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      });
    });

    it('refuses every misplaced credential on every admin route', async () => {
      await withToken(async ({ app, routes, token }) => {
        for (const route of adminRoutes(routes)) {
          const [method, url] = route.split(' ') as [string, string];

          for (const variant of misplacedCredentials(token)) {
            const response = await app.inject({
              method: method as 'GET',
              url,
              headers: variant.headers,
            });

            // `401 UNAUTHENTICATED`, not `403` and not the stub's `503`: the request never got past the guard.
            expect(response.statusCode, `${route} via ${variant.name}`).toBe(401);
            expect(
              response.json<{ error: { code: string } }>().error.code,
              `${route} via ${variant.name}`,
            ).toBe('UNAUTHENTICATED');
          }

          // The query string, on the same route.
          const viaQuery = await app.inject({
            method: method as 'GET',
            url: `${url}?token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
          });
          expect(viaQuery.statusCode, `${route} via the query string`).toBe(401);

          // ...and the body, for methods that can carry one. The token remains misplaced even when a route validates
          // its own request body, and the auth guard must reject it first.
          if (method === 'POST') {
            const viaBody = await app.inject({
              method: 'POST',
              url,
              headers: { 'content-type': 'application/json' },
              payload: { token },
            });
            expect(viaBody.statusCode, `${route} via the body`).toBe(401);
          }
        }
      });
    });

    it('accepts the same token in the Authorization header, so the refusals are about transport', async () => {
      // The other half: if the guard refused everything, the sweep above would pass and the API would be unusable. An
      // implemented route's success or a remaining stub's `503` proves the guard let the request through.
      await withToken(async ({ app, routes, token }) => {
        const admin = adminRoutes(routes);
        expect(admin.length).toBeGreaterThan(0);

        for (const route of admin) {
          const [method, url] = route.split(' ') as [string, string];
          const response = await app.inject({
            method: method as 'GET',
            url,
            headers: { authorization: `Bearer ${token}` },
          });

          if (route === 'GET /_admin/api/catalog' || route === 'GET /_admin/api/cache') {
            expect(response.statusCode, route).toBe(200);
          } else if (route === 'POST /_admin/api/catalog/sync') {
            expect(response.statusCode, route).toBe(202);
            expect(response.json<{ jobId: string }>().jobId).toMatch(/^[0-9a-f-]{36}$/u);
          } else if (
            route === 'GET /_admin/api/catalog/regions/:slug' ||
            route === 'GET /_admin/api/catalog/regions/:slug/snapshots' ||
            route === 'GET /_admin/api/cache/:countryId' ||
            route === 'POST /_admin/api/cache/downloads' ||
            route === 'DELETE /_admin/api/cache/:countryId'
          ) {
            expect(response.statusCode, route).toBe(400);
            expect(response.json<{ error: { code: string } }>().error.code, route).toBe(
              'VALIDATION_ERROR',
            );
          } else {
            expect(response.statusCode, route).toBe(503);
            expect(response.json<{ error: { code: string } }>().error.code, route).toBe(
              'NOT_READY',
            );
          }
        }
      });
    });

    it('refuses the same misplaced credentials on the two authenticated auth routes', async () => {
      // `/me` and `/logout` authenticate themselves (`modules/auth/session.ts`) rather than relying on the admin guard,
      // so they are a second implementation of the same rule and need the same assertion — a rule enforced in one place
      // and re-implemented in another is a rule with two chances to drift.
      await withToken(async ({ app, token, database }) => {
        for (const [method, url] of [
          ['GET', '/_auth/api/me'],
          ['POST', '/_auth/api/logout'],
        ] as const) {
          for (const variant of misplacedCredentials(token)) {
            const response = await app.inject({ method, url, headers: variant.headers });
            expect(response.statusCode, `${url} via ${variant.name}`).toBe(401);
          }

          const viaQuery = await app.inject({ method, url: `${url}?token=${token}` });
          expect(viaQuery.statusCode, `${url} via the query string`).toBe(401);
        }

        // Nothing above revoked it: a refused request must not have had a side effect, so the token still works.
        const me = await app.inject({
          method: 'GET',
          url: '/_auth/api/me',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(me.statusCode).toBe(200);

        const live = await database.db
          .selectFrom('admin_tokens')
          .select('revoked_at')
          .executeTakeFirstOrThrow();
        expect(live.revoked_at).toBeNull();
      });
    });

    it('answers JSON on every registered route, and never HTML', async () => {
      // The doc's L1 list has this as "no API route returns text/html". The sweep covers every route in every
      // namespace rather than the three a hand-written list would name — a `content-type: text/html` on an API is how a
      // static handler gets mounted under an API prefix and nobody notices until a browser renders it.
      await withToken(async ({ app, routes, token }) => {
        for (const route of routes) {
          const [method, url] = route.split(' ') as [string, string];
          const response = await app.inject({
            method: method as 'GET',
            url,
            headers: {
              // Admin routes need a token to get as far as their own answer; the shape of the refusal is asserted above.
              ...(url.startsWith('/_admin/api') ? { authorization: `Bearer ${token}` } : {}),
              // Merged, not replaced: an earlier version spread a second `headers` object over the first, so a `POST`
              // admin route was asked *without* its token and the test quietly measured `401` instead of the answer.
              ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            },
            ...(method === 'POST' ? { payload: {} } : {}),
          });

          expect(response.headers['content-type'], route).toMatch(/^application\/json/);
          expect(response.body, route).not.toContain('<html');
        }
      });
    });
  },
);
