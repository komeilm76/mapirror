/**
 * The Bearer guard for `/_admin/api/*` (task `P1-AUTH-05`, law L2).
 *
 * Law L2 says two things, and this module is the second half of each:
 *
 * > Every `/_admin/api/*` route requires a valid Bearer token; there is **no** opt-out flag. […] The guard is a
 * > global `onRequest` hook keyed by prefix, so a new route is protected automatically.
 *
 * **Keyed by prefix, not attached per route.** A per-route guard is a guard every future route has to remember, and
 * the one that forgets is the one nobody tests. This hook is installed on the root instance and decides from the
 * request path alone, so a route added tomorrow is protected before its handler is written — including a route added
 * inside another plugin, in another file, by someone who has never read this comment.
 *
 * **It runs in `onRequest`, before the body is parsed.** Two reasons, and the second is the security one: an
 * unauthenticated request should not cost a JSON parse or a body read at all, and a refused request must not have had
 * side effects by the time it is refused. Fastify's lifecycle makes `onRequest` the earliest point a hook can answer
 * from.
 *
 * **Fail closed.** The classification is `apiScopeOf` from `@mapirror/shared` — the same function the route law uses to
 * decide that a route is legal, and the one that decodes percent-escapes before classifying, so `/_admin/%61pi/…` is
 * still admin. A path this module cannot classify is a path the router will answer with `404`; it is not a path that
 * gets through, because the check is "is this under the admin prefix" *after* that decode, not "does it look like
 * something else".
 *
 * **No opt-out, by construction.** There is no flag, no exemption list and no decorator a route can set. The only way
 * to serve an unauthenticated route under `/_admin/api` in this codebase is to delete the hook — which the L2 test in
 * `tests/integration/admin-guard.spec.ts` fails, because it walks the **route table** and calls every route it finds.
 *
 * @module plugins/auth-guard
 */

import { isAdminApiPath, statusFor } from '@mapirror/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError } from '../lib/errors';
import { readBearerToken, verifySession } from '../modules/auth/session';

/**
 * What the guard needs from the rest of the process.
 *
 * `verdict` is the seam that makes the hook testable without a database: production passes the real verifier
 * (`verifySession`, which reads the database), a unit test passes a function that returns a chosen verdict. It is not
 * a policy seam — there is no way to say "let this one through".
 */
/**
 * What a verifier is: given the request and the presented token, either resolve with the session or reject with an
 * `AppError` the guard passes through unchanged.
 */
export type AuthVerify = (request: FastifyRequest, token: string) => Promise<unknown>;

/** What the guard accepts. */
export interface AuthGuardOptions {
  /**
   * Answers what a presented token is. Must throw `AppError` for an unusable token; the guard only supplies the token
   * and the clock.
   */
  readonly verify?: AuthVerify;
}

/**
 * The production verifier: the database-backed one from `modules/auth/session.ts`.
 *
 * @param request - The request being guarded; its `app.db` is the one connection pool of the process.
 * @param token - The credential the caller presented.
 * @returns The session, or throws the verdict's `AppError`.
 */
async function verifyWithDatabase(request: FastifyRequest, token: string): Promise<unknown> {
  return verifySession(request.server.db.db, token);
}

/**
 * Installs the guard on the **root** instance.
 *
 * Installed directly rather than registered as a plugin: a hook added inside a plugin is encapsulated to that plugin's
 * subtree, and this one has to see requests for `/_admin/api/*`, which belongs to a different subtree entirely.
 *
 * **Two Fastify details, both measured rather than assumed.**
 *
 * 1. The hook is `async` and **throws**; it does not call `reply.send` and then `done()`. In callback style those two
 *    are not alternatives: `done()` continues the lifecycle, the handler runs, the handler's `reply` wins, and the
 *    refusal becomes an `FST_ERR_REP_ALREADY_SENT` logged at `error` *after* a `200` went out. Measured on the first
 *    version of this file — every admin request answered `200`/`503` and the guard's own `401` was discarded.
 * 2. It throws instead of sending, so the refusal travels the **one** error path: `toErrorEnvelope` builds the body,
 *    the request id is the same one the envelope names, and a `500` from the verifier cannot describe itself.
 *
 * An unauthenticated request to an admin path that **does not exist** is also refused, because `onRequest` runs before
 * routing: `401` rather than `404`, so the route table is not readable without a token.
 *
 * @param app - Root instance.
 * @param options - Verifier override, for tests.
 */
export function installAuthGuard(app: FastifyInstance, options: AuthGuardOptions = {}): void {
  const verify = options.verify ?? verifyWithDatabase;

  app.addHook('onRequest', async (request) => {
    // Not an admin path: nothing to do. `isAdminApiPath` is the shared predicate the route law uses — it decodes
    // percent-escapes before deciding, so `/_admin/%61pi/…` is admin here whether or not Fastify's router would have
    // matched it. A guard with its own `startsWith` would be a second, subtly different definition of "admin".
    if (!isAdminApiPath(request.url)) return;

    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    }

    // Whatever the verifier rejects with is thrown onward unchanged: an `AppError` carries the verdict's own code and
    // the error stage maps it, and anything else — a dead pool, a driver message naming a table — is mapped there to
    // `INTERNAL_ERROR` with a fixed sentence and logged with the detail. Catching and rewrapping here would be a second
    // copy of the 500 policy, and the copy is what drifts.
    await verify(request, token);
  });
}

/** The status a refusal carries for a given verdict; exported so a test can state the contract. */
export const GUARD_STATUSES = {
  unauthenticated: statusFor('UNAUTHENTICATED'),
  revoked: statusFor('TOKEN_REVOKED'),
  expired: statusFor('TOKEN_EXPIRED'),
  disabled: statusFor('ACCOUNT_DISABLED'),
} as const satisfies Record<string, number>;
