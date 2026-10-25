/**
 * Opaque bearer tokens: mint, hash, verify, revoke (task `P1-AUTH-02`, decisions D-3 / ADR-004).
 *
 * A token is `mm_` followed by 43 base64url characters — 32 random bytes, 256 bits, from the operating system's
 * CSPRNG. What is stored is `sha256(token)` and the first 8 characters for display; the token itself exists only in
 * the response that created it and in the client's `sessionStorage`. That is the whole security property: a leaked
 * database dump contains no usable credential, because a SHA-256 preimage cannot be computed and the digest cannot
 * be replayed.
 *
 * **On "constant-time compare" (`08-tasks.md` P1-AUTH-02).** There is no secret comparison in this module, by
 * construction: verification hashes what was presented and lets PostgreSQL's unique index find the row. A byte
 * comparison in JavaScript would only exist if the token or its digest were compared to a value held elsewhere —
 * and the digest *is* the value being looked up, so a `timingSafeEqual` call here would compare the same bytes the
 * database just matched, and protect nothing. The property the acceptance criterion is after ("an attacker cannot
 * learn the secret from how long verification took") holds more strongly this way: a wrong token and a right one
 * run the same statement, on a value the attacker already knows, against an index. What *is* guarded here is the
 * prefix — {@link findTokenWithAdmin} matches the digest, never `token_prefix`, and a test presents a token that
 * shares a prefix with a live one to prove it.
 *
 * **Lifecycle.** A token ends by revocation (logout, password reset) or by expiry (`AUTH_TOKEN_TTL_HOURS`, default
 * 12). Verification tells the caller *which*, because the API contract distinguishes `TOKEN_EXPIRED` from
 * `TOKEN_REVOKED` (`04-api.md` §0.2) and the SPA shows "your session ended" rather than "please log in again". Both
 * are `401`; neither reveals whether the token ever existed.
 *
 * @module modules/auth/tokens
 */

import { createHash, randomBytes } from 'node:crypto';

import {
  deleteExpiredTokens,
  findTokenWithAdmin,
  insertToken,
  revokeTokenByHash,
  revokeTokensForAdmin,
  touchLastUsed,
  type AdminIdentity,
  type TokenExecutor,
} from '../../db/repositories/admin-tokens';

/** Prefix every token starts with; also what makes a leaked token recognisable in a scan or a log grep. */
export const TOKEN_MARKER = 'mm_';

/** Random bytes in a token: 256 bits, per ADR-004. */
export const TOKEN_BYTE_LENGTH = 32;

/**
 * How many characters of a token are stored and shown (`token_prefix`).
 *
 * Eight: `mm_` plus five random characters. Enough to tell two sessions apart in a list, far too little to be a
 * credential — 30 of the token's 256 bits, and the column is never used for lookup.
 */
export const TOKEN_DISPLAY_PREFIX_LENGTH = 8;

/**
 * What a well-formed token looks like.
 *
 * Checked before the database is touched, so a request carrying a truncated or pasted-wrong value costs a regex
 * instead of a query, and the answer is the same `401` as a wrong token. 43 characters is exactly the base64url
 * length of 32 bytes (no padding), so the pattern is the format, not an approximation of it.
 */
export const TOKEN_PATTERN = /^mm_[A-Za-z0-9_-]{43}$/u;

/**
 * Minimum age before `last_used_at` is written again.
 *
 * `03-data-model.md` §2.2: at most one write per minute per token, so recording usage does not put the whole read
 * path into the write path.
 */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** Expired tokens are deleted only after this long (`03-data-model.md` §2.2). */
export const PRUNE_AFTER_DAYS = 30;

/** A freshly minted token and the values derived from it that are safe to store. */
export interface GeneratedToken {
  /** The credential. Shown once, stored by the client, never persisted by us. */
  readonly token: string;
  /** `sha256(token)`; what the row keeps. */
  readonly tokenHash: Buffer;
  /** First {@link TOKEN_DISPLAY_PREFIX_LENGTH} characters. */
  readonly tokenPrefix: string;
}

/**
 * Generates a token.
 *
 * `randomBytes` is the CSPRNG, not `Math.random`: a token that is guessable from its neighbours is not a token.
 *
 * @returns The token, its digest and its display prefix.
 */
