/**
 * Reading a bearer token, and turning one into a session (`P1-AUTH-04`).
 *
 * Two responsibilities, both small, both easy to get subtly wrong, so both live in one tested place rather than in
 * each route:
 *
 * 1. **Parse the `Authorization` header.** Not `header.split(' ')[1]` — that accepts `Bearer  token` (two spaces) as
 *    an empty token, accepts `Basic` as a bearer value, and throws away the difference between "no header" and "a
 *    header we do not understand". The rules implemented here are RFC 9110 §11.6.2's: one scheme, case-insensitive,
 *    followed by exactly one credential.
 * 2. **Map a verdict to an error.** `verifyToken` answers with four distinguishable outcomes and the contract gives
 *    each its own code — `UNAUTHENTICATED`, `TOKEN_REVOKED`, `TOKEN_EXPIRED`, `ACCOUNT_DISABLED`. Collapsing them into
 *    one `401` would be simpler and would also tell a person with a live-but-expired session to "log in again" without
 *    saying why, which is the difference between a bug report and a shrug.
 *
 * The mapping is here, not in the guard plugin (`P1-AUTH-05`), because that plugin and these two routes must answer
 * identically: a `/me` that says `TOKEN_EXPIRED` while `/_admin/api/*` says `UNAUTHENTICATED` for the same token is a
 * client that has to guess which one to believe.
 *
 * @module modules/auth/session
 */

import type { Kysely } from 'kysely';

import type { Database } from '../../db/schema';
import type { AdminIdentity } from '../../db/repositories/admin-tokens';
import { AppError } from '../../lib/errors';
import { verifyToken, type VerifiedToken } from './tokens';

/** The scheme this API accepts, as lowercase: header comparison is case-insensitive (RFC 9110). */
export const BEARER_SCHEME = 'bearer';

/** One authenticated request: who, and which of their sessions. */
export interface Session {
  /** The account behind the token. `isActive` is always `true` — a disabled account never reaches a handler. */
  readonly admin: AdminIdentity;
  /** The token's own facts: id, prefix, expiry, and when it was last used. */
  readonly token: VerifiedToken;
}

/**
 * Extracts the token from an `Authorization` header.
 *
 * @param authorization - The header as Fastify delivered it, or `undefined` when absent.
 * @returns The credential verbatim, or `null` when the header is missing, names another scheme, or carries anything
 * other than exactly one credential (two values, nothing after the scheme, a tab-separated pair).
 */
export function readBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;

  // `trim()` handles the trailing space some clients send; splitting on runs of whitespace is what makes `Bearer  x`
  // resolve to `x` instead of to an empty credential — RFC 9110 allows any amount of optional whitespace there, and a
  // parser that quietly produces `''` would answer `UNAUTHENTICATED` for a header a proxy may have reformatted.
  const [scheme, value, ...rest] = authorization.trim().split(/\s+/u);
  if (scheme?.toLowerCase() !== BEARER_SCHEME) return null;
  // No `value.length === 0` test: splitting a trimmed header on runs of whitespace cannot produce an empty token, and
  // a condition no input can reach is a branch no test can cover — the pattern this project has removed four times.
  if (value === undefined || rest.length > 0) return null;
  return value;
}

/**
 * Reads the presented token or refuses the request.
 *
 * A thin wrapper over {@link readBearerToken}, so a handler does not repeat the same four-line `if` — and so the
 * message for a missing header is written once.
 *
 * @param authorization - The `Authorization` header, or `undefined`.
 * @returns The credential.
 * @throws {AppError} `UNAUTHENTICATED` (`401`) when there is no usable bearer token.
 */
export function requireBearerToken(authorization: string | undefined): string {
  const token = readBearerToken(authorization);
  if (token === null) {
    throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  }
  return token;
}

/**
 * Verifies a presented token and maps the verdict to the contract's error.
 *
 * A successful verification also records `last_used_at` (at most once a minute, in `tokens.ts`), so a call here is not
 * purely a read — that is deliberate: this runs on every authenticated admin request, and the write is throttled
 * because a sessions list is not worth a write per request.
 *
 * @param executor - Kysely instance or transaction.
 * @param presented - The credential, exactly as it arrived.
 * @param options - Clock, injectable for tests.
 * @returns The session the token represents.
 * @throws {AppError} `UNAUTHENTICATED` (unknown or malformed token), `TOKEN_REVOKED`, `TOKEN_EXPIRED` (`401` each) or
 * `ACCOUNT_DISABLED` (`403`).
 */
export async function verifySession(
  executor: Kysely<Database>,
  presented: string,
  options: { readonly now?: Date } = {},
): Promise<Session> {
  const verdict = await verifyToken(executor, presented, options);

  switch (verdict.status) {
    case 'valid':
      return { admin: verdict.admin, token: verdict.token };
    case 'unknown':
      // One message for "never existed", "malformed" and "deleted": the caller learns the token is not usable, and
      // nothing about whether it once was.
      throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    case 'revoked':
      throw new AppError('TOKEN_REVOKED', 'This session has ended. Sign in again.');
    case 'expired':
      throw new AppError('TOKEN_EXPIRED', 'Your session has expired. Sign in again.');
    case 'disabled':
      throw new AppError(
        'ACCOUNT_DISABLED',
        'This account is deactivated. Ask an operator to re-enable it.',
      );
  }
}
