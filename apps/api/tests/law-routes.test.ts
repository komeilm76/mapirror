import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { isApiPath, isProbePath } from '@mapirror/shared';

import { buildTestApp } from './helpers/test-app';

/**
 * L1 over the **real route table**, and "no API route answers HTML" (`P1-API-08`).
 *
 * The specification names this file: `04-api.md` §5 and `10-laws.md` L1 both call it `law-routes.test.ts`, and
 * `09-development.md` §7 says the law tests are non-negotiable and must never be skipped. That is why this file uses
 * **no database**: it builds the pipeline with the stub handle and an accepting verifier, so it runs in the fast gate
 * on a machine with no Postgres — a law test that skips is a law test that is not there.
 *
 * Three properties, each over *every* route the instance registered rather than a hand-written list:
 *
 * 1. the URL is inside one of the three API prefixes, or is one of the two probes;
 * 2. the answer is JSON, never HTML — an API that renders HTML under its prefix is how a static handler gets mounted
 *    somewhere nobody notices until a browser renders it, and it is also how a page ends up inside an API (L1);
 * 3. the classifiers the guards use (`isApiPath`, `isProbePath`) agree with the table, so no route can be legal to
 *    register and invisible to the guard that is supposed to protect it.
 *
 * Where the rest of the law lives: `tests/app.spec.ts` proves the boot is refused when a route breaks L1;
 * `tests/integration/admin-guard.spec.ts` walks the same table and proves every admin route refuses an anonymous
 * request; `tests/integration/credential-transport.spec.ts` proves a **live** token counts only in the
 * `Authorization` header — not in a cookie, the query string, a body field or `Basic` credentials.
 */

/** The app, booted with the collector attached, and every route it registered as `METHOD /path`. */
interface RouteTable {
  readonly app: FastifyInstance;
  /** `HEAD` is dropped: Fastify registers it implicitly for every `GET`, and it is never answered differently. */
  readonly routes: readonly string[];
}

/**
 * Builds the app with the route collector attached **before** the boot.
 *
 * A hook added afterwards sees nothing, which is why the table is collected here rather than from the returned
 * instance. The verifier accepts anything it is handed, so an admin route reaches its own answer without a database.
 *
 * @returns The instance and its route table.
 */
async function appWithRouteTable(): Promise<RouteTable> {
  const routes: string[] = [];
  const app = await buildTestApp({
    authVerify: () => Promise.resolve({}),
    routeObserver: (route) => {
      const methods = typeof route.method === 'string' ? [route.method] : route.method;
      for (const method of methods) {
        if (method === 'HEAD') continue;
        routes.push(`${method} ${route.url}`);
      }
    },
  });
  return { app, routes };
}

/** Injects one table entry, with a token where the namespace needs one and a body where the method does. */
function call(app: FastifyInstance, route: string) {
  const [method, url] = route.split(' ') as [string, string];
  return app.inject({
    method: method as 'GET',
    url,
    ...(url.startsWith('/_admin/api') ? { headers: { authorization: 'Bearer mm_probe' } } : {}),
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, payload: {} } : {}),
  });
}

describe('the route table obeys L1', () => {
  it('has routes, and the ones the contract names', async () => {
    // A sweep over an empty table passes every assertion that follows it, so the table is checked for content first.
    const { app, routes } = await appWithRouteTable();
    try {
      expect(routes.length).toBeGreaterThanOrEqual(5);
      for (const declared of [
        'POST /_auth/api/login',
        'GET /_admin/api/catalog',
        'GET /_public/api/countries',
        'GET /healthz',
        'GET /readyz',
      ]) {
        expect(routes, declared).toContain(declared);
      }
    } finally {
      await app.close();
    }
  });

  it('keeps every route inside an API prefix or on a probe', async () => {
    const { app, routes } = await appWithRouteTable();
    try {
      for (const route of routes) {
        const [method, url] = route.split(' ') as [string, string];
        // The two classifiers are what the boot check and the auth guard use. Asking them here means a future route
        // cannot be legal by one reading and illegal by the other.
        expect(isApiPath(url) || isProbePath(url), route).toBe(true);
        expect(method, route).toMatch(/^(GET|POST|PATCH|PUT|DELETE)$/u);
      }
    } finally {
      await app.close();
    }
  });

  it('serves no page from the API, including the login page and the site root', async () => {
    // Pages are Nginx's (`12-deployment.md`); an API answering one would be a second source of truth for the same URL
    // space. `/_auth/login` is a page path (D-19) and is *not* an API route — the pair this assertion pins.
    const { app } = await appWithRouteTable();
    try {
      for (const url of [
        '/',
        '/_site/',
        '/_site/admin',
        '/_auth/login',
        '/_auth/api',
        '/_admin/api',
      ]) {
        const response = await app.inject({ method: 'GET', url });
        // `/_auth/api` and `/_admin/api` are *paths* without routes; with no token the admin one is refused, which is
        // its own property (L2). What matters here is that neither is a page.
        expect([401, 404], url).toContain(response.statusCode);
        expect(response.headers['content-type'], url).toMatch(/^application\/json/u);
        expect(response.body, url).not.toContain('<html');
      }
    } finally {
      await app.close();
    }
  });

  it('answers JSON on every registered route, and never HTML', async () => {
    const { app, routes } = await appWithRouteTable();
    try {
      for (const route of routes) {
        const response = await call(app, route);
        expect(response.headers['content-type'], route).toMatch(/^application\/json/u);
        expect(response.body, route).not.toContain('<html');
      }
    } finally {
      await app.close();
    }
  });
});
