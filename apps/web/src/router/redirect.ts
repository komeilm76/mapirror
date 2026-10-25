/**
 * Where to send someone who is not signed in, and where to send them back afterwards (`P1-WEB-03`).
 *
 * A deep link to `/_site/admin/jobs` from someone whose tab was closed should end at the login page and, after signing
 * in, at the jobs page — not at the dashboard. That means the destination has to survive a round trip **through the
 * address bar**, which makes it attacker-influenced input: the login page is a public URL, so anyone can hand out
 * `/_auth/login?redirect=https://evil.example/sign-in`.
 *
 * The rule, applied on both sides of the round trip, is one sentence: **a redirect target is a page path inside this
 * site, or it is the dashboard.** Concretely a target survives only if it
 *
 * - is a string (a query parameter can be an array or an object once Vue Router has parsed it),
 * - starts with a single `/` — `//evil.example` is a protocol-relative URL, not a path,
 * - carries no backslash (`/\evil.example` is treated as `//evil.example` by several browsers),
 * - is a **page** path by L1 (`/_site/…`), not an API path, not a probe, and not the login page itself,
 * - and is short enough to be a real path rather than an attempt at something else.
 *
 * The default is the dashboard, never the home page: someone who was refused an admin page and then signed in did not
 * ask for the marketing site.
 *
 * @module router/redirect
 */

import { isPagePath } from '@mapirror/shared';
import type { RouteLocationRaw } from 'vue-router';

import { ADMIN_ROOT, LOGIN_PAGE } from './paths';

/** Longest target accepted, in characters. Browsers stop at similar lengths; nothing legitimate comes close. */
export const MAX_REDIRECT_LENGTH = 512;

/** Where a refused navigation lands when there is nothing better to remember. */
export const DEFAULT_REDIRECT = `${ADMIN_ROOT}/`;

/**
 * Validates a redirect target.
 *
 * Used when **writing** the parameter (the guard) and when **reading** it (the login form, `P1-WEB-06`), because a
 * check on only one side is a check that the other side can be talked out of.
 *
 * @param value - Whatever arrived: a query parameter of unknown type, or a router path.
 * @returns A safe page path inside this site, or {@link DEFAULT_REDIRECT}.
 */
export function safeRedirectTarget(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_REDIRECT;
  if (value.length === 0 || value.length > MAX_REDIRECT_LENGTH) return DEFAULT_REDIRECT;

  // `//host` and `/\host` are both "another origin" to some browser; neither is a path this app can render.
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return DEFAULT_REDIRECT;

  // Strip a query string and fragment before the law check: they are part of a router location but not of a page path,
  // and `isPagePath('/_site/admin?x=1')` is false — a target with a filter in it would silently lose the filter rather
  // than fail, which is the quieter of the two wrong answers.
  const queryAt = value.search(/[?#]/u);
  const path = queryAt === -1 ? value : value.slice(0, queryAt);

  if (!isPagePath(path)) return DEFAULT_REDIRECT;
  // The login page is public by design, so "come back to the login page after logging in" is a loop, not a target.
  if (path === LOGIN_PAGE) return DEFAULT_REDIRECT;

  return value;
}

/**
 * The navigation that sends an unauthenticated visitor to the login page, remembering where they were going.
 *
 * @param fullPath - The location that was refused, with its query string (`route.fullPath`).
 * @returns A location for the login page carrying a validated `redirect` parameter.
 */
export function loginRedirectFor(fullPath: string): RouteLocationRaw {
  return { path: LOGIN_PAGE, query: { redirect: safeRedirectTarget(fullPath) } };
}
