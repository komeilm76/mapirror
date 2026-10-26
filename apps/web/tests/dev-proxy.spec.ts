import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { API_PREFIXES, PROBE_PATHS } from '@mapirror/shared';
import { describe, expect, it } from 'vitest';

import {
  apiPortFrom,
  createDevProxy,
  DEFAULT_API_PORT,
  devApiOrigin,
  PROXY_CONTEXTS,
} from '../dev-proxy';
import { LOGIN_PAGE } from '../src/router/paths';
import { APP_ROUTES } from '../src/router/routes';

/**
 * The development proxy (`P1-WEB-08`).
 *
 * The three failures this file exists to prevent are all invisible in a browser:
 *
 * 1. **A page prefix in the list.** Vite matches a string context with `startsWith`, so proxying `/_auth` sends the login
 *    **page** to the API — a `404` in development and a working page in production, where nginx splits them.
 * 2. **A rewrite.** The API serves `/_auth/api/login`; a proxy that strips the prefix produces `404`s that read like
 *    missing routes.
 * 3. **A target nothing listens on.** A wrong port is `ECONNREFUSED` from the proxy while `curl :3000` answers.
 *
 * The last group asserts the error path a developer actually meets: the API stopped, the page loads, and the request has
 * to say so in words.
 */

/** A fake http-proxy server that records the listener Vite would call. */
function fakeProxyServer(): {
  server: { on: (event: string, listener: (...args: unknown[]) => void) => void };
  emit: (error: unknown, request: unknown, response: unknown) => void;
} {
  let listener: ((...args: unknown[]) => void) | undefined;
  return {
    server: {
      on: (event, handler) => {
        if (event === 'error') listener = handler;
      },
    },
    emit: (error, request, response) => {
      listener?.(error, request, response);
    },
  };
}

/** A response good enough for the error handler, recording what was written. */
function fakeResponse(): {
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body?: string) => void;
  headersSent: boolean;
  writableEnded: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
} {
  const res = {
    headersSent: false,
    writableEnded: false,
    status: undefined as number | undefined,
    headers: undefined as Record<string, string> | undefined,
    body: undefined as string | undefined,
    writeHead(status: number, headers: Record<string, string>): void {
      res.status = status;
      res.headers = headers;
      res.headersSent = true;
    },
    end(body?: string): void {
      res.body = body;
      res.writableEnded = true;
    },
  };
  return res;
}

describe('which requests are forwarded', () => {
  it('forwards exactly the API namespaces and the two probes', () => {
    // Built from `@mapirror/shared` rather than spelled out, so the proxy cannot drift from the route law (`04-api.md`
    // §0): adding a namespace is a change in one place, and this test is what proves the two agree.
    expect(PROXY_CONTEXTS).toEqual([...API_PREFIXES, PROBE_PATHS.health, PROBE_PATHS.ready]);
    expect(Object.keys(createDevProxy({ env: {} }))).toEqual([...PROXY_CONTEXTS]);
  });

  it('never forwards a page path', () => {
    // The trap: `/_auth` would send the login page to the API. Vite's context match is `startsWith`, so the only safe
    // rule is "no page path begins with a context" — checked against the SPA's own route table, which is what a future
    // page would be added to.
    const pagePaths = [
      LOGIN_PAGE,
      ...APP_ROUTES.map((route) => route.path).filter((path) => path !== undefined),
      // Paths the router redirects to and the static server must render for itself.
      '/',
      '/index.html',
      '/_site/administrators',
    ];

    for (const page of pagePaths) {
      for (const context of PROXY_CONTEXTS) {
        expect(
          page.startsWith(context),
          `${page} must not be swallowed by the ${context} proxy`,
        ).toBe(false);
      }
    }
  });

  it('names the login page as the case the exclusion protects, not the API', () => {
    expect(LOGIN_PAGE.startsWith('/_auth')).toBe(true);
    expect(LOGIN_PAGE.startsWith('/_auth/api')).toBe(false);
    expect(PROXY_CONTEXTS).not.toContain('/_auth');
  });
});

describe('where it forwards to', () => {
  it('defaults to the API port and the loopback literal', () => {
    // `127.0.0.1`, not `localhost`: the API binds `HOST=0.0.0.0`, which is IPv4-only, and a resolver that answers `::1`
    // first is a proxy that refuses a connection to a server that is running.
    expect(apiPortFrom({})).toBe(DEFAULT_API_PORT);
    expect(DEFAULT_API_PORT).toBe(3000);
    expect(devApiOrigin({})).toBe('http://127.0.0.1:3000');
  });

  it('follows the API variable, so one setting moves both halves', () => {
    // `PORT` is the API's own variable (`09-development.md` §5): `PORT=4000 bun run dev` starts both on 4000.
    expect(apiPortFrom({ PORT: '4000' })).toBe(4000);
    expect(devApiOrigin({ PORT: ' 4000 ' })).toBe('http://127.0.0.1:4000');
    // An empty value in a copied `.env` means "not set", not "port zero".
    expect(apiPortFrom({ PORT: '' })).toBe(DEFAULT_API_PORT);
    expect(apiPortFrom({ PORT: '   ' })).toBe(DEFAULT_API_PORT);
  });

  it('refuses a port that is not one, naming the variable', () => {
    // The API refuses to boot on the same input (`apps/api/src/config/env.ts`); a proxy that quietly used 3000 would run
    // against a server that is not there, and the error would arrive later and name neither the variable nor the value.
    for (const bad of ['0x10', '30e3', '3000.5', '-1', '0', '65536', 'http://3000', 'abc']) {
      expect(() => apiPortFrom({ PORT: bad }), bad).toThrow(/PORT/u);
    }
    expect(() => apiPortFrom({ PORT: '70000' })).toThrow(/between 1 and 65535/u);
  });

  it('forwards the path unchanged, and forwards the client address', () => {
    // No `rewrite`: the API serves these exact paths. `xfwd` is on because the API trusts a loopback peer by default
    // (`TRUST_PROXY=loopback`), so a rate limit keyed on the client address sees the browser's address as it does behind
    // nginx — not one address for the whole dev machine.
    for (const entry of Object.values(createDevProxy({ env: {} }))) {
      expect(entry).not.toHaveProperty('rewrite');
      expect(entry.target).toBe('http://127.0.0.1:3000');
      expect(entry.changeOrigin).toBe(true);
      expect(entry.xfwd).toBe(true);
    }
  });
});