export function generateToken(): GeneratedToken {
  const token = `${TOKEN_MARKER}${randomBytes(TOKEN_BYTE_LENGTH).toString('base64url')}`;
  return {
    token,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * Digests a presented token.
 *
 * SHA-256 is the right hash here and Argon2 is not: the input is 256 bits of uniform randomness, so there is no
 * dictionary to slow down, and the digest has to be *cheap* because it runs on every admin request.
 *
 * @param token - Token as presented, verbatim. Not trimmed, not lower-cased: a token is a byte string.
 * @returns The 32-byte digest stored in `admin_tokens.token_hash`.
 */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Reports whether a string could be a token, without touching the database.
 *
 * @param value - Candidate, e.g. the part of `Authorization: Bearer …` after the scheme.
 * @returns `true` for `mm_` plus 43 base64url characters.
 */
export function isTokenShaped(value: string): boolean {
  return value.length === TOKEN_MARKER.length + 43 && TOKEN_PATTERN.test(value);
}

/** What a caller supplies when minting a token. */
export interface IssueTokenOptions {
  /** Lifetime from `AUTH_TOKEN_TTL_HOURS`. Validated here, because a bad value would mint an unusable token. */
  readonly ttlHours: number;
  /** Instant the token is issued at; defaults to the clock. Injectable so tests can move time. */
  readonly now?: Date;
  /** User-Agent of the request that logged in, for the sessions list. */
  readonly userAgent?: string | null;
  /** Client address (`inet` text form), for the sessions list and for an operator investigating a session. */
  readonly ip?: string | null;
}

/** A token that has just been minted. The plaintext exists only in this object. */
export interface IssuedToken {
  readonly token: string;
  readonly tokenId: string;
  readonly tokenPrefix: string;
  readonly expiresAt: Date;
}

/**
 * Mints a token for an admin and stores only its digest.
 *
 * @param executor - Kysely instance or an enclosing transaction (the login flow may want the row and the audit entry
 * to commit together).
 * @param adminId - Owner; the foreign key refuses an unknown admin.
 * @param options - TTL, clock, and request context.
 * @returns The plaintext token (shown once), its id, prefix and expiry.
 * @throws {RangeError} When `ttlHours` is not a positive finite number.
 */
export async function issueToken(
  executor: TokenExecutor,
  adminId: string,
  options: IssueTokenOptions,
): Promise<IssuedToken> {
  if (!Number.isFinite(options.ttlHours) || options.ttlHours <= 0) {
    throw new RangeError(`ttlHours must be a positive number of hours, got ${options.ttlHours}`);
  }

  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + options.ttlHours * 3_600_000);
  const generated = generateToken();

  const row = await insertToken(executor, {
    adminId,
    tokenHash: generated.tokenHash,
    tokenPrefix: generated.tokenPrefix,
    expiresAt,
    userAgent: options.userAgent ?? null,
    ip: options.ip ?? null,
  });

  return {
    token: generated.token,
    tokenId: row.id,
    tokenPrefix: row.token_prefix,
    expiresAt: row.expires_at,
  };
}

/** The token facts a caller may need after a successful verification (the `/me` endpoint, the guard's logs). */
export interface VerifiedToken {
  readonly id: string;
  readonly prefix: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  /** Recorded use, at minute resolution; `null` until the first request after minting. */
  readonly lastUsedAt: Date | null;
}

/**
 * The outcome of verifying a presented token.
 *
 * A discriminated union rather than `null`: the API has four different answers to give (`UNAUTHENTICATED`,
 * `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `ACCOUNT_DISABLED`) and collapsing them loses the one piece of information the
 * SPA needs to decide whether to show "session ended" or "log in again".
 */
export type TokenVerdict =
  | { readonly status: 'valid'; readonly admin: AdminIdentity; readonly token: VerifiedToken }
  | {
      readonly status: 'expired' | 'revoked' | 'disabled';
      readonly admin: AdminIdentity;
      readonly token: VerifiedToken;
    }
  | { readonly status: 'unknown' };

/**
 * Verifies a bearer token and records its use.
 *
 * Order of the checks, and why: an unknown token is answered first (no row, nothing to say), then revocation, then
 * expiry, then the account. Revocation before expiry because a revoked token stays revoked even once it is also
 * expired — "you were signed out" is the more useful of two true statements. The account check is last because it is
 * about the *admin*, not the token: a live token on a deactivated account is `ACCOUNT_DISABLED`, which is a `403`,
 * not a `401`.
 *
 * A successful verification also touches `last_used_at`, throttled to once a minute by the repository. That write is
 * on the request path on purpose — the alternative is a background job whose only job is to record something nobody
 * needs within a minute either way.
 *
 * @param executor - Kysely instance or transaction.
 * @param presented - The token exactly as it arrived.
 * @param options - Clock, injectable for tests.
 * @returns The verdict; `unknown` covers a malformed token, a token that never existed and one that was deleted.
 */
export async function verifyToken(
  executor: TokenExecutor,
  presented: string,
  options: { readonly now?: Date } = {},
): Promise<TokenVerdict> {
  // Cheapest rejection first: a token that cannot be one is answered without a query.
  if (!isTokenShaped(presented)) return { status: 'unknown' };

  const now = options.now ?? new Date();
  const found = await findTokenWithAdmin(executor, hashToken(presented));
  if (found === null) return { status: 'unknown' };

  const { admin, token } = found;
  const facts: VerifiedToken = {
    id: token.id,
    prefix: token.token_prefix,
    expiresAt: token.expires_at,
    createdAt: token.created_at,
    lastUsedAt: token.last_used_at,
  };

  if (token.revoked_at !== null) return { status: 'revoked', admin, token: facts };
  if (token.expires_at.getTime() <= now.getTime())
    return { status: 'expired', admin, token: facts };
  if (!admin.isActive) return { status: 'disabled', admin, token: facts };

  const touched = await touchLastUsed(executor, token.id, now, LAST_USED_RESOLUTION_MS);
  return {
    status: 'valid',
    admin,
    // Report the value the row now holds: when the throttle let the write through, that is `now`.
    token: { ...facts, lastUsedAt: touched ? now : facts.lastUsedAt },
  };
}

/**
 * Revokes the presented token, and only it.
 *
 * @param executor - Kysely instance or transaction.
 * @param presented - The token exactly as it arrived.
 * @param options - Clock, injectable for tests.
 * @returns `true` when a live row was revoked; `false` for an unknown, malformed or already-revoked token.
 */
export async function revokeToken(
  executor: TokenExecutor,
  presented: string,
  options: { readonly now?: Date } = {},
): Promise<boolean> {
  if (!isTokenShaped(presented)) return false;
  return revokeTokenByHash(executor, hashToken(presented), options.now ?? new Date());
}

/**
 * Revokes every live token of one admin ("log out everywhere", and what a password reset does).
 *
 * @param executor - Kysely instance or transaction; the reset script passes a transaction so the password change
 * and the revocations commit together.
 * @param adminId - Owner whose sessions end.
 * @param options - Clock, injectable for tests.
 * @returns How many tokens were revoked.
 */
export async function revokeAllTokens(
  executor: TokenExecutor,
  adminId: string,
  options: { readonly now?: Date } = {},
): Promise<number> {
  return revokeTokensForAdmin(executor, adminId, options.now ?? new Date());
}

/**
 * Deletes tokens that expired more than {@link PRUNE_AFTER_DAYS} ago.
 *
 * Called once at boot (`plugins/db.ts`). A row for a token that expired yesterday is already unusable; it is kept for
 * a month so the sessions list can still explain what happened, then removed so the table does not grow forever.
 *
 * @param executor - Kysely instance or transaction.
 * @param options - Clock and retention window, both injectable.
 * @returns How many rows were deleted.
 * @throws {RangeError} When `afterDays` is negative or not finite.
 */
export async function pruneExpiredTokens(
  executor: TokenExecutor,
  options: { readonly now?: Date; readonly afterDays?: number } = {},
): Promise<number> {
  const afterDays = options.afterDays ?? PRUNE_AFTER_DAYS;
  if (!Number.isFinite(afterDays) || afterDays < 0) {
    throw new RangeError(`afterDays must be zero or more, got ${afterDays}`);
  }

  const now = options.now ?? new Date();
  return deleteExpiredTokens(executor, new Date(now.getTime() - afterDays * 86_400_000));
}
