/**
 * The dev server's proxy to the API (`P1-WEB-08`).
 *
 * In development the SPA is served by Vite on `:5173` and the API listens on `:3000`, so every API call the browser makes
 * has to be forwarded. This module is that forwarding, and it exists as a module rather than three lines inside
 * `vite.config.ts` because the three things that can go wrong here are all silent:
 *
 * | Trap | What it looks like | Here |
 * |---|---|---|
 * | Proxying `/_auth` instead of `/_auth/api` | the **login page** request goes to the API and `404`s in dev while working in production, where nginx splits the two | the contexts are the API prefixes from `@mapirror/shared`, never a bare page prefix |
 * | A rewrite that "nicer" paths | the API serves `/_auth/api/login`; stripping the prefix would produce `404`s that look like missing routes | no `rewrite`: every path arrives exactly as the browser sent it |
 * | The target's host resolving to a different address family than the API bound | `ECONNREFUSED` from the proxy while the API is plainly listening ("it works in curl") | the loopback **literal**, `127.0.0.1`, so no resolver is involved |
 *
 * Vite matches a string context with `startsWith` (`createProxyContextMatcher` in `node.js`), which is why the contexts
 * below are complete API prefixes: a context that is a *page* prefix would swallow pages, and a context that is a prefix
 * of one — `/_public/api` matching a hypothetical `/_public/apiary` page — would too. `tests/dev-proxy.spec.ts` walks the
 * SPA's own route table and fails if any page path begins with a proxy context, so that mistake cannot be made by adding
 * a page later.
 *
 * ## The port comes from the API's own variable
 *
 * `PORT` is the API's (`09-development.md` §5), and the proxy reads the same variable, so `PORT=4000 bun run dev` moves
 * both halves at once. A value that is not a port is an error here for the same reason it is one there: a proxy aimed at
 * a port nobody is bound to looks healthy and answers nothing.
 *
 * @module dev-proxy
 */

/** The API's default port, the same number `apps/api/src/config/env.ts` falls back to. */
export const DEFAULT_API_PORT = 3000;

/**
 * The paths Vite forwards to the API.
 *
 * The three JSON namespaces plus the two probes — **not** `/_auth`, `/_site` or `/` — because everything else is a page
 * this server renders.
 *
 * ## Why the list is written out instead of imported
 *
 * The obvious version is `[...API_PREFIXES, PROBE_PATHS.health, PROBE_PATHS.ready]` from `@mapirror/shared`, and it does
 * not work. The failure looks like a broken checkout: Vite's config loader bundles the config but leaves packages in
 * `node_modules` **external**, and the workspace package is one of them — so the config is bundled, `@mapirror/shared` is
 * loaded by Node's own ESM resolver at runtime, and its source uses extensionless relative imports (`export * from
 * './auth'`) that Node cannot resolve. Both halves of `bun run dev` then disagree: the API starts, and the dev server
 * exits with `ERR_MODULE_NOT_FOUND: Cannot find module '…/packages/shared/src/auth'` (measured; introduced by this task's
 * first draft and caught by an end-to-end probe, not by a unit test).
 *
 * So the list is a literal, and `tests/dev-proxy.spec.ts` — which runs where the workspace package *can* be imported —
 * asserts it equals `[...API_PREFIXES, PROBE_PATHS.health, PROBE_PATHS.ready]`. Adding a namespace to the route law fails
 * that test until this list follows, which is the guarantee an import would have given, for the price of one constant.
 */
export const PROXY_CONTEXTS: readonly string[] = [
  '/_auth/api',
  '/_admin/api',
  '/_public/api',
  '/healthz',
  '/readyz',
];

/**
 * Reads the API port from an environment.
 *
 * @param env - The environment to read; `process.env` in the config, a literal in a test.
 * @returns The port, defaulting to {@link DEFAULT_API_PORT} when the variable is absent or empty (an empty `PORT` in a
 * copied `.env` means "not set", not "port zero").
 * @throws {Error} When the variable is present and is not a port — the API refuses to boot on the same input, and a proxy
 * pointed at a port nothing listens on fails later with a message that names neither the variable nor the value.
 */
