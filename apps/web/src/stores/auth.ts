/**
 * Who is signed in (`P1-WEB-05`, D-13).
 *
 * The session is three facts and one string:
 *
 * | Fact | Where it lives | Why there |
 * |---|---|---|
 * | the **token** | `sessionStorage` via `auth/token-storage.ts` | D-13: one tab, gone when the tab closes, never an ambient credential |
 * | the **profile** | this store, filled by `/login` or `/me` | not a secret, and a *copy* of a server fact must not outlive the token it describes |
 * | the **expiry** | this store, from the same two answers | a hint for "signed in until 21:20", never a reason to sign anyone out |
 *
 * ## One writer, one reader
 *
 * The token is written **only here** (`signIn`) and cleared only here (`signOut`/`forget`), so `sessionStorage` cannot
 * disagree with the store. The router's guard and the API client are handed this store's own predicate and token
 * provider (`bootstrap.ts`), because the two places that ask "is there a session?" must answer from the same value: a
 * guard reading `sessionStorage` would refuse an admin navigation for a session that exists in memory but could not be
 * persisted (private mode, a full quota), and the API client's sign-out latch would be watching a key nobody wrote
 * (measured in pass 33, before the latch was given the same source).
 *
 * ## What is *not* stored
 *
 * The profile is deliberately not in `sessionStorage`. A reload then knows *that* a token exists but not *who* it
 * belongs to, which is exactly true: the token is the only thing that survived. `restore()` asks `GET /_auth/api/me`
 * for the profile, and until it answers the layout shows no name rather than a stale one. Persisting the profile would
 * also mean a second key to keep in step with the first, and a name left on screen after the token it described died.
 *
 * ## The expiry is a hint
 *
 * `hasExpired()` compares the token's `expiresAt` with the local clock, and the local clock can be wrong. So it is a
 * method (a getter would memoise `Date.now()` and keep answering `false`) and nothing in this store acts on it: the
 * server is the authority on whether a token works, and it answers `401` when it does not.
 *
 * @module stores/auth
 */

import { MeResponseSchema, type AdminProfile, type LoginResponse } from '@mapirror/shared';
import { defineStore } from 'pinia';

import type { ApiClient } from '@/api/client';
import { ApiError } from '@/api/errors';
import { clearSessionToken, readSessionToken, writeSessionToken } from '@/auth/token-storage';

import { useNotifications } from './notifications';

/** The two auth endpoints this store calls, named once (`04-api.md` §1). */
export const ME_PATH = '/_auth/api/me';
export const LOGOUT_PATH = '/_auth/api/logout';

/**
 * What `restore()` found.
 *
 * Three outcomes, because "could not check" is not "signed out": a laptop that wakes up without a network must not lose
 * a session that the server would still accept.
 *
 * - `session` — the token is live and the profile is filled;
 * - `signed-out` — there was no token, or the API refused the one there was; the store is empty;
 * - `unverified` — the token was kept, but the answer could not be read (offline, timeout, a malformed body).
 */
export type RestoreOutcome = 'session' | 'signed-out' | 'unverified';

/** The store's state: the token and the two server facts that describe it. */
export interface AuthState {
  /** The credential, as sent to the API. `null` when signed out. */
  token: string | null;
  /** Who the token belongs to; `null` until `/login` or `/me` has answered. */
  admin: AdminProfile | null;
  /** ISO-8601 instant at which the token stops working; `null` until an answer has carried it. */
  expiresAt: string | null;
}

/**
 * The signed-in admin.
 *
 * Created per Pinia (`plugins/pinia.ts` is a factory), so a test that signs in cannot decide the next test's session.
 * The initial state is read from `sessionStorage` **once**, at creation: that single read is what makes a reload keep
 * the session.
 */
