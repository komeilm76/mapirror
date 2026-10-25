/**
 * Route law as code (L1, D-18, D-19).
 *
 * The specification puts every page under `/_site/*`, with exactly one exception (`GET /_auth/login`),
 * and every JSON endpoint under one of the three API prefixes. `04-api.md` §0 is the normative table and
 * `10-laws.md` L1 states the rules; this module is the machine-readable copy both applications and their
 * law tests import, so the rule is written once.
 *
 * Path matching is **segment-aware**: `/_auth/apiX` is not inside `/_auth/api`. A naive
 * `startsWith(prefix)` would place it there, and the admin guard built on this would then treat an
 * unrelated path as an API route.
 *
 * @module routes
 */

/** The four namespaces. Every route in the system belongs to one of them. */
export const ROUTE_PREFIXES = {
  /** Website pages (SPA shells). */
  site: '/_site',
  /** Login page — the single page outside `/_site`, by D-19. */
  auth: '/_auth',
  /** Auth JSON API. */
  authApi: '/_auth/api',
  /** Admin JSON API (Bearer required, deny by default — L2). */
  adminApi: '/_admin/api',
  /** Public JSON API (anonymous, rate limited). */
  publicApi: '/_public/api',
} as const;

/** The three JSON API prefixes. Pages never start with one of these (L1). */
export const API_PREFIXES = [
  ROUTE_PREFIXES.authApi,
  ROUTE_PREFIXES.adminApi,
  ROUTE_PREFIXES.publicApi,
] as const;

/** Namespace of an API prefix. */
export type ApiScope = 'auth' | 'admin' | 'public';

/** The one page that is not under `/_site/` (D-19). */
export const LOGIN_PAGE_PATH = '/_auth/login';

/** Segment reserved for APIs, never for a page (L1). */
const RESERVED_SEGMENT = 'api';

/** Where `GET /` redirects to. Trailing slash on purpose: `/_site` without it is not the root page. */
export const SITE_ROOT_PATH = '/_site/';

/** Liveness and readiness probes. Served by the API, outside every prefix, and exempt from the law. */
export const PROBE_PATHS = {
  health: '/healthz',
  ready: '/readyz',
} as const;

/**
 * Strips the query string from a request path.
 *
 * Written with `indexOf`/`slice` rather than `split('?')[0] ?? ''`: under `noUncheckedIndexedAccess` the
 * indexed form needs a fallback that can never run, which leaves a permanently uncovered branch in the
 * coverage report — and a branch nobody can reach is not a test to write, it is noise.
 *
 * @param path - Request path, with or without a query string.
 * @returns The path alone.
 */
function pathOnly(path: string): string {
  const queryAt = path.indexOf('?');
  return queryAt === -1 ? path : path.slice(0, queryAt);
}

/**
 * Tests whether `path` is `prefix` itself or sits below it, comparing whole segments.
 *
 * @param path - Request path, with or without a query string.
 * @param prefix - Prefix to test for, without a trailing slash.
 * @returns `true` when the path is inside the prefix.
 */
export function isPathUnder(path: string, prefix: string): boolean {
  const withoutQuery = pathOnly(path);
  // A lone "/" must not be stripped to "", or it would be indistinguishable from the empty path.
  const normalised = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
  return normalised === prefix || normalised.startsWith(`${prefix}/`);
}

/**
 * Forms of a path that must be classified identically: the path as received, plus its decoded form when it
 * carries percent-escapes.
 *
 * Why both: the guard is prefix-based so that routes added later are protected automatically, which means
 * the classification is the security boundary (L2). A request for `/_admin/%61pi/cache` decodes to an admin
 * path; today Fastify's router matches static segments on the encoded form, so that request 404s before the
 * guard matters — but "safe only because of how the router happens to match" is not a property this module
 * should rely on. Decoding here makes the classification **fail closed**: the encoded form is admin too, so
 * the token is required whether or not a route matches it.
 *
 * `decodeURIComponent` throws on malformed input (`%ZZ`), in which case only the raw form is classified —
 * a request the server will reject anyway.
 *
 * @param path - Request path, with or without a query string.
 * @returns One or two forms of the path.
 */
function pathForms(path: string): string[] {
  const raw = pathOnly(path);
  if (!raw.includes('%')) return [raw];
  try {
    // No `decoded === raw` shortcut: a path containing `%` always decodes to something else (or throws), so
    // the branch would be unreachable — and an unreachable branch is uncovered lines in the report, not
    // extra safety. A duplicate entry would be harmless for both `.some` and `.every`.
    return [raw, decodeURIComponent(raw)];
  } catch {
    return [raw];
  }
}

/**
 * Classifies an API path, if it is one.
 *
 * @param path - Request path.
 * @returns The scope, or `null` when the path is not an API route.
 */
export function apiScopeOf(path: string): ApiScope | null {
  for (const form of pathForms(path)) {
    if (isPathUnder(form, ROUTE_PREFIXES.authApi)) return 'auth';
    if (isPathUnder(form, ROUTE_PREFIXES.adminApi)) return 'admin';
    if (isPathUnder(form, ROUTE_PREFIXES.publicApi)) return 'public';
  }
  return null;
}

/**
 * Reports whether the path belongs to a JSON API.
 *
 * @param path - Request path.
 * @returns `true` for anything under the three API prefixes.
 */
export function isApiPath(path: string): boolean {
  return apiScopeOf(path) !== null;
}

/**
 * Reports whether the path is an admin API route, which always requires a Bearer token (L2).
 *
 * @param path - Request path.
 * @returns `true` for `/_admin/api` and everything below it.
 */
export function isAdminApiPath(path: string): boolean {
  return apiScopeOf(path) === 'admin';
}

/**
 * Reports whether the path is one of the probes.
 *
 * @param path - Request path.
 * @returns `true` for `/healthz` and `/readyz` only — not for `/healthz/x`.
 */
export function isProbePath(path: string): boolean {
  return pathForms(path).some((form) =>
    Object.values(PROBE_PATHS).some((probe) => isPathUnder(form, probe) && form === probe),
  );
}

/**
 * Reports whether the path may be served as a **page** (HTML), per D-19.
 *
 * The segment `api` is reserved (L1): it may only appear in an API prefix, so the documentation page is
 * `/_site/api-docs` and `/_site/api` is **not** a page. Without this rule a page could sit one character
 * away from an endpoint and be mistaken for one — by a reader, a crawler, or the Nginx location matching.
 *
 * @param path - Request path.
 * @returns `true` for `/_site/*` (except the reserved segment) and for `/_auth/login` exactly.
 */
export function isPagePath(path: string): boolean {
  // `every`, not `some`: a path is a page only if *no* form of it is reserved. With `some`, the encoded
  // `/_site/%61pi` was a page because its raw form is not reserved while its decoded form is — the
  // reserved segment failed open, which is the one direction a law check must never fail in.
  return pathForms(path).every((form) => {
    if (!isPathUnder(form, ROUTE_PREFIXES.site)) return form === LOGIN_PAGE_PATH;
    return !isPathUnder(form, `${ROUTE_PREFIXES.site}/${RESERVED_SEGMENT}`);
  });
}

/**
 * Reports whether a path is legal at all under L1: a page, an API route, or a probe.
 *
 * This is the assertion the route-law tests use on every registered route — a route that fails it is
 * in the wrong namespace, which is the mistake the law exists to prevent.
 *
 * @param path - Request path.
 * @returns `true` when the path is inside a legal namespace.
 */
export function isLegalPath(path: string): boolean {
  return isPagePath(path) || isApiPath(path) || isProbePath(path);
}