export function apiPortFrom(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['PORT']?.trim() ?? '';
  if (raw === '') return DEFAULT_API_PORT;

  // `Number('3e3')` is 3000 and `Number(' 3000 ')` is 3000, so the parse is on the raw string: digits only, no sign, no
  // exponent, no decimal point.
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`PORT must be a whole number between 1 and 65535, got "${raw}".`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65_535) {
    throw new Error(`PORT must be between 1 and 65535, got "${raw}".`);
  }
  return port;
}

/**
 * The origin the proxy forwards to.
 *
 * `127.0.0.1` rather than `localhost`: both work on a machine whose resolver answers `::1` and whose client tries both
 * addresses, but only the literal removes the resolver from the question — and an API bound with `HOST=0.0.0.0` is
 * IPv4-only, so a resolver that answers `::1` first is a proxy that refuses a connection to a server that is running.
 *
 * @param env - The environment to read.
 * @returns An origin with no trailing slash, e.g. `http://127.0.0.1:3000`.
 */
export function devApiOrigin(env: Readonly<Record<string, string | undefined>>): string {
  return `http://127.0.0.1:${String(apiPortFrom(env))}`;
}

/** What a proxy entry needs; a subset of Vite's `ProxyOptions`, which is what the return value satisfies. */
export interface DevProxyEntry {
  readonly target: string;
  readonly changeOrigin: boolean;
  /** Adds `X-Forwarded-*`, so the API sees the browser's address the way it does behind nginx. */
  readonly xfwd: boolean;
  readonly configure?: (proxy: DevProxy) => void;
}

/** The one method this module uses on http-proxy's server. */
export interface DevProxy {
  on(event: 'error', listener: (error: unknown, request: unknown, response: unknown) => void): void;
}

/** What the error handler needs from the node response it writes to. */
interface WritableResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
}

/**
 * Builds Vite's `proxy` map.
 *
 * @param options - `env` (defaults to `process.env`) and, for tests, a `log` sink for the one line the error handler
 * writes to the terminal.
 * @returns One entry per {@link PROXY_CONTEXTS} key, all pointing at the API.
 */
export function createDevProxy(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly log?: (message: string) => void;
  } = {},
): Record<string, DevProxyEntry> {
  const env = options.env ?? process.env;
  const origin = devApiOrigin(env);
  const log = options.log ?? ((message: string): void => console.warn(message));

  const proxy: Record<string, DevProxyEntry> = {};
  for (const context of PROXY_CONTEXTS) {
    proxy[context] = {
      target: origin,
      // The API does not read `Host`, but rewriting it keeps a request the same shape as the one nginx forwards.
      changeOrigin: true,
      // Vite's proxy does **not** add `X-Forwarded-For` unless asked, and the API trusts a loopback peer by default
      // (`TRUST_PROXY=loopback`), so with this on the API sees the browser's address exactly as it does in production.
      // Without it every request in development looks like it came from the dev server, and a rate limit keyed on the
      // client address is exercised with one key that production never sees.
      xfwd: true,
      configure: (server): void => {
        server.on('error', (error, _request, response) => {
          // Vite's own handler answers a bare `502` with an empty body and prints a stack. A developer with the API
          // stopped should read a sentence that names the button to press, not `ECONNREFUSED ::1:3000`.
          const res = response as WritableResponse | undefined;
          const code = (error as { code?: unknown } | null)?.code;
          const reason = typeof code === 'string' ? code : 'the connection failed';
          log(
            `[mapirror] the API at ${origin} did not answer (${reason}). Start it with \`bun run dev:api\`.`,
          );
          if (res === undefined || res.headersSent || res.writableEnded) return;
          // `502`, not `503`: the dev server is fine and the thing it forwards to is not — which is what a gateway
          // failure means, and what Vite's own handler would have answered. The body is plain text on purpose: the error
          // envelope in `04-api.md` §0.2 is the **API's** contract, and a development tool that minted a code from it
          // would be inventing server behaviour. The sentence is still readable in the browser's network panel, and the
          // line above is in the terminal where the developer is already looking.
          res.writeHead(502, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(`The API at ${origin} is not answering. Start it with \`bun run dev:api\`.`);
        });
      },
    };
  }
  return proxy;
}