describe('when the API is not running', () => {
  /** Builds a proxy whose single entry is configured, and returns the emitter plus the log. */
  function withErrorHandler(): {
    emit: (error: unknown, response: unknown) => void;
    logged: string[];
  } {
    const logged: string[] = [];
    const entry = createDevProxy({ env: { PORT: '4123' }, log: (line) => logged.push(line) });
    const { server, emit } = fakeProxyServer();
    Object.values(entry)[0]?.configure?.(server);
    return {
      emit: (error, response) => {
        emit(error, { url: '/_auth/api/login' }, response);
      },
      logged,
    };
  }

  it('answers with a sentence and the command that fixes it', () => {
    // What a developer meets with `bun run dev:api` not started. Vite's own handler answers a bare `502` with an empty
    // body and prints a stack — true, and useless.
    const { emit, logged } = withErrorHandler();
    const response = fakeResponse();

    emit({ code: 'ECONNREFUSED' }, response);

    expect(response.status).toBe(502);
    expect(response.headers?.['content-type']).toContain('text/plain');
    expect(response.body).toContain('http://127.0.0.1:4123');
    expect(response.body).toContain('bun run dev:api');
    expect(logged.join('\n')).toContain('ECONNREFUSED');
    expect(logged.join('\n')).toContain('bun run dev:api');
  });

  it('does not invent an error envelope for a tool that is not the API', () => {
    // `04-api.md` §0.2 is the API's contract. A development proxy that minted a code from it would be inventing server
    // behaviour — and a screen under test would start handling a code production never sends.
    const { emit } = withErrorHandler();
    const response = fakeResponse();

    emit({ code: 'ECONNREFUSED' }, response);

    expect(response.body ?? '').not.toContain('"error"');
    expect((): unknown => JSON.parse(response.body ?? 'null')).toThrow();
  });

  it('says something when the error carries no code', () => {
    const { emit, logged } = withErrorHandler();
    const response = fakeResponse();

    emit(new Error('socket hang up'), response);

    expect(logged.join('\n')).toContain('the connection failed');
    expect(response.status).toBe(502);
  });

  it('leaves a response alone once it has started, and copes with no response at all', () => {
    // A websocket upgrade has no response object, and a stream that has already sent its headers cannot be re-headed.
    const { emit } = withErrorHandler();

    const started = fakeResponse();
    started.headersSent = true;
    expect(() => {
      emit({ code: 'ECONNRESET' }, started);
    }).not.toThrow();
    expect(started.status).toBeUndefined();

    const finished = fakeResponse();
    finished.writableEnded = true;
    expect(() => {
      emit({ code: 'ECONNRESET' }, finished);
    }).not.toThrow();
    expect(finished.status).toBeUndefined();

    expect(() => {
      emit({ code: 'ECONNRESET' }, undefined);
    }).not.toThrow();
  });
});

describe('the config the app ships with', () => {
  it('wires the proxy into both the dev server and the preview server', async () => {
    // `vite preview` serves the built bundle, and a preview without the proxy is a build that appears broken: every API
    // call 404s against the static server. The config is imported rather than read as text, so this is the object Vite
    // gets.
    // `defineConfig` returns the object itself here (no function form is used), so this is exactly what Vite receives.
    const { default: config } = await import('../vite.config');

    expect(Object.keys(config.server?.proxy ?? {})).toEqual([...PROXY_CONTEXTS]);
    expect(Object.keys(config.preview?.proxy ?? {})).toEqual([...PROXY_CONTEXTS]);
  });

  it('keeps every entry pointed at one origin', async () => {
    const { default: config } = await import('../vite.config');
    // Every entry is a `ProxyOptions` object (`dev-proxy.ts` never uses Vite's string shorthand).
    const entries = Object.values(config.server?.proxy ?? {});
    const targets = new Set(
      entries.map((entry) => (typeof entry === 'string' ? entry : entry.target)),
    );

    expect(targets.size).toBe(1);
    expect([...targets][0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  it('is what the documented dev flow describes', () => {
    // `09-development.md` §3 lists the five paths a developer should expect to see forwarded. If that list changes, one
    // of these two files is wrong, and this is where it is noticed.
    const doc = readFileSync(
      resolve(import.meta.dirname, '../../../docs/09-development.md'),
      'utf8',
    );
    for (const context of PROXY_CONTEXTS) {
      expect(doc, `${context} must be documented`).toContain(context);
    }
    expect(doc).toMatch(/Proxying bare `\/_auth` would send the \*\*login page\*\*/u);
  });
});
