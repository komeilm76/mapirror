import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../../apps/api/src/plugins/security';
import {
  API_PREFIXES,
  LOGIN_PAGE_PATH,
  PROBE_PATHS,
  SITE_ROOT_PATH,
} from '../../packages/shared/src/routes';

/**
 * Where `docker/nginx.conf` sends each kind of request (task `P1-DOCK-03`).
 *
 * The route law (`10-laws.md`, L1) says the API serves exactly three prefixes and two probes, the SPA serves everything
 * under `/_site/` plus one login page, and `/` redirects. That law is now enforced in **three** places — the Fastify route
 * table, the Vite dev proxy (`apps/web/dev-proxy.ts`) and this file — which is exactly why the prefixes are compared to
 * `@mapirror/shared` here rather than written out again: a fourth namespace, or a probe that moves, has to be added in one
 * place and will fail these cases until the other two follow.
 *
 * The interesting failures are all ordering or precedents:
 *
 * | Mistake | What a visitor sees |
 * |---|---|
 * | the SPA fallback above the API locations | `GET /_auth/api/me` answered with `index.html` and a `200` — a login screen instead of a session |
 * | `try_files /index.html =404` in the login location | the page renders, with **no** CSP and no `Cache-Control` — measured, pass 40 |
 * | `location /` falling back to the shell | every typo in an asset name returns HTML, which the browser reports as a syntax error |
 * | `/_site` (no slash) reaching the assets rule | a `404` for a URL a reader typed |
 * | `expires` on the shell | a deploy nobody sees: the browser keeps last month's `index.html` for a year |
 *
 * Measured against a real nginx 1.29.0 with this exact file (pass 40): `/` → `302`, `/_site/admin/cache/finland` → `200`
 * `text/html` with the shell's six headers and `Cache-Control: no-cache`, `/_auth/login` → the same, `/assets/*.js` →
 * `Cache-Control: max-age=31536000`, an unknown path → `404`, and `/_auth/api/me` → the API's own `401` envelope.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The file these cases describe. */
const CONFIG = 'docker/nginx.conf';

/** Its contents, comments removed — a comment must never satisfy an assertion. */
const withoutComments = readFileSync(join(ROOT, CONFIG), 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*$/u, '').trimEnd())
  .join('\n');

/** One `location` block, as written. */
interface Location {
  /** The modifier (`=`, `^~`, `~`, `~*`) or an empty string. */
  readonly modifier: string;
  /** The path or pattern. */
  readonly path: string;
  /** The block's body, comments stripped. */
  readonly body: string;
  /** The whole `location …` line, for order comparisons. */
  readonly line: string;
}

/**
 * Collects every `location` block, in file order.
 *
 * Every block in this file is flat and brace-balanced, so a counter is enough — and if it were not, the `braces and
 * semicolons` case in `nginx-conf.spec.ts` fails first.
 *
 * @returns One entry per block, in the order they appear.
 */
function locations(): Location[] {
  const blocks: Location[] = [];
  const pattern = /^(\s*)location\s+(?:(\S+)\s+)?(\S+)\s*\{$/u;
  const lines = withoutComments.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index] as string);
    if (match === null) continue;
    const body: string[] = [];
    let depth = 1;
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const line = lines[inner] as string;
      depth += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length;
      if (depth === 0) break;
      body.push(line);
    }
    const modifier = (match[2] ?? '').trim();
    blocks.push({
      modifier,
      path: (match[3] ?? '').trim(),
      body: body.join('\n'),
      line: (lines[index] as string).trim(),
    });
  }
  return blocks;
}

/** The `location` with a given path, or a helpful failure. */
function locationFor(path: string, modifier?: string): Location {
  const normalise = (value: string): string => value.replace(/\/+$/u, '') || '/';
  const found = locations().find(
    (block) =>
      normalise(block.path) === normalise(path) &&
      (modifier === undefined || block.modifier === modifier),
  );
  if (found === undefined) {
    throw new Error(
      `no location for ${modifier ?? ''} ${path}; the file has: ${locations()
        .map((block) => `${block.modifier} ${block.path}`.trim())
        .join(', ')}`,
    );
  }
  return found;
}

/** The five API locations, by their path. */
const API_LOCATIONS = [...API_PREFIXES, PROBE_PATHS.health, PROBE_PATHS.ready];

/** `proxy_pass` targets, in the order they appear. */
function proxyTargets(): string[] {
  return [...withoutComments.matchAll(/proxy_pass\s+(\S+);/gu)].map((match) => match[1] as string);
}