export const useAuth = defineStore('auth', {
  state: (): AuthState => ({
    // `readSessionToken()` already normalises `''`, an unusable store and a quota-throwing store to `null`.
    token: readSessionToken(),
    admin: null,
    expiresAt: null,
  }),

  getters: {
    /**
     * Whether a credential is held — the question the router's guard asks.
     *
     * Presence, not validity (`router/guards.ts` says why): the admin pages are inert shells, and every fact on them
     * comes from a request that the API checks itself.
     */
    isAuthenticated: (state): boolean => state.token !== null,

    /** The username to show, or `null` while it is unknown — never a guess. */
    username: (state): string | null => state.admin?.username ?? null,
  },

  actions: {
    /**
     * Remembers a successful `POST /_auth/api/login`.
     *
     * The caller parses the answer with `LoginResponseSchema` (`@mapirror/shared`) first — this action takes the
     * parsed result, so a screen cannot hand over a `Response` body it never validated.
     *
     * The token is kept **even when the write fails**. `sessionStorage` can be unavailable (a privacy mode that throws)
     * or full, and neither is a reason to throw away a session the server has just issued: the tab works until it is
     * reloaded, and the return value is how the UI can say so.
     *
     * @param session - The login answer: the token, its expiry and the profile.
     * @returns `true` when the token will survive a reload, `false` when it lives only for this page.
     */
    signIn(session: LoginResponse): boolean {
      this.token = session.token;
      this.admin = session.admin;
      this.expiresAt = session.expiresAt;

      // A failed write is reported, not acted on: see above. `writeSessionToken` never throws.
      return writeSessionToken(session.token);
    },

    /**
     * Ends the session locally, and tells the server when a client is given.
     *
     * **The revoke is sent before the state is cleared, and that order is load-bearing:** `request()` reads the token
     * from this store while it is still synchronous, so clearing first would send `POST /_auth/api/logout` without a
     * header — a session that stays alive on the server while the screen says it is over. `tests/auth-store.spec.ts`
     * pins the header, so a future reorder fails instead of passing.
     *
     * It does not wait for the answer. A sign-out the reader asked for must not depend on the network: the local
     * session goes now, and a server that cannot be reached is a revocation that will be caught by the token's own
     * expiry (a `401` from it is the policy's problem, and by then this store already holds nothing).
     *
     * @param client - The API client, when the caller has one. Omitted, the session ends without a request.
     */
    signOut(client?: ApiClient): void {
      if (this.token !== null && client !== undefined) {
        // Deliberately un-awaited (`void`), and deliberately caught: a failed revoke is not a failed sign-out on this
        // device, and an unhandled rejection here would surface as a console error on the way out of the app.
        void client.post<void>(LOGOUT_PATH).catch(() => undefined);
      }

      this.forget();

      // The toast queue belongs to the session that produced it: "Saved" must not follow the next user in
      // (`stores/notifications.ts` says the same). The `401` path does *not* come through here — it forgets, then adds
      // the toast that explains why — which is why clearing is in `signOut` and not in `forget`.
      useNotifications().clear();
    },

    /**
     * Forgets the credential without a word: state and `sessionStorage`, no request, no toast, no navigation.
     *
     * This is the `clearToken` the API client is handed (`api/index.ts`), so a dead token ends the same way whether the
     * reader asked or the server refused. It resets the profile too — a name with no session behind it is a lie the
     * topbar would happily render.
     */
    forget(): void {
      this.token = null;
      this.admin = null;
      this.expiresAt = null;
      clearSessionToken();
    },

    /**
     * Asks the API who the stored token belongs to, and fills the profile.
     *
     * Called once per page load by the admin shell (`P1-WEB-07`), which is the first thing that needs a name. With no
     * token it makes **no request** — the guard already sent the reader to the login page.
     *
     * A refusal ends the session; anything else keeps it. The distinction matters: `NETWORK`/`TIMEOUT`/`MALFORMED` mean
     * the question went unanswered, and signing someone out because their train went into a tunnel is a bug the reader
     * would report as "it logs me out all the time".
     *
     * @param client - The API client (`useApi()`).
     * @returns What was found; see {@link RestoreOutcome}.
     */
    async restore(client: ApiClient): Promise<RestoreOutcome> {
      const asked = this.token;
      if (asked === null) return 'signed-out';

      // An answer belongs to the session that asked for it. Between the request and its answer the reader can sign out,
      // or sign in again with a token of their own, and an `await` is exactly long enough for both. Measured before this
      // guard (pass 34): a `/me` that landed after a sign-out put a profile back into a store holding no token — a name
      // in the topbar for a session that was over — and a `401` for the *old* token called `forget()` on the *new* one,
      // signing out a session the server had just issued.
      const superseded = (): RestoreOutcome | null => {
        if (this.token === asked) return null;
        return this.token === null ? 'signed-out' : 'unverified';
      };

      let payload: unknown;
      try {
        payload = await client.get<unknown>(ME_PATH);
      } catch (cause) {
        const lost = superseded();
        if (lost !== null) return lost;
        // The API client's own policy has already ended the session for the four codes that end one (`api/index.ts`),
        // and that policy is what toasted and navigated; here it only has to be reflected in this store's state.
        if (cause instanceof ApiError && cause.sessionEnded) {
          this.forget();
          return 'signed-out';
        }
        return 'unverified';
      }

      const lost = superseded();
      if (lost !== null) return lost;

      // A `200` is not yet a fact: the body comes from the network, and the shared schema is the only thing that turns
      // it into a profile (`09-development.md` §9: no silent casts on untrusted data). A body that does not fit is
      // "unverified", not "signed out" — the token itself was never refused.
      const parsed = MeResponseSchema.safeParse(payload);
      if (!parsed.success) return 'unverified';

      this.admin = parsed.data.admin;
      this.expiresAt = parsed.data.expiresAt;
      return 'session';
    },

    /**
     * Whether the **local clock** says the token has expired.
     *
     * A hint for a "your session ends in 5 minutes" banner, not a sign-out rule: the clock belongs to the browser and
     * the server is the authority. A method rather than a getter because a getter would cache its first `Date.now()`.
     *
     * @param now - The instant to compare with; defaults to now. Injectable so a test needs no fake timers.
     * @returns `true` only when there is a parseable expiry at or before `now`; `false` when there is nothing to judge.
     */
    hasExpired(now: number = Date.now()): boolean {
      if (this.expiresAt === null) return false;
      const at = Date.parse(this.expiresAt);
      // An unparseable stamp is not evidence of expiry — and `Date.parse` answering `NaN` makes every comparison
      // `false` anyway, which is the right answer for the wrong reason.
      return Number.isFinite(at) && at <= now;
    },
  },
});
