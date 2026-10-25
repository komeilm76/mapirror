/**
 * Typed queries for `admins` (`03-data-model.md` §2.1, task `P1-AUTH-03`).
 *
 * Two queries, and one of them is not as obvious as it looks: the lookup is **case-insensitive**, because the unique
 * index is `admins_username_key ON admins (lower(username))`. Matching `username = $1` would compile, run, and give a
 * different answer from the one the index enforces — `admin` would log in while `Admin` said "no such user" even
 * though the database would refuse to store both. It would also not use the index.
 *
 * @module db/repositories/admins
 */

import { sql, type SqlBool } from 'kysely';

import type { TokenExecutor } from './admin-tokens';
import type { Admin } from '../schema';

/**
 * Loads the account a login attempt names, or `null`.
 *
 * @param executor - Kysely instance or transaction.
 * @param username - Submitted name, any case. Trimmed here rather than by the caller, so every caller agrees.
 * @returns The row (including `password_hash` and `is_active`), or `null`.
 */
export async function findAdminByUsername(
  executor: TokenExecutor,
  username: string,
): Promise<Admin | null> {
  const row = await executor
    .selectFrom('admins')
    .selectAll()
    // `ILIKE` would match `%` and `_` in the submitted name as wildcards — a login that accepts `adm%` is not a
    // login. `lower()` on both sides matches the expression the unique index is built on, so the index is used.
    .where(sql<SqlBool>`lower(username) = lower(${username.trim()})`)
    .executeTakeFirst();

  return row ?? null;
}

/**
 * Records a successful login.
 *
 * `updated_at` moves with it: the column is for "when did this account last change", and a login is the change the
 * operator asks about ("has anyone used this account since the reset?").
 *
 * @param executor - Kysely instance or transaction.
 * @param adminId - Account that logged in.
 * @param now - Instant of the login; the caller's clock, so the token row and this column agree to the millisecond.
 */
export async function recordLogin(
  executor: TokenExecutor,
  adminId: string,
  now: Date,
): Promise<void> {
  await executor
    .updateTable('admins')
    .set({ last_login_at: now, updated_at: now })
    .where('id', '=', adminId)
    .execute();
}