describe('the API locations', () => {
  it('are exactly the three prefixes and the two probes, and nothing else', () => {
    // One list, three implementations: this compares nginx's to the shared route law, the way `dev-proxy.spec.ts` does for
    // Vite. A probe added to `PROBE_PATHS` fails here until nginx serves it.
    const proxied = locations()
      .filter((block) => block.body.includes('proxy_pass'))
      .map((block) => block.path.replace(/\/+$/u, ''));

    expect(proxied.sort()).toEqual([...API_LOCATIONS].sort());
    expect(API_LOCATIONS).toEqual([
      '/_auth/api',
      '/_admin/api',
      '/_public/api',
      '/healthz',
      '/readyz',
    ]);
  });

  it('use the modifier each kind of path needs', () => {
    // `^~` for a namespace: a prefix that a later regex location must not be able to take back. `=` for a probe: the whole
    // path, so `/_auth/apix` is not mistaken for the API.
    for (const prefix of API_PREFIXES) {
      expect(locationFor(prefix).modifier, prefix).toBe('^~');
    }
    for (const probe of Object.values(PROBE_PATHS)) {
      expect(locationFor(probe).modifier, probe).toBe('=');
    }
  });

  it('forward to the API container, with the path untouched', () => {
    // No URI part in `proxy_pass`: with one, nginx would replace the matched prefix and every route would 404. The API
    // serves `/_auth/api/login`; a proxy that "helpfully" stripped the prefix would serve `/login`.
    for (const target of proxyTargets()) expect(target).toBe('http://api:3000');
    expect(withoutComments).not.toMatch(/proxy_pass\s+http:\/\/api:3000\//u);
    expect(withoutComments).not.toMatch(/^\s*rewrite\s/mu);
  });

  it('cannot be shadowed by a regex location later in the file', () => {
    // Line order alone buys nothing — nginx picks the longest matching **prefix** whatever the order they are written in,
    // and `/_auth/api/…` can never equal `/_auth/login`. What buys something is the modifier and the absence of regex
    // locations: a `~` location is consulted before any plain-prefix location, so one regex rule added for a page would
    // silently swallow the API namespaces. `^~` is what takes that weapon away — which is why the rule here is about
    // modifiers, not about which block comes first.
    const rules = locations();

    for (const block of rules) {
      if (block.path === '/') continue; // the catch-all is deliberately a plain prefix
      expect(['=', '^~'], `${block.path} must be exact or sticky-prefix`).toContain(block.modifier);
    }
    expect(withoutComments, 'no regex location may be declared').not.toMatch(/^\s*location\s+~/mu);
  });
});

describe('the pages', () => {
  it('send `/` and `/_site` to the one canonical address, keeping the query string', () => {
    // L1: `/` is not a page. A redirect keeps one address for the catalog, so bookmarks and shared links agree.
    //
    // `$is_args$args` is the half that is easy to leave out and hard to notice: `return` writes the target literally, so
    // `/?utm_source=newsletter` reached `/_site/` with the campaign dropped (measured against a real nginx, pass 41).
    // Asserted as a pair — a redirect that loses the arguments is a redirect that rewrites the link someone shared.
    expect(locationFor('/', '=').body).toContain(`return 302 ${SITE_ROOT_PATH}$is_args$args;`);
    // `/_site` without the slash is a typed URL, not a missing file: a permanent redirect is the friendly answer.
    expect(locationFor('/_site').body).toContain(`return 301 ${SITE_ROOT_PATH}$is_args$args;`);
  });

  it('serve the SPA for a deep link', () => {
    // `/_site/admin/cache/finland` is a Vue route, not a file. The fallback has to be a **URI** (the last argument), so
    // nginx resolves it again and the request picks up the `/index.html` location's headers; `=404` there would be a
    // reload that 404s.
    const site = locationFor(SITE_ROOT_PATH, '^~');

    expect(site.modifier).toBe('^~');
    expect(site.body).toContain('try_files $uri /index.html;');
  });

  it('serve the login page as the shell too — with the shell’s headers', () => {
    // Measured, pass 40: `try_files /index.html =404` serves the file *inside this location*, with no CSP and no
    // `Cache-Control`. The last argument must be the URI, exactly as the `/_site/` case is.
    const login = locationFor(LOGIN_PAGE_PATH);

    expect(login.modifier).toBe('=');
    expect(login.body).toContain('try_files $uri /index.html;');
    expect(login.body, 'the file-serving form would skip the shell location').not.toMatch(
      /try_files\s+\S*\/index\.html\s+=/u,
    );
    // The location that does attach them exists, and is matched by the internal redirect above.
    expect(locationFor('/index.html')).toBeDefined();
  });

  it('404 an unknown path instead of rendering the app', () => {
    // `/assets/nope.js` must be a 404: answering it with `index.html` makes the browser report a syntax error in a script,
    // which is a support ticket that names the wrong thing.
    const catchAll = locationFor('/', '');

    expect(catchAll.modifier).toBe('');
    expect(catchAll.body).toContain('try_files $uri =404;');
    expect(catchAll.body).not.toContain('index.html');
  });
});

describe('the shell’s headers', () => {
  it('carry the six from the security document', () => {
    // The API sets these on its responses; a static file cannot, so nginx sets them on the one HTML document. The list is
    // imported from the API's own plugin, so the two cannot drift.
    const shell = locationFor('/index.html').body;

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (name === 'content-security-policy') continue; // asserted below, one directive at a time
      expect(shell.toLowerCase(), `${name} must be on the shell`).toContain(
        `add_header ${name} "${value}";`.toLowerCase(),
      );
    }
    expect(Object.keys(SECURITY_HEADERS)).toHaveLength(6);
  });

  it('carry the policy the API states, bar the directive that needs https', () => {
    const shell = locationFor('/index.html').body;
    const csp = /add_header Content-Security-Policy "([^"]*)"/u.exec(shell)?.[1] ?? '';

    // The API's value is the source of truth (`14-security.md` §6). nginx's copy is that string split in two: the base,
    // and the one directive that is conditional.
    expect(CONTENT_SECURITY_POLICY.endsWith('; upgrade-insecure-requests')).toBe(true);
    const base = CSP_EXPECTED_BASE();
    expect(base).toBe(CONTENT_SECURITY_POLICY.replace(/; upgrade-insecure-requests$/u, ''));
    expect(csp).toBe(`${base}$mm_csp_upgrade`);
  });

  it('add `upgrade-insecure-requests` only when the browser is on https', () => {
    // The directive rewrites every http subresource to https. Behind the TLS proxy that is right; on the documented first
    // run (`docker compose up` → `http://localhost:8080`) it upgrades the bundle to a port with no TLS and the page stays
    // blank. Measured both ways against a real nginx (pass 40): with `X-Forwarded-Proto: https` the header gains the
    // directive, without it the header does not have it.
    expect(withoutComments).toMatch(/map \$http_x_forwarded_proto \$mm_csp_upgrade \{/u);
    expect(withoutComments).toContain('default "";');
    expect(withoutComments).toContain('https "; upgrade-insecure-requests";');
  });

  it('are the shell’s only, because a proxied response brings its own', () => {
    // `add_header` in a location replaces what the enclosing block would add — so a copy at `server` level would put a
    // *second* CSP on every API response, and two policies are enforced as their intersection. The API's own header must
    // be the only one on its responses (measured: exactly one `content-security-policy` on `/_auth/api/me`).
    const outsideLocations = withoutComments.replace(
      /^\s*location\s[^\n]*\{[\s\S]*?^\s*\}$/gmu,
      '',
    );

    expect(outsideLocations).not.toContain('add_header');
  });
});

