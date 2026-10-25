import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/lib/errors';
import { installAuthGuard } from '../../src/plugins/auth-guard';
import { buildTestApp } from '../helpers/test-app';

/**
 * Law L2: *every* `/_admin/api/*` route requires a valid Bearer token, with **no opt-out**, enforced by a guard keyed on
 * the prefix rather than attached per route.
 *
 * The important test in this file is the one that **walks the route table** and calls every admin route it finds. A
 * hand-written list of routes is a list that goes stale: the route someone adds next week is missing from it, the
 * per-route guard they forgot is missing from the code, and both gaps are invisible. Walking `printRoutes`-equivalent
 * data makes the test grow with the app.
 *
 * The rest is the shell around it — what a refusal looks like, what a *non*-refusal must not look like, and the two
 * cases where the right answer is not `401`.
 */

const TOKEN = `mm_${'A'.repeat(43)}`;

/** Builds the app with a verifier whose answer the test chooses. */
function appWithVerify(verify: (token: string) => Promise<unknown>): Promise<FastifyInstance> {
  return buildTestApp({ authVerify: (_request, token) => verify(token) });
}

/** A verifier that accepts every token. */
const accept = (): Promise<unknown> => Promise.resolve({});

/** A verifier that refuses with a given `AppError`. */
const refuse = (error: AppError) => (): Promise<unknown> => Promise.reject(error);

/**
 * Every admin route the app registered, as `METHOD /path`.
 *
 * Fastify exposes the table through the `onRoute` hook, which is how this is collected: the hook fires during `ready()`
 * and `buildTestApp` has already booted by the time this runs, so a hook added afterwards would see nothing — hence the
 * app is built here with the collector attached *before* the boot.
 */
async function adminRoutes(): Promise<string[]> {
  const routes: string[] = [];
  const app = await buildTestApp({
    // Collected from the same table the guard runs against: if the guard is removed, this test still knows what should
    // have been protected, which is what makes it a test of the guard rather than of itself.
    routeObserver: (route) => {
      const methods = typeof route.method === 'string' ? [route.method] : route.method;
      for (const method of methods) {
        if (method === 'HEAD') continue; // implied by GET, and never refused differently
        if (route.url.startsWith('/_admin/api')) routes.push(`${method} ${route.url}`);
      }
    },
  });
  await app.close();
  return routes;
}

describe('the route table', () => {
  it('has at least one admin route, so the walk below is not vacuous', async () => {
    // A guard test that passes because it called nothing is the classic green-but-empty test.
    expect(await adminRoutes()).toContain('GET /_admin/api/catalog');
  });

  it('refuses every admin route without a token', async () => {
    const routes = await adminRoutes();
    expect(routes.length).toBeGreaterThan(0);

    const app = await appWithVerify(accept);
    try {
      for (const route of routes) {
        const [method, url] = route.split(' ') as [string, string];
        const response = await app.inject({ method: method as 'GET', url });

        expect(response.statusCode, route).toBe(401);
        expect(response.json<{ error: { code: string } }>().error.code, route).toBe(
          'UNAUTHENTICATED',
        );
        // The stub's own answer must not leak through: a `503 NOT_READY` here would mean the handler ran.
        expect(response.body, route).not.toContain('NOT_READY');
      }
    } finally {
      await app.close();
    }
  });

  it('lets every admin route through once the token is accepted', async () => {
    // The other half of the walk: the guard must be a gate, not a wall. If it refused everything, the first test would
    // pass and the API would be unusable.
    const routes = await adminRoutes();
    const app = await appWithVerify(accept);
    try {
      for (const route of routes) {
        const [method, url] = route.split(' ') as [string, string];
        const response = await app.inject({
          method: method as 'GET',
          url,
          headers: { authorization: `Bearer ${TOKEN}` },
        });

        expect(response.statusCode, route).not.toBe(401);
      }
    } finally {
      await app.close();
    }
  });
});

