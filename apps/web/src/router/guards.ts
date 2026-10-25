/**
 * The navigation guard (`P1-WEB-03`).
 *
 * One rule: **a page in the admin area needs a session token, and the token is a convenience rather than a
 * permission.**
 *
 * ## Why the rule is keyed on the path
 *
 * The alternative — a `meta.requiresAuth: true` flag on each admin route — is a flag somebody eventually forgets, and
 * the failure mode is a page that renders for an anonymous visitor. The API's own guard is installed for the same
 * reason and in the same shape (`plugins/auth-guard.ts`: a global hook keyed on `/_admin/api/*`, "there is no opt-out
 * flag", L2). Keying on the path means a route added under `/_site/admin/` next month is guarded the moment it is
 * registered, and `tests/auth-guard.spec.ts` proves that by registering one.
 *
 * ## What it is not
 *
 * It is **not** an authorization control, and it must not be described as one. The admin pages are inert shells: every
 * fact on them arrives from `/_admin/api/*`, which answers `401` to a token that is missing, expired, revoked or
 * belongs to a deactivated account (`P1-AUTH-05`, `P1-AUTH-08`). Someone who removes this guard from their local build
 * sees an empty panel and a wall of 401s. That is why the check here is `hasSessionToken()` — "is a string stored?" —
 * and not a call to `/me`: a guard that made a network request would make every navigation wait for it, and it would
 * still not be a security boundary.
 *
 * @module router/guards
 */

import type { Router } from 'vue-router';

import { hasSessionToken } from '@/auth/token-storage';
import { loginRedirectFor } from './redirect';
import { areaForPath } from '@/theme/policy';

/** What the guard may be told; production passes nothing. */
export interface AuthGuardOptions {
  /**
   * Answers "is there a session token?".
   *
   * Defaults to {@link hasSessionToken}. Injected in tests so a case does not have to write to `sessionStorage`, and
   * so `P1-WEB-05` can hand in the store's own predicate without touching this module.
   */
  readonly hasSession?: () => boolean;
}

/**
 * Installs the guard on a router.
 *
 * @param router - The app's router, before its first navigation.
 * @param options - Session predicate, for tests and for the auth store.
 * @returns A function that removes the guard.
 */
export function installAuthGuard(router: Router, options: AuthGuardOptions = {}): () => void {
  const hasSession = options.hasSession ?? (() => hasSessionToken());

  return router.beforeEach((to) => {
    // Public and auth areas are never gated here. The login page must stay reachable precisely when the session is
    // gone, which is the moment a "signed in only" rule would be most tempting and most wrong.
    if (areaForPath(to.path) !== 'admin') return true;
    if (hasSession()) return true;

    // `to.fullPath`, so a filtered view survives: `/_site/admin/jobs?status=failed` comes back as itself.
    return loginRedirectFor(to.fullPath);
  });
}