describe('the cache policy', () => {
  it('never caches the shell', () => {
    // The file whose name does not change between deploys. `expires -1` is `Cache-Control: no-cache`, so the browser
    // revalidates and a deploy is visible on the next reload (measured: `If-None-Match` → `304`).
    const shell = locationFor('/index.html').body;

    expect(shell).toContain('expires -1;');
    expect(shell).not.toContain('expires 1y');
    expect(shell).not.toMatch(/max-age=[1-9]/u);
  });

  it('caches the bundle for a year', () => {
    // Vite names every file by content hash, so a year is honest and a new build is a new URL.
    const assets = locationFor('/assets/');

    expect(assets.modifier).toBe('^~');
    expect(assets.body).toContain('expires 1y;');
    // A script or stylesheet still needs `nosniff`; CSP on a `.js` response would mean nothing.
    expect(assets.body).toContain('add_header X-Content-Type-Options "nosniff";');
    expect(assets.body).not.toContain('Content-Security-Policy');
  });

  it('leaves the proxied responses’ caching to the API', () => {
    // `cache-control: no-store` on the auth namespace is the API's own hook (`14-security.md` §4); a header here would
    // either duplicate it or contradict it.
    for (const path of API_LOCATIONS) {
      expect(locationFor(path).body, path).not.toContain('expires');
    }
  });
});

