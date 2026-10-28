/**
 * The app's API client, and what happens when a credential dies (`P1-WEB-04`).
 *
 * `api/client.ts` is the mechanism; this module is the policy, in one function, so that "sign the reader out" is
 * written once instead of once per screen:
 *
 * 1. **clear the token** — otherwise the router's guard would wave the next navigation through and the reader would
 *    land on an admin page that can only answer `401`;
 * 2. **say why** — a toast naming the reason and carrying the request id (`13-ui-ux.md` §5: errors persist, and a
 *    support request quotes the id);
 * 3. **go to the login page**, remembering where they were — but only when they were somewhere that needed a session.
 *    A `401` that arrives while the reader is on the public catalog must not yank them off it.
 *
 * ## The once-per-session guarantee
 *
 * A dashboard fires several requests at once, so a dead token produces several `401`s. Each one reaches this callback,
 * and each one would toast and navigate. The guard is the token itself: the first callback clears it, so by the time
 * the second arrives the reader is already holding nothing — the session is over and has been reported. The next
 * sign-in stores a new token, and the next expiry starts from a non-empty store again.
 *
 * The latch therefore reads **the same source the requests read** (`token`), and clears through `clearToken`. Both are
 * injectable for that reason, and the pair must agree: the first version of this module latched on `sessionStorage`
 * while the client was already reading an injected provider, so a store-backed token would end its session silently — no
 * toast, no navigation, and the reader left on an admin page that can only answer `401` (measured in pass 33 with a
 * provider and an empty store: 0 toasts, route unchanged). `bootstrap.ts` now passes the pair from the auth store
 * (`P1-WEB-05`), which is the case that measurement was about.
 *
 * @module api
 */

import type { App } from 'vue';
import type { InjectionKey } from 'vue';
import type { Router } from 'vue-router';

import { clearSessionToken, readSessionToken } from '@/auth/token-storage';
import { loginRedirectFor } from '@/router/redirect';
import type { useNotifications } from '@/stores/notifications';
import { areaForPath } from '@/theme/policy';

import { createApiClient, type ApiClient } from './client';
import { errorCopyFor } from './error-copy';
import { notifyApiError } from './notify-error';

/** The injection key `useApi()` reads. A symbol, so two copies of this module cannot collide. */
export const API_CLIENT_KEY: InjectionKey<ApiClient> = Symbol('mapirror.api-client');

/** What the app-level client needs. */
export interface AppApiOptions {
  /** Where to send a reader whose session ended. */
  readonly router: Router;
  /** The toast store the app was built with. */
  readonly notifications: ReturnType<typeof useNotifications>;
  /**
   * Reads the token. Defaults to `sessionStorage` (`auth/token-storage.ts`).
   *
   * Handed in by `P1-WEB-05`'s auth store, and **paired with `clearToken`**: the sign-out policy reads and clears
   * through these two, so a token that lives in memory cannot end its session against a storage key that was never
   * holding it.
   */
  readonly token?: () => string | null;
  /**
   * Forgets the token. Defaults to `clearSessionToken`.
   *
   * Required whenever `token` is provided and the token is not in `sessionStorage` — otherwise the client would report
   * the session ended while the store went on presenting the same dead credential.
   */
  readonly clearToken?: () => void;
  /** The `fetch` to use; defaults to the global one. A seam for tests, and for pointing the SPA at another origin. */
  readonly fetchImpl?: typeof fetch;
}

/** The sentence a dead session shows. Deliberately about the session, not about the request that noticed. */
export const SESSION_ENDED_MESSAGE = 'Your session has ended. Sign in again.';

/**
 * Builds the client the SPA uses, with the sign-out policy attached.
 *
 * @param options - The router and the toast store the app was built with.
 * @returns A client whose failures are `ApiError`s and whose dead credentials sign the reader out once.
 */
export function createAppApiClient(options: AppApiOptions): ApiClient {
  const { router, notifications } = options;
  const readToken = options.token ?? ((): string | null => readSessionToken());
  const forgetToken = options.clearToken ?? ((): void => clearSessionToken());

  return createApiClient({
    token: readToken,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    onSessionExpired: (error) => {
      // Already handled: a second refusal from the same burst of requests must not toast or navigate twice. The test is
      // the reader's *own* source, so the latch and the requests cannot disagree about whether a token exists.
      if (readToken() === null) return;

      forgetToken();
      notifyApiError(notifications, error, {
        message: SESSION_ENDED_MESSAGE,
        detail:
          error.code === 'UNKNOWN'
            ? 'Sign in again to continue.'
            : errorCopyFor(error.code).message,
      });

      const current = router.currentRoute.value;
      if (areaForPath(current.path) !== 'admin') return;

      // `replace`, not `push`: the page that just failed is not somewhere the back button should return to.
      void router.replace(loginRedirectFor(current.fullPath));
    },
  });
}

/**
 * Hands a client to every component in the app.
 *
 * Called once by `bootstrap.ts`; a test that mounts one component of its own calls it with a stub client.
 *
 * @param app - The Vue application.
 * @param client - The client `useApi()` will return.
 * @returns The client, so a caller can wire and keep it in one expression.
 */
export function provideApiClient(app: App, client: ApiClient): ApiClient {
  app.provide(API_CLIENT_KEY, client);
  return client;
}
