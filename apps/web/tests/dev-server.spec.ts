import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

import { createDevProxy } from '../dev-proxy.ts';

/**
 * The dev server, booted for real (`P1-WEB-08`).
 *
 * The acceptance criterion is a sentence about behaviour — *"`bun run dev` talks to local API"* — and the unit tests in
 * `dev-proxy.spec.ts` only describe the config object. This file starts an actual **Vite dev server** with the real proxy
 * map, a stub API behind it, and asks it the three questions a browser asks:
 *
 * 1. does an API path reach the API, with its query string and its client address intact?
 * 2. does the **login page** stay a page — the trap that `09-development.md` §3 names, where proxying `/_auth` sends the
 *    login screen to the API and works everywhere except development?
 * 3. when the API is not running, does the developer read a sentence instead of `ECONNREFUSED ::1:3000`?
 *
 * Ports are ephemeral (`port: 0`, and the stub binds `0` too), so this cannot collide with a dev server the developer
 * already has running, and it finishes in about a second and a half.
 */

/** Root served by the test server: a fixture page, so nothing under `src/` is compiled for this. */
const ROOT = resolve(import.meta.dirname, 'fixtures/dev-server');

/** Requests the stub API received. */
interface Seen {
  readonly url?: string;
  readonly forwardedFor?: string;
  readonly forwardedHost?: string;
}

let api: HttpServer;
let vite: ViteDevServer;
let base = '';
let seen: Seen = {};

/** The port the stub API picked. */
function stubPort(): number {
  const address = api.address();
  if (address === null || typeof address === 'string') throw new Error('the stub API has no port');
  return address.port;
}

/**
 * A URL on the test server.
 *
 * `base` already ends in `/`, and Vite matches proxy contexts with `startsWith`, so a second slash would turn
 * `/_auth/api/me` into `//_auth/api/me`: no context matches, the SPA fallback answers `200 text/html`, and the test would
 * be reading an index page while believing it read the API. One join, one place.
 *
 * @param path - Server-absolute path, starting with `/`.
 * @returns The absolute URL to fetch.
 */
function url(path: string): string {
  return `${base}${path.slice(1)}`;
}

/**
 * Boots a Vite dev server whose proxy points at `port`.
 *
 * @param port - The stub API's port, passed the way a developer passes it: `PORT`.
 * @returns The running server; the caller closes it.
 */
async function startVite(port: number): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      // Ephemeral: a test must not fight the developer's own `bun run dev` for 5173.
      port: 0,
      proxy: createDevProxy({ env: { PORT: String(port) }, log: () => undefined }),
    },
  });
  await server.listen();
  const local = server.resolvedUrls?.local?.[0];
  if (local === undefined) throw new Error('the test server did not report a URL');
  // `url()` below relies on this trailing slash, so check the assumption where it is made.
  if (!local.endsWith('/'))
    throw new Error(`the test server reported ${local}, which does not end in '/'`);
  base = local;
  return server;
}

beforeAll(async () => {
  api = createHttpServer((request, response) => {
    seen = {
      ...(request.url === undefined ? {} : { url: request.url }),
      ...(request.headers['x-forwarded-for'] === undefined
        ? {}
        : { forwardedFor: String(request.headers['x-forwarded-for']) }),
      ...(request.headers['x-forwarded-host'] === undefined
        ? {}
        : { forwardedHost: String(request.headers['x-forwarded-host']) }),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((done) => {
    api.listen(0, '127.0.0.1', done);
  });

  vite = await startVite(stubPort());
});

afterAll(async () => {
  await vite?.close();
  await new Promise<void>((done) => {
    api?.close(() => {
      done();
    });
  });
});

describe('an API path', () => {
  it('reaches the API unchanged, with its query string and its client address', async () => {
    // No rewrite, and `xfwd` on: the path is the API's contract (`04-api.md` §0), and the address is what the API's rate
    // limiting keys on — a proxy that dropped it would make every development request look like it came from the dev
    // server, which is a key production never produces.
    const response = await fetch(url('/_auth/api/login?next=%2F_site%2Fadmin%2F'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen.url).toBe('/_auth/api/login?next=%2F_site%2Fadmin%2F');
    expect(seen.forwardedFor).toBeTruthy();
    expect(seen.forwardedHost).toContain('127.0.0.1');
  });

  it('covers every namespace and both probes', async () => {
    for (const path of [
      '/_auth/api/me',
      '/_admin/api/catalog',
      '/_public/api/countries',
      '/healthz',
      '/readyz',
    ]) {
      seen = {};
      const response = await fetch(url(path));

      expect(response.status, path).toBe(200);
      expect(seen.url, path).toBe(path);
    }
  });
});

describe('a page', () => {
  it('is served by Vite, not forwarded to the API', async () => {
    // The documented trap: proxying `/_auth` would send the login page to the API, where it 404s — in development only.
    seen = {};
    const response = await fetch(url('/_auth/login'));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('this page came from vite');
    expect(seen.url, 'the login page must never reach the API').toBeUndefined();
  });

  it('sends the site root and its pages to Vite too', async () => {
    for (const path of ['/', '/_site/', '/_site/admin/cache']) {
      seen = {};
      const response = await fetch(url(path));

      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain('this page came from vite');
      expect(seen.url, path).toBeUndefined();
    }
  });
});

describe('when the API is not running', () => {
  it('answers with a sentence and the command that starts it', async () => {
    // The developer's likely first failure: the web half is up and the API is not. Vite's default is a bare `502` with an
    // empty body and a stack trace in the terminal.
    const port = stubPort();
    await new Promise<void>((done) => {
      api.close(() => {
        done();
      });
    });

    const response = await fetch(url('/_auth/api/me'));
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain(`http://127.0.0.1:${String(port)}`);
    expect(body).toContain('bun run dev:api');
  });
});
