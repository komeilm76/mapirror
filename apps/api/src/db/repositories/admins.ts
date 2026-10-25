/**
 * Typed queries for `admins` (`03-data-model.md` §2.1, tasks `P1-AUTH-03`, `P1-AUTH-06`).
 *
 * Three queries, and the lookup is not as obvious as it looks: the lookup is **case-insensitive**, because the unique
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

/**
 * Inserts an account and returns the row as stored.
 *
 * The unique index is on `lower(username)`, so a duplicate arrives as a Postgres `23505` rather than as a `select`
 * that could have missed the row in a race. Callers that must be idempotent (the bootstrap script, `P1-AUTH-06`) treat
 * that error as "somebody else created it" rather than as a failure — see `modules/auth/admin-accounts.ts`.
 *
 * @param executor - Kysely instance or transaction.
 * @param values - Username as it should be stored, and an Argon2id digest (never a plaintext password).
 * @param now - Creation instant; the caller's clock, so `created_at` and `updated_at` agree with an audit row.
 * @returns The inserted row.
 * @throws A `23505` unique-violation error when the username exists in any case.
 */
export async function insertAdmin(
  executor: TokenExecutor,
  values: { readonly username: string; readonly passwordHash: string },
  now: Date = new Date(),
) {
  return executor
    .insertInto('admins')
    .values({
      username: values.username,
      password_hash: values.passwordHash,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
