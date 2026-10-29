import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isApiPath, isProbePath } from '@mapirror/shared';

import {
  assertRouteLaw,
  installRouteLawHook,
  pendingPlugins,
  PLUGIN_ORDER,
  registerPipeline,
  type PluginSlot,
} from '../src/index';
import { buildTestApp } from './helpers/test-app';
import { STUB_ROUTES } from '../src/routes/not-implemented';
import Fastify, { type FastifyInstance } from 'fastify';

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
  const instance = await buildTestApp();
  apps.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe('the three API prefixes are registered', () => {
  it('validates the public countries query before touching the database', async () => {
    const response = await (
      await app()
    ).inject({
      method: 'GET',
      url: '/_public/api/countries?sort=unsupported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
  });

  it('auth answers under its prefix with a real handler, not a stub', async () => {
    // `P1-AUTH-03` replaced the `503`. An empty body is answered `400 VALIDATION_ERROR` by the shared schema, which
    // proves the route exists *and* that it validates before it queries.
    const response = await (await app()).inject({ method: 'POST', url: '/_auth/api/login' });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
  });

  it('has no registered placeholder routes', () => {
    // Completed handlers are real endpoints; future work remains absent instead of answering a misleading 503.
    for (const [route, task] of Object.entries(STUB_ROUTES)) {
      const [method, url] = route.split(' ') as [string, string];
      expect(['GET', 'POST'], route).toContain(method);
      expect(isApiPath(url), route).toBe(true);
      expect(task, route).toMatch(/^P[0-9]-[A-Z]+-[0-9]+$/);
    }
    expect(Object.keys(STUB_ROUTES)).toHaveLength(0);
  });

  it('serves nothing outside the three prefixes — no root, no bare prefix, no page', async () => {
    const instance = await app();
    for (const url of ['/', '/_auth/api', '/_public/api', '/_site/', '/login']) {
      const response = await instance.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('answers JSON for every registered API route, never HTML', async () => {
    const instance = await app();
    for (const [route, method] of [
      ['/_auth/api/login', 'POST'],
      ['/_admin/api/catalog', 'GET'],
      ['/_public/api/countries?sort=unsupported', 'GET'],
    ] as const) {
      // Every route in every namespace, stub or not: a JSON API never answers HTML, including for a bad request.
      const response = await instance.inject({
        method,
        url: route,
        // An admin route needs a token to get as far as its own answer (`P1-AUTH-05`); the shape of the *refusal* is
        // asserted in `admin-guard.spec.ts`. What is checked here is that no route in any namespace answers HTML.
        ...(route.startsWith('/_admin/')
          ? { headers: { authorization: `Bearer mm_${'a'.repeat(43)}` } }
          : {}),
      });
      expect(response.headers['content-type'], route).toMatch(/^application\/json/);
      expect(response.body).not.toContain('<html');
    }
  });

  it('keeps the route methods honest: login is POST, reads are GET', async () => {
    const instance = await app();
    // A GET on the login path must 404: the route exists only for the documented method.
    expect((await instance.inject({ method: 'GET', url: '/_auth/api/login' })).statusCode).toBe(
      404,
    );
    expect(
      (await instance.inject({ method: 'POST', url: '/_public/api/countries' })).statusCode,
    ).toBe(404);
  });
});

describe('buildApp returns a booted instance', () => {
  it('has registered every plugin before returning', async () => {
    // The observable consequence of awaiting `ready()` inside buildApp: the route table is final, so no
    // caller can append a route outside the pipeline (Fastify refuses once the root plugin has booted).
    const instance = await app();
    expect(() => instance.get('/_admin/api/late', () => ({ ok: true }))).toThrow(
      /already (booted|listening)/i,
    );
  });
});

describe('stub routes match the contract', () => {
  it('registers exactly the routes documented in 04-api.md §0.3', () => {
    const doc = readFileSync(resolve(import.meta.dirname, '../../../docs/04-api.md'), 'utf8');
    const start = doc.indexOf('### 0.3');
    expect(start, '04-api.md §0.3 must exist').toBeGreaterThan(-1);
    // Bounded by the next heading: slicing to the end of the file picks up every other table that happens
    // to contain a method plus a path, which is how the first version of this test compared 3 against 5.
    const nextHeading = doc.indexOf('\n## ', start);
    const section = doc.slice(start, nextHeading === -1 ? undefined : nextHeading);
    const documented = [...section.matchAll(/^\| `([A-Z]+ \S+)` \|/gm)].map(
      (match) => match[1] as string,
    );

    expect([...Object.keys(STUB_ROUTES)].sort()).toEqual([...documented].sort());
  });
});

describe('registerPipeline', () => {
  /** A stage that registers one route through the plugin machinery, returning the thenable. */
  const pluginSlot = (name: string, ran: string[]): PluginSlot => ({
    id: 'routes',
    rationale: 'test',
    task: null,
    install: (root) => {
      ran.push(name);
      // Deliberately *returns* the thenable, which is the shape a caller writes by accident. The pipeline must
      // not await it: `app.register()` resolves when the whole instance is booted.
      return root.register((scoped: FastifyInstance, _options, done) => {
        scoped.get(`/${name}`, () => ({ ok: true }));
        done();
      }) as unknown as void;
    },
  });

  it('does not boot mid-pipeline when a stage calls register()', async () => {
    // The landmine this test exists for: `await app.register(p)` boots the instance (Fastify is a thenable), so
    // the second stage fails with FST_ERR_INSTANCE_ALREADY_LISTENING. With one implemented slot the bug is
    // invisible; it appears the moment a second stage lands.
    const ran: string[] = [];
    const instance = Fastify({ logger: false });

    await registerPipeline(instance, [pluginSlot('healthz', ran), pluginSlot('readyz', ran)]);

    expect(ran).toEqual(['healthz', 'readyz']);
    expect(instance.hasRoute({ method: 'GET', url: '/healthz' })).toBe(true);
    expect(instance.hasRoute({ method: 'GET', url: '/readyz' })).toBe(true);
    await instance.close();
  });

  it('installs stages on the root instance, so their hooks are not encapsulated away', async () => {
    // The defect this guards: a stage registered with `app.register(...)` that adds an `onRequest` hook applies
    // it to its own empty subtree. Measured before the fix — the header was missing from every response.
    const instance = Fastify({ logger: false });

    await registerPipeline(instance, [
      {
        id: 'request-context',
        rationale: 'test',
        task: null,
        install: (root) => {
          root.addHook('onRequest', (_request, reply, done) => {
            reply.header('x-from-stage', 'yes');
            done();
          });
        },
      },
      {
        id: 'routes',
        rationale: 'test',
        task: null,
        install: (root) => {
          root.get('/_public/api/probe', () => ({ ok: true }));
        },
      },
    ]);

    const response = await instance.inject({ method: 'GET', url: '/_public/api/probe' });
    expect(response.headers['x-from-stage']).toBe('yes');
    await instance.close();
  });

  it('skips empty slots without booting early', async () => {
    const ran: string[] = [];
    const instance = Fastify({ logger: false });

    await registerPipeline(instance, [
      { id: 'request-context', rationale: 'test', task: 'P1-API-03', install: null },
      pluginSlot('routes', ran),
    ]);

    expect(ran).toEqual(['routes']);
    await instance.close();
  });
});

describe('plugin pipeline', () => {
  it('lists every stage once, in order, with routes last', () => {
    const ids = PLUGIN_ORDER.map((slot) => slot.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('routes');
    expect(PLUGIN_ORDER.at(-1)?.install).toBeTypeOf('function');
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
      const implemented = slot.install !== null;
      const owned = slot.task !== null;
      expect(
        implemented !== owned,
        `${slot.id}: task=${String(slot.task)} register=${implemented}`,
      ).toBe(true);
      if (slot.task !== null) expect(slot.task, slot.id).toMatch(/^P[0-9]-[A-Z]+-[0-9]+$/);
    }
  });

  it('reports the pending slots, which are exactly the unimplemented ones', () => {
    const expected = PLUGIN_ORDER.filter((slot) => slot.install === null).map((slot) => slot.id);
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

describe('L1 is enforced at boot, not only by the law test', () => {
  /**
   * The hook collects and `assertRouteLaw` throws — the pair `buildApp` uses. They are tested on a bare
   * instance because a throwing hook cannot be used: it stalls `ready()` forever (see `plugins/route-law.ts`).
   */
  const check = (register: (app: FastifyInstance) => void): string[] => {
    const instance = Fastify({ logger: false });
    const law = installRouteLawHook(instance);
    register(instance);
    return law.violations;
  };

  it('collects a route outside the four legal namespaces', () => {
    const violations = check((app) => app.get('/admin/cache', () => ({ ok: true })));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('/admin/cache');
    expect(() => assertRouteLaw(violations)).toThrow(/violates L1/);
  });

  it('names the offending route and the rule in the thrown message', () => {
    const violations = check((app) => app.get('/api/countries', () => ({ ok: true })));

    expect(() => assertRouteLaw(violations)).toThrow(/\/api\/countries/);
    expect(() => assertRouteLaw(violations)).toThrow(/one route violates/i);
  });

  it('reports one violation per route, listing its methods, not one per method', () => {
    // A `GET` also registers an implicit `HEAD`; without merging, one mistyped route would print twice.
    const violations = check((app) =>
      app.route({ method: ['GET', 'POST'], url: '/health', handler: () => ({ ok: true }) }),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('/health');
    for (const method of ['GET', 'POST']) expect(violations[0]).toContain(method);
  });

  it('reports every offending route at once, not just the first', () => {
    const violations = check((app) => {
      app.get('/api/a', () => ({ ok: true }));
      app.get('/_site/b', () => ({ ok: true }));
    });

    expect(violations).toHaveLength(2);
    expect(() => assertRouteLaw(violations)).toThrow(/2 routes violate/i);
    expect(() => assertRouteLaw(violations)).toThrow(/\/api\/a/);
    expect(() => assertRouteLaw(violations)).toThrow(/\/_site\/b/);
  });

  it('accepts API routes and probes without recording anything', () => {
    const violations = check((app) => {
      for (const url of [
        '/healthz',
        '/readyz',
        '/_admin/api/probe',
        '/_auth/api/probe',
        '/_public/api/x',
      ]) {
        expect(isApiPath(url) || isProbePath(url), url).toBe(true);
        app.get(url, () => ({ ok: true }));
      }
    });

    expect(violations).toEqual([]);
    expect(() => assertRouteLaw(violations)).not.toThrow();
  });

  it('still refuses /_site paths, because the API never serves pages', () => {
    // Pages are served by Nginx; the redirect `/` → `/_site/` lives there too (04-api.md §0).
    const violations = check((app) => app.get('/_site/countries', () => ({ ok: true })));
    expect(violations).toHaveLength(1);
  });

  it('stops buildApp when the pipeline registers an illegal route, instead of hanging', async () => {
    // The regression this guards: the guard used to throw from inside the `onRoute` hook, which left
    // `ready()` unsettled — `buildApp` never returned and the container never started. This test fails by
    // timing out if that comes back, and by asserting a message naming the route if the check is dropped.
    const illegal: PluginSlot = {
      id: 'routes',
      rationale: 'test seam: a pipeline that puts a route outside the API namespaces',
      task: null,
      // Installed on the root instance, which is what makes the route visible to the law hook at all — the
      // defect this guards (a throwing hook stalling `ready()`) only ever manifested on this path.
      install: (instance) => {
        instance.get('/_site/leak', () => ({ ok: true }));
      },
    };

    await expect(buildTestApp({ logger: false, slots: [illegal] })).rejects.toThrow(
      /\/_site\/leak/,
    );
    await expect(buildTestApp({ logger: false, slots: [illegal] })).rejects.toThrow(/violates L1/);
  }, 2_000);

  it('never throws from the hook, so a ready() can always settle', async () => {
    // Proves the *shape* of the guard, not just its outcome: a throwing `onRoute` hook stalls Fastify's boot
    // queue forever, so an illegal route must leave `ready()` resolvable. The 2 s cap turns a regression into
    // a failure instead of a hung suite.
    const instance = Fastify({ logger: false });
    const law = installRouteLawHook(instance);
    instance.get('/api/leak', () => ({ ok: true }));

    await expect(instance.ready()).resolves.toBeDefined();
    expect(law.violations).toHaveLength(1);
    await instance.close();
  }, 2_000);

  it('is installed by buildApp, so a legal app boots and is checked', async () => {
    const instance = await app();
    expect(instance.hasRoute({ method: 'GET', url: '/_public/api/countries' })).toBe(true);
  });
});