describe('the documented routing table', () => {
  it('is what the deployment guide tells an operator to expect', () => {
    const guide = readFileSync(join(ROOT, 'docs/12-deployment.md'), 'utf8');

    // The guide's snippet is the file's map in miniature, so the check is parity, not presence: every location the file
    // declares has to appear in the guide's `nginx` block, and the guide may not invent one the file lacks. Both halves
    // matter — a guide missing `/assets/` describes a container that does not exist, and a guide with a location the file
    // never had sends the reader off to edit something that is not there. (Before pass 40 this block taught the
    // `try_files /index.html =404` form, i.e. the header bug itself.)
    const snippet = guideNginxBlock();
    const documented = [...snippet.matchAll(/location\s+(?:[=^~]+\s*)?([^\s{]+)\s*\{/gu)].map(
      (match) => (match[1] as string).replace(/\/+$/u, '') || '/',
    );
    const declared = locations().map((block) => block.path.replace(/\/+$/u, '') || '/');

    expect(new Set(documented)).toEqual(new Set(declared));
    // The snippet's two redirects are the lines an operator copies, and the one that went wrong is invisible without the
    // variable: a documented `return 302 /_site/;` teaches the version that drops the query string.
    expect(
      snippet.match(/\$is_args\$args/gu),
      'both redirects keep the query string in the guide too',
    ).toHaveLength(2);
    // …and the snippet has to say which file it is a map *of*, or the reader cannot tell what to edit.
    expect(guide).toContain('`docker/nginx.conf` is that container');
  });

  it('tells the operator what a proxied client address needs — and that a preset replaces the default', () => {
    // With `TRUST_PROXY=loopback` (the default) the API does not trust the web container's address, so every visitor looks
    // like the proxy — the rate limiter then has one key for the whole internet. The guide has to say so, and name the value
    // that fixes it: a note saying "set TRUST_PROXY" without a private range leaves the operator choosing between `true`
    // (trusts anything) and the default (fixes nothing).
    //
    // The first version of this case asserted `TRUST_PROXY=uniquelocal` alone, which is what the guide recommended and
    // what a real API measured as **wrong**: a preset replaces the default, `uniquelocal` has no loopback in it, and a
    // proxy reached over `127.0.0.1:8080` (§3's own picture) then has every client recorded as `127.0.0.1`. The case now
    // reads the `.env` block, not the prose — the prose quotes the broken value on purpose, to explain it.
    const guide = readFileSync(join(ROOT, 'docs/12-deployment.md'), 'utf8');
    const recommended = [...guide.matchAll(/```dotenv\nTRUST_PROXY=(.+?)\n```/gu)].map(
      (match) => match[1] as string,
    );

    expect(recommended, 'the guide must show the value in a copyable block').toEqual([
      'loopback,uniquelocal',
    ]);
    // Both halves, because both peers are real: the bridge network in Compose, loopback for the host proxy.
    expect(recommended[0]?.split(',')).toEqual(['loopback', 'uniquelocal']);
    expect(guide).toContain('defaults to `loopback`');
    expect(guide, 'the reason must be stated, not just the value').toMatch(
      /preset \*replaces\* the default/u,
    );
  });
});

/**
 * The guide's routing snippet — the first `nginx` fenced block in the routing section.
 *
 * @returns The block's contents, comments removed.
 */
function guideNginxBlock(): string {
  const guide = readFileSync(join(ROOT, 'docs/12-deployment.md'), 'utf8');
  const blocks = [...guide.matchAll(/```nginx\n([\s\S]*?)```/gu)].map(
    (match) => match[1] as string,
  );
  // The guide has two nginx blocks — the outer TLS proxy and this container's map. The map is the one that routes pages.
  const routing = blocks.find((block) => block.includes('_site'));

  if (routing === undefined) throw new Error('the guide has no nginx routing block');
  return routing
    .split('\n')
    .map((line) => line.replace(/\s*#.*$/u, ''))
    .join('\n');
}

/**
 * The CSP base the shell serves, read out of the config without its variable.
 *
 * @returns The policy with `$mm_csp_upgrade` removed.
 */
function CSP_EXPECTED_BASE(): string {
  const shell = locationFor('/index.html').body;
  const value = /add_header Content-Security-Policy "([^"]*)"/u.exec(shell)?.[1] ?? '';
  return value.replace('$mm_csp_upgrade', '');
}
