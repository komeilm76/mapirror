import { afterEach, describe, expect, it } from 'vitest';

import { isApiPath, isProbePath, statusFor } from '@mapirror/shared';

import { buildApp, pendingPlugins, PLUGIN_ORDER } from '../src/index';
import { STUB_ROUTES } from '../src/routes/not-implemented';
import type { FastifyInstance } from 'fastify';

/**
 * Acceptance test for `P1-API-01`: the server starts and registers routes under the three API prefixes.
 *
 * `app.inject()` is used instead of a socket on purpose — the acceptance criterion is about the *instance*
 * (routing, encapsulation, envelope), and a test that opens a port is a test that can fail for reasons
 * unrelated to the code. The real socket is exercised separately by the start/shutdown probe.
 */
const apps: FastifyInstance[] = [];

/**
 * Builds an app and remembers it for teardown.
 *
 * @returns A non-listening instance.
 */
async function app(): Promise<FastifyInstance> {
  const instance = await buildApp();
  apps.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe('the three API prefixes are registered', () => {
  const namespaces: [string, 'GET' | 'POST', string][] = [
    ['auth', 'POST', '/_auth/api/login'],
    ['admin', 'GET', '/_admin/api/catalog'],
    ['public', 'GET', '/_public/api/countries'],
  ];

  for (const [scope, method, url] of namespaces) {
    it(`${scope} namespace answers under its prefix`, async () => {
      const response = await (await app()).inject({ method, url });

      expect(response.statusCode).toBe(statusFor('NOT_READY'));
      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
    });
  }

  it('returns the documented error envelope, with a request id and the owning task', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/_public/api/countries' });
    const body = response.json<{ error: { code: string; message: string; requestId: string } }>();

    expect(body.error.code).toBe('NOT_READY');
    expect(body.error.requestId).toBeTypeOf('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
    expect(body.error.message).toContain('GET /_public/api/countries');
    // The task that replaces the stub is named in the response, so a stale stub explains itself.
    expect(body.error.message).toContain(STUB_ROUTES['GET /_public/api/countries']);
  });

  it('registers exactly the routes the contract names, and no invented ones', () => {
    // Every stub path is a documented route key, and every key names an owning task.
    for (const [route, task] of Object.entries(STUB_ROUTES)) {
      const [method, url] = route.split(' ') as [string, string];
      expect(['GET', 'POST'], route).toContain(method);
      expect(isApiPath(url), route).toBe(true);
      expect(task, route).toMatch(/^P[0-9]-[A-Z]+-[0-9]+$/);
    }
    expect(Object.keys(STUB_ROUTES)).toHaveLength(3);
  });

  it('serves nothing outside the three prefixes — no root, no bare prefix, no page', async () => {
    const instance = await app();
    for (const url of ['/', '/_auth/api', '/_admin/api', '/_public/api', '/_site/', '/login']) {
      const response = await instance.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('answers JSON for every registered API route, never HTML', async () => {
    const instance = await app();
    for (const [route, method] of [
      ['/_auth/api/login', 'POST'],
      ['/_admin/api/catalog', 'GET'],
      ['/_public/api/countries', 'GET'],
    ] as const) {
      const response = await instance.inject({ method, url: route });
      expect(response.headers['content-type'], route).toMatch(/^application\/json/);
      expect(response.body).not.toContain('<html');
    }
  });

  it('keeps the stub methods honest: login is POST, reads are GET', async () => {
    const instance = await app();
    // A GET on the login path must 404, not 503: the route exists only for the documented method.
    expect((await instance.inject({ method: 'GET', url: '/_auth/api/login' })).statusCode).toBe(
      404,
    );
    expect(
      (await instance.inject({ method: 'POST', url: '/_public/api/countries' })).statusCode,
    ).toBe(404);
  });
});

describe('plugin pipeline', () => {
  it('lists every stage once, in order, with routes last', () => {
    const ids = PLUGIN_ORDER.map((slot) => slot.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('routes');
    expect(PLUGIN_ORDER.at(-1)?.register).toBeTypeOf('function');
  });

  it('keeps request context and errors ahead of the routes that depend on them', () => {
    const ids = PLUGIN_ORDER.map((slot) => slot.id);
    expect(ids.indexOf('request-context')).toBeLessThan(ids.indexOf('errors'));
    expect(ids.indexOf('errors')).toBeLessThan(ids.indexOf('security'));
    expect(ids.indexOf('security')).toBeLessThan(ids.indexOf('routes'));
    expect(ids.indexOf('rate-limit')).toBeLessThan(ids.indexOf('auth'));
    expect(ids.indexOf('auth')).toBeLessThan(ids.indexOf('routes'));
  });

  it('marks a slot either implemented or owned by a task — never both, never neither', () => {
    for (const slot of PLUGIN_ORDER) {
      const implemented = slot.register !== null;
      const owned = slot.task !== null;
      expect(
        implemented !== owned,
        `${slot.id}: task=${String(slot.task)} register=${implemented}`,
      ).toBe(true);
      if (slot.task !== null) expect(slot.task, slot.id).toMatch(/^P[0-9]-[A-Z]+-[0-9]+$/);
    }
  });

  it('reports the pending slots, which are exactly the unimplemented ones', () => {
    const expected = PLUGIN_ORDER.filter((slot) => slot.register === null).map((slot) => slot.id);
    expect(pendingPlugins()).toEqual(expected);
    // The pipeline is not empty today: routes are registered, so "everything pending" would also be a bug.
    expect(pendingPlugins().length).toBeLessThan(PLUGIN_ORDER.length);
  });

  it('registers the implemented slots when the app is built', async () => {
    const instance = await app();
    // `printRoutes()` prints a segment trie (`_` → `public/api`), which no URL ever appears in verbatim;
    // `commonPrefix: false` prints whole URLs, which is what "the slot was actually registered" means.
    const routes = instance.printRoutes({ commonPrefix: false });
    expect(routes).toContain('_public/api/countries');
    expect(routes).toContain('_admin/api/catalog');
    expect(routes).toContain('_auth/api/login');
  });
});

describe('L1 is enforced at registration time, not only by the law test', () => {
  it('refuses to boot with a route outside the four legal namespaces', async () => {
    const instance = await app();
    expect(() => {
      instance.get('/admin/cache', () => ({ ok: true }));
    }).toThrow(/violates L1/);
  });

  it('lists every method of a multi-method route in the error', async () => {
    const instance = await app();
    // Fastify accepts a method array; the message must not print `[object Object]` or only the first.
    expect(() => {
      instance.route({ method: ['GET', 'POST'], url: '/health', handler: () => ({ ok: true }) });
    }).toThrow(/GET,POST \/health|POST,GET \/health/);
  });

  it('names the offending route in the error', async () => {
    const instance = await app();
    expect(() => {
      instance.get('/api/countries', () => ({ ok: true }));
    }).toThrow(/\/api\/countries/);
  });

  it('accepts API routes and probes', async () => {
    const instance = await app();
    for (const url of [
      '/healthz',
      '/readyz',
      '/_admin/api/probe',
      '/_auth/api/probe',
      '/_public/api/x',
    ]) {
      expect(isApiPath(url) || isProbePath(url), url).toBe(true);
      expect(() => instance.get(url, () => ({ ok: true })), url).not.toThrow();
    }
  });

  it('still refuses /_site paths, because the API never serves pages', async () => {
    const instance = await app();
    // Pages are served by Nginx; the redirect `/` → `/_site/` lives there too (04-api.md §0).
    expect(() => instance.get('/_site/countries', () => ({ ok: true }))).toThrow(/violates L1/);
  });
});