describe('what a refusal looks like', () => {
  it('is the documented envelope, with the request id and the id header', async () => {
    const app = await appWithVerify(accept);
    try {
      const response = await app.inject({ method: 'GET', url: '/_admin/api/catalog' });

      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      const body = response.json<{
        error: { code: string; message: string; requestId: string };
      }>();
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(body.error.message).toBe('Sign in to continue.');
      // Same request id in the envelope and in the header: the guard writes no body of its own, it throws the same
      // `AppError` type every other failure throws.
      expect(body.error.requestId).toBe(response.headers['x-request-id']);
      // Nothing about the guard's internals, and no hint of which token would have worked.
      expect(response.body).not.toContain('stack');
      expect(response.body).not.toContain('Bearer');
    } finally {
      await app.close();
    }
  });

  it('refuses before the body is parsed', async () => {
    // A `POST` with an unparseable body: if the guard ran after parsing, the answer would be `400 VALIDATION_ERROR`.
    // A `401` proves an unauthenticated request cannot reach the parser — which is also why a refused request cannot
    // have had any side effect.
    const app = await appWithVerify(accept);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/_admin/api/catalog',
        headers: { 'content-type': 'application/json' },
        payload: '{"username": ',
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('refuses an unknown admin path with 401 rather than 404', async () => {
    // `onRequest` runs before routing, so the route table is not readable without a token. With one, the same path is
    // an honest `404` — the refusal is about the token, not about hiding that routing exists.
    const app = await appWithVerify(accept);
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/_admin/api/does-not-exist' })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/_admin/api/does-not-exist',
            headers: { authorization: `Bearer ${TOKEN}` },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('refuses the bare prefix, which has no route at all', async () => {
    // `/_admin/api` is not a route (`04-api.md` §0.3), but it *is* an admin path. Without a token the answer is `401`,
    // never `404`: the refusal comes from the guard, before routing, so an anonymous caller cannot map the surface.
    // With a token it is an honest `404`, which is the prove-the-guard-is-a-gate half of the same property.
    const app = await appWithVerify(accept);
    try {
      expect((await app.inject({ method: 'GET', url: '/_admin/api' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/_admin/api/' })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/_admin/api',
            headers: { authorization: `Bearer ${TOKEN}` },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('refuses a percent-escaped admin path too', async () => {
    // The classification decodes before it decides (`@mapirror/shared` `pathForms`), so `/_admin/%61pi/...` is admin
    // whether or not Fastify's router would have matched it. Fail closed: the token is required first.
    const app = await appWithVerify(accept);
    try {
      const response = await app.inject({ method: 'GET', url: '/_admin/%61pi/catalog' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('the verdict decides the answer', () => {
  it('maps each refusal to its own documented code and status', async () => {
    for (const [error, status, code] of [
      [new AppError('TOKEN_EXPIRED', 'expired'), 401, 'TOKEN_EXPIRED'],
      [new AppError('TOKEN_REVOKED', 'revoked'), 401, 'TOKEN_REVOKED'],
      [new AppError('ACCOUNT_DISABLED', 'disabled'), 403, 'ACCOUNT_DISABLED'],
    ] as const) {
      const app = await appWithVerify(refuse(error));
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/_admin/api/catalog',
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(response.statusCode, code).toBe(status);
        expect(response.json<{ error: { code: string } }>().error.code, code).toBe(code);
      } finally {
        await app.close();
      }
    }
  });

  it('turns a non-AppError from the verifier into a 500 that describes nothing', async () => {
    // A pool that died, a driver error naming the table, a DSN fragment in a message: none of it may reach a response.
    const app = await appWithVerify(() =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432 user=postgres')),
    );
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/_admin/api/catalog',
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
      expect(response.body).not.toContain('5432');
      expect(response.body).not.toContain('postgres');
      expect(response.body).not.toContain('ECONNREFUSED');
    } finally {
      await app.close();
    }
  });

  it('passes the presented token to the verifier, unmodified', async () => {
    const seen: string[] = [];
    const app = await appWithVerify((token) => {
      seen.push(token);
      return Promise.resolve({});
    });
    try {
      await app.inject({
        method: 'GET',
        url: '/_admin/api/catalog',
        headers: { authorization: `bearer ${TOKEN}` },
      });

      // Verbatim, and the same value the lower-cased scheme carried: normalising it here would hash to a digest no row
      // holds, i.e. a `401` for a perfectly good token.
      expect(seen).toEqual([TOKEN]);
    } finally {
      await app.close();
    }
  });
});

describe('what the guard does not touch', () => {
  it('leaves the public and auth namespaces anonymous', async () => {
    const touched: string[] = [];
    const app = await appWithVerify((token) => {
      touched.push(token);
      return Promise.resolve({});
    });
    try {
      for (const [method, url] of [
        ['GET', '/_public/api/countries'],
        ['POST', '/_auth/api/login'],
        ['GET', '/healthz'],
        ['GET', '/readyz'],
      ] as const) {
        await app.inject({ method, url });
      }

      // Not one token read: the guard is keyed on the scope, and the scope of these is not admin.
      expect(touched).toEqual([]);
      // The public stub still answers its own `503`, i.e. the guard did not shadow it.
      expect((await app.inject({ method: 'GET', url: '/_public/api/countries' })).statusCode).toBe(
        503,
      );
    } finally {
      await app.close();
    }
  });

  it('does not refuse a CORS preflight', async () => {
    // A browser sends `OPTIONS` without `Authorization` by design — the preflight exists to ask permission to send it.
    // The `security` stage answers preflights and ends the request before the guard is reached, which is why the order
    // in `plugins/order.ts` is `security` then `auth`; this test is what keeps that order honest.
    // The allow-list is a *parsed* field, not an environment name: passing `CORS_ORIGINS` to `parseEnv` here would be
    // ignored, and the preflight below would then be refused for the wrong reason — a test that passes by accident.
    const { parseEnv } = await import('../../src/config/env');
    const app = await buildTestApp({
      config: { ...parseEnv({}), corsOrigins: ['https://maps.example.org'] },
    });
    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/_admin/api/catalog',
        headers: {
          origin: 'https://maps.example.org',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });

      expect(response.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });
});

describe('the guard is installed by the pipeline, not by the test', () => {
  it('is part of PLUGIN_ORDER, with no task left open', async () => {
    const { PLUGIN_ORDER } = await import('../../src/plugins/order');
    const slot = PLUGIN_ORDER.find((entry) => entry.id === 'auth');

    expect(slot, 'the auth slot must exist').toBeDefined();
    expect(slot?.install, 'the auth slot must be filled in').not.toBeNull();
    expect(slot?.task, 'a filled slot names no task').toBeNull();
  });

  it('sits before the routes it protects, so a later route cannot escape it', async () => {
    const { PLUGIN_ORDER } = await import('../../src/plugins/order');
    const ids = PLUGIN_ORDER.map((entry) => entry.id);

    // Order, not just presence: a guard installed after the routes would be encapsulated away from them.
    expect(ids.indexOf('auth')).toBeGreaterThan(ids.indexOf('db'));
    expect(ids.indexOf('auth')).toBeLessThan(ids.indexOf('routes'));
  });

  it('is documented as having no opt-out', () => {
    // The prose and the code have to agree about the *absence* of something, which is the kind of claim that rots.
    const law = readFileSync(resolve(import.meta.dirname, '../../../../docs/10-laws.md'), 'utf8');
    const section = law.slice(law.indexOf('## L2'));
    expect(section.slice(0, 800)).toMatch(/no\*\* opt-out|no opt-out/u);
    // ...and the guard's own options type has exactly one field, a verifier: there is no policy to switch off.
    const source = readFileSync(
      resolve(import.meta.dirname, '../../src/plugins/auth-guard.ts'),
      'utf8',
    );
    const options = /export interface AuthGuardOptions \{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? '';
    const fields = [...options.matchAll(/readonly (\w+)\??:/gu)].map((match) => match[1]);
    expect(fields).toEqual(['verify']);
  });
});

describe('installAuthGuard on its own', () => {
  it('does nothing for a non-admin URL', async () => {
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    let called = 0;
    installAuthGuard(app, {
      verify: () => {
        called += 1;
        return Promise.resolve({});
      },
    });
    app.get('/_public/api/x', () => ({ ok: true }));
    await app.ready();
    try {
      expect((await app.inject({ method: 'GET', url: '/_public/api/x' })).statusCode).toBe(200);
      expect(called).toBe(0);
    } finally {
      await app.close();
    }
  });
});
