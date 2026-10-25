/**
 * Typed queries for `admin_tokens` (task `P1-AUTH-02`, table in `03-data-model.md` §2.2).
 *
 * A repository, not a service: it knows columns and nothing else. No hashing, no TTL policy, no clock beyond what
 * the caller passes in — every method takes `now` (or a cutoff) as a value so a test can move time without waiting
 * for it, and so a single request handles one consistent instant.
 *
 * The one query that is not obvious is {@link findTokenWithAdmin}: verification needs the token *and* the account
 * state (`is_active`) to answer "may this bearer act?", and asking twice would be two round trips on every admin
 * request. The join returns both, and `admin_tokens.token_hash` is unique, so it returns at most one row.
 *
 * @module db/repositories/admin-tokens
 */

import type { Kysely, Transaction } from 'kysely';

import type { AdminToken, Database } from '../schema';

/**
 * What these query functions accept.
 *
 * A `Kysely` instance or an enclosing transaction (Kysely 0.29 does not nest them, so a caller that already holds
 * one passes it down — `09-development.md` §6). Both expose the query builder the repository needs.
 */
export type TokenExecutor = Kysely<Database> | Transaction<Database>;

/** The columns a caller supplies when minting a token; the rest have defaults. */
export interface NewTokenRow {
  /** Owner. `ON DELETE CASCADE` ends their sessions with the account. */
  readonly adminId: string;
  /** `sha256(token)`, exactly 32 bytes — the column's `CHECK` refuses anything else. */
  readonly tokenHash: Buffer;
  /** First 8 characters, for the sessions list. Never sufficient to reconstruct the token. */
  readonly tokenPrefix: string;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  /** Text form (`10.0.0.1`); the `inet` column accepts it. */
  readonly ip: string | null;
}

/** The part of an admin row a token request is authorised against. */
export interface AdminIdentity {
  readonly id: string;
  readonly username: string;
  /** `false` for a deactivated account: the token may be live, the account may not act. */
  readonly isActive: boolean;
}

/** A token row together with its owner, as verification needs them. */
export interface TokenWithAdmin {
  readonly token: AdminToken;
  readonly admin: AdminIdentity;
}

/**
 * Inserts a token row and returns it as stored.
 *
 * @param executor - Kysely instance or transaction.
 * @param row - Owner, hash, prefix, expiry and request context.
 * @returns The inserted row, including the generated `id` and `created_at`.
 */
export async function insertToken(executor: TokenExecutor, row: NewTokenRow): Promise<AdminToken> {
  return executor
    .insertInto('admin_tokens')
    .values({
      admin_id: row.adminId,
      token_hash: row.tokenHash,
      token_prefix: row.tokenPrefix,
      expires_at: row.expiresAt,
      user_agent: row.userAgent,
      ip: row.ip,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Looks a token up by the digest of what was presented, joining the account that owns it.
 *
 * The lookup is an equality probe on `admin_tokens_hash_key`, a unique index over the **digest** — never over the
 * token, which is not stored anywhere. There is therefore no comparison of a secret in application code: the
 * database matches 32 hashed bytes, and a wrong token produces the same statement as a right one.
 *
 * @param executor - Kysely instance or transaction.
 * @param tokenHash - `sha256` of the presented token.
 * @returns The row and its admin, or `null` when no token has that digest.
 */
export async function findTokenWithAdmin(
  executor: TokenExecutor,
  tokenHash: Buffer,
): Promise<TokenWithAdmin | null> {
  const row = await executor
    .selectFrom('admin_tokens as token')
    .innerJoin('admins as admin', 'admin.id', 'token.admin_id')
    .selectAll('token')
    .select(['admin.username as admin_username', 'admin.is_active as admin_is_active'])
    .where('token.token_hash', '=', tokenHash)
    .executeTakeFirst();

  if (row === undefined) return null;

  const { admin_username: username, admin_is_active: isActive, ...token } = row;
  return { token, admin: { id: token.admin_id, username, isActive } };
}

/**
 * Records that a token was used, at most once per {@link minAgeMs}.
 *
 * `last_used_at` is diagnostic (the sessions list, "when was this token last seen"), not a security control, so the
 * update is throttled: without the guard every admin request would be a write, and the table would take the write
 * amplification of the whole read path. The throttle is expressed in the `WHERE` clause rather than by reading the
 * row and comparing in JavaScript, so two requests arriving together cannot both decide the write is due.
 *
 * @param executor - Kysely instance or transaction.
 * @param id - Token row id.
 * @param now - Instant to record.
 * @param minAgeMs - Minimum age of the stored `last_used_at` for the update to apply.
 * @returns Whether a row was actually written.
 */
export async function touchLastUsed(
  executor: TokenExecutor,
  id: string,
  now: Date,
  minAgeMs: number,
): Promise<boolean> {
  const due = new Date(now.getTime() - minAgeMs);
  const result = await executor
    .updateTable('admin_tokens')
    .set({ last_used_at: now })
    .where('id', '=', id)
    .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', due)]))
    .executeTakeFirst();

  return Number(result.numUpdatedRows) > 0;
}

/**
 * Revokes the token with this digest, if it is still live.
 *
 * `revoked_at IS NULL` makes the operation idempotent: logging out twice revokes once, and the second call cannot
 * overwrite the original revocation time — which is the value an audit screen shows.
 *
 * @param executor - Kysely instance or transaction.
 * @param tokenHash - `sha256` of the presented token.
 * @param now - Revocation instant.
 * @returns `true` when a live row was revoked; `false` when there was nothing to revoke.
 */
export async function revokeTokenByHash(
  executor: TokenExecutor,
  tokenHash: Buffer,
  now: Date,
): Promise<boolean> {
  const result = await executor
    .updateTable('admin_tokens')
    .set({ revoked_at: now })
    .where('token_hash', '=', tokenHash)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows) > 0;
}

/**
 * Revokes every live token of one admin.
 *
 * Used by the reset-password script (`P1-AUTH-07`) and by "log out everywhere": a credential change must cut off
 * sessions that were minted under the old one.
 *
 * @param executor - Kysely instance or transaction.
 * @param adminId - Owner whose sessions end.
 * @param now - Revocation instant, shared by every row so the audit reads consistently.
 * @returns How many rows were revoked.
 */
export async function revokeTokensForAdmin(
  executor: TokenExecutor,
  adminId: string,
  now: Date,
): Promise<number> {
  const results = await executor
    .updateTable('admin_tokens')
    .set({ revoked_at: now })
    .where('admin_id', '=', adminId)
    .where('revoked_at', 'is', null)
    .execute();

  // Summed rather than read off `executeTakeFirst()`: one statement yields one result, but the sum has no
  // unreachable `undefined` branch to mark as covered by a test that cannot reach it.
  return results.reduce((total, result) => total + Number(result.numUpdatedRows), 0);
}

/**
 * Deletes rows that expired before `cutoff`.
 *
 * Expired rows are already useless — verification refuses them — so this is housekeeping, which is why it only
 * touches rows that have been expired for a while (`03-data-model.md` §2.2: 30 days). Deleting them the moment they
 * expire would erase the record of *when* a session ended, which is exactly what an operator looks at after an
 * incident.
 *
 * @param executor - Kysely instance or transaction.
 * @param cutoff - Rows with `expires_at < cutoff` are deleted.
 * @returns How many rows were deleted.
 */
export async function deleteExpiredTokens(executor: TokenExecutor, cutoff: Date): Promise<number> {
  const result = await executor
    .deleteFrom('admin_tokens')
    .where('expires_at', '<', cutoff)
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}
