/**
 * Route classification for the API server (L1, L2).
 *
 * The prefixes themselves live in `@mapirror/shared` — the web app needs them too (its router law test
 * proves no page collides with an API prefix), and a second copy here would be a second thing to get
 * wrong. This module is the API-side half: given a request URL, which namespace is it in, and does it need
 * a token?
 *
 * The global `onRequest` guard in `P1-API-05` is keyed on {@link requiresAdminToken}, which is why the
 * default is **deny**: anything under `/_admin/api` needs a token, including routes added later that
 * nobody remembered to protect.
 *
 * @module config/prefixes
 */

import {
  API_PREFIXES,
  apiScopeOf,
  isAdminApiPath,
  isApiPath,
  PROBE_PATHS,
  ROUTE_PREFIXES,
} from '@mapirror/shared';

// Re-exported, not redefined: this module used to build its own `API_PREFIXES` from the shared prefixes —
// a second list whose order also had to match. `API_PREFIXES` is shared's list, in shared's order
// (auth, admin, public), which is the order the Fastify instance will register routes in.
export { API_PREFIXES, PROBE_PATHS, ROUTE_PREFIXES };

/**
 * Reports whether a request to `url` must carry a Bearer token.
 *
 * Everything under `/_admin/api` does; nothing else does. `/healthz` and `/readyz` are deliberately
 * exempt — a probe that needs credentials cannot be used by Docker or an uptime monitor.
 *
 * @param url - Request URL, possibly including a query string.
 * @returns `true` when the admin guard must run.
 */
export function requiresAdminToken(url: string): boolean {
  return isAdminApiPath(url);
}

/**
 * Reports whether the URL is a JSON API route (as opposed to a page or a probe).
 *
 * @param url - Request URL.
 * @returns `true` for the three API prefixes.
 */
export function isApiRequest(url: string): boolean {
  return isApiPath(url);
}

/**
 * Names the namespace of a request, for logging and error envelopes.
 *
 * @param url - Request URL.
 * @returns `'auth' | 'admin' | 'public'`, or `null` when the URL is not an API route.
 */
export function scopeOf(url: string): ReturnType<typeof apiScopeOf> {
  return apiScopeOf(url);
}
