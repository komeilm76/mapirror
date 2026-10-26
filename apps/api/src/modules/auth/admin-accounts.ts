/**
 * Creating the first admin account (`P1-AUTH-06`, requirement AUTH-1).
 *
 * The scripts in `scripts/init-admin.ts` and `scripts/reset-admin-password.ts` are the operator's front doors; this
 * module is the part that has to be *right*, and it is here rather than in the scripts because the same rules are
 * needed by any future "add an admin" endpoint:
 *
 * 1. **The username is validated against the login contract, not against a second opinion.** `04-api.md` §1 accepts
 *    1–64 characters, and the login lookup compares `lower(username)` after trimming the submitted name. A name that
 *    the login route would refuse — or that trimming would make unmatchable — can be *stored* and then never *used*,
 *    which is the same failure the password ceiling had in pass 20 (`16-changelog.md`). So the name is trimmed
 *    (usernames are identifiers, not secrets), bounded, and refused if it contains a control character — a newline in
 *    a username is log injection in the audit row and on the operator's terminal.
 * 2. **The password policy is enforced here.** AUTH-1 says so, and this is the only place a password is chosen without
 *    a human reading an error message mid-form: the operator sees every broken rule at once.
 * 3. **Creating is idempotent, and never overwrites.** A second run reports the existing account and changes nothing —
 *    not the hash, not `is_active`. Changing a password is `reset-admin-password.ts`'s job (`P1-AUTH-07`), and a
 *    bootstrap that quietly reset it would let anyone who can restart the container take over the account.
 * 4. **Creation is audited.** One row, in the same transaction as the insert: an account that exists with no record of
 *    how it appeared is the one question an operator cannot answer later.
 * 5. **A reset changes the password and ends the sessions, in one transaction** ({@link resetAdminPassword}). The order
 *    matters in the other direction from creation: the new hash commits *with* the revocations and *with* the audit row,
 *    because a reset that half-applied would leave either the old password working (a failed update) or a live session
 *    holding a token the operator believes they killed (a failed revocation).
 *
 * @module modules/auth/admin-accounts
 */

import { LOGIN_USERNAME_MAX } from '@mapirror/shared';
import type { Kysely } from 'kysely';

import type { TokenExecutor } from '../../db/repositories/admin-tokens';
import { insertAuditLog, AUDIT_ACTIONS } from '../../db/repositories/audit-logs';
import {
  findAdminByUsername,
  insertAdmin,
  updateAdminPassword,
} from '../../db/repositories/admins';
import { revokeAllTokens } from './tokens';
import type { Admin, Database } from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import { hashPassword, assertPasswordAcceptable } from './password';

/** What may be wrong with a submitted username; each entry is a sentence for the operator. */
export interface UsernameProblem {
  /** Rule that was broken, so a caller can branch without parsing prose. */
  readonly rule: 'empty' | 'too-long' | 'control-character';
  /** User-facing sentence. Never contains the name itself — it may be the thing being rejected. */
  readonly message: string;
}

/** Raised when a username cannot be stored. */
export class AdminUsernameError extends Error {
  /** Every rule the name broke. */
  readonly problems: readonly UsernameProblem[];

  /**
   * @param problems - Non-empty list of failures.
   */
  constructor(problems: readonly UsernameProblem[]) {
    super(problems.map((problem) => problem.message).join(' '));
    this.name = 'AdminUsernameError';
    this.problems = problems;
  }
}

/**
 * Reports whether a string contains a C0 or C1 control character (NUL, tab, newline, escape, …).
 *
 * Written as a code-point test rather than `/\u0000-\u001F/u` because ESLint's `no-control-regex` is right to flag the
 * pattern: a control character in a regex literal is unreadable in a diff and invisible in a review. Comparing numbers
 * says the same thing in a form a reviewer can check.
 *
 * @param value - Candidate string.
 * @returns `true` when any character is below U+0020 or in U+007F–U+009F.
 */
function hasControlCharacter(value: string): boolean {
  // Iterated by code unit, so there is no `undefined` case to handle: `codePointAt` can return `undefined` and the
  // `?? 0` that guarded it was a branch nothing could ever take (found by the coverage report in pass 26).
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Validates and normalises a username for storage.
 *
 * Trimming is deliberate and is the one silent change made to operator input: `findAdminByUsername` trims what it
 * compares, so a stored `" admin "` could never be matched by a login, while a stored `"admin"` is what the operator
 * meant. A *password* is never treated this way — trimming a secret changes it; trimming an identifier does not.
 *
 * @param input - Name as supplied by a flag, an environment variable or a prompt.
 * @returns The name to store, trimmed.
 * @throws {AdminUsernameError} When the name is empty, longer than the login contract accepts, or contains a control
 * character.
 */
export function parseAdminUsername(input: string): string {
  const trimmed = input.trim();
  const problems: UsernameProblem[] = [];

  if (trimmed.length === 0) {
    problems.push({ rule: 'empty', message: 'A username is required.' });
  } else if ([...trimmed].length > LOGIN_USERNAME_MAX) {
    problems.push({
      rule: 'too-long',
      message: `Use at most ${String(LOGIN_USERNAME_MAX)} characters — the login endpoint refuses anything longer.`,
    });
  }

  // Checked on the raw input, not the trimmed one: trimming removes the outer whitespace, and a newline *inside* a name
  // is the case that breaks a log line.
  if (hasControlCharacter(input)) {
    problems.push({
      rule: 'control-character',
      message: 'The username must not contain control characters or line breaks.',
    });
  }

  if (problems.length > 0) throw new AdminUsernameError(problems);
  return trimmed;
}

/** The account, as the caller may report it back. Deliberately without the hash. */
export interface EnsuredAdmin {
  readonly id: string;
  readonly username: string;
  /** `false` when the account exists but has been deactivated — the script warns, and changes nothing. */
  readonly isActive: boolean;
}

/** What {@link ensureAdmin} did. */
export type EnsureAdminOutcome =
  | { readonly status: 'created'; readonly admin: EnsuredAdmin }
  | { readonly status: 'exists'; readonly admin: EnsuredAdmin };

/**
 * Narrows a stored row to what a caller may report back.
 *
 * One definition for the three places that answer "which account, and is it active" — the lookup below, the
 * already-exists branch of {@link ensureAdmin}, and the branch that loses a creation race. They must agree: an account
 * that reads as active in one of them and deactivated in another is a message an operator cannot act on.
 *
 * @param row - Row from `admins`, with `password_hash` and timestamps that are nobody's business here.
 * @returns The same account without the hash.
 */
function toEnsuredAdmin(row: Admin): EnsuredAdmin {
  return { id: row.id, username: row.username, isActive: row.is_active };
}

/**
 * Reports the account with this name, or `null` when there is none.
 *
 * Exists for the container entrypoint (`P1-DOCK-04`): on every boot after the first there is nothing to create, and
 * `init-admin --bootstrap` has to establish that **before** asking for a password — a restart with `ADMIN_PASSWORD`
 * removed from `.env` must not be refused by a script whose whole job at that point is to say "already there". The
 * username is validated through the same contract as creation, so a bootstrap cannot report on a name the login route
 * would never accept.
 *
 * @param executor - Kysely instance or transaction.
 * @param username - Submitted name, any case and any surrounding whitespace.
 * @returns The account, or `null`.
 * @throws {AdminUsernameError} When the name is not a username.
 */
export async function findExistingAdmin(
  executor: TokenExecutor,
  username: string,
): Promise<EnsuredAdmin | null> {
  const existing = await findAdminByUsername(executor, parseAdminUsername(username));
  return existing === null ? null : toEnsuredAdmin(existing);
}

/** What {@link ensureAdmin} needs. */
export interface EnsureAdminOptions {
  /** Name to create, in any case and with any surrounding whitespace. */
  readonly username: string;
  /** Plaintext password. Checked against the policy, hashed, and never stored or logged in the clear. */
  readonly password: string;
  /** Clock, injectable so a test can assert `created_at` and the audit row's instant together. */
  readonly now?: Date;
  /** Who created it, recorded in the audit row. The script passes `init-admin`. */
  readonly actorName?: string;
}

/**
 * Creates the admin account if it does not exist, and reports which of the two happened.
 *
 * Everything that can be refused is refused **before** the database is touched: a weak password costs a policy check,
 * not a hash and a transaction. The insert is guarded by the `lower(username)` unique index, so a concurrent second run
 * loses the race as a `23505` and is reported as `exists` — the same answer, arrived at safely.
 *
 * @param database - Kysely instance. A transaction is opened internally, so the account and its audit row commit
 * together.
 * @param options - Name, password, clock and audit actor.
 * @returns `created` with the new account, or `exists` with the one that was already there (unchanged).
 * @throws {AdminUsernameError} When the name is unusable.
 * @throws {PasswordPolicyError} When the password breaks the policy; the error lists every rule.
 */
export async function ensureAdmin(
  database: Kysely<Database>,
  options: EnsureAdminOptions,
): Promise<EnsureAdminOutcome> {
  const username = parseAdminUsername(options.username);
  assertPasswordAcceptable(options.password, { username });

  const now = options.now ?? new Date();
  const existing = await findAdminByUsername(database, username);
  if (existing !== null) return { status: 'exists', admin: toEnsuredAdmin(existing) };

  // Hashed outside the transaction: 74 ms of Argon2 holding a connection open is 74 ms of pool the API cannot use, and
  // nothing in the hash depends on what the transaction does.
  const passwordHash = await hashPassword(options.password);

  try {
    return await withTransaction(database, async (trx) => {
      const row = await insertAdmin(trx, { username, passwordHash }, now);

      await insertAuditLog(trx, {
        actorId: null,
        actorName: options.actorName ?? 'init-admin',
        action: AUDIT_ACTIONS.adminCreated,
        targetType: 'admin',
        targetId: row.id,
        metadata: { username: row.username },
        at: now,
      });

      return {
        status: 'created' as const,
        admin: { id: row.id, username: row.username, isActive: row.is_active },
      };
    });
  } catch (error) {
    // Somebody created the same name between the lookup and the insert. That is the *expected* outcome of two
    // containers booting at once, not an error: report the account, change nothing.
    //
    // The re-lookup runs on `database`, **not** on the failed transaction's connection: PostgreSQL marks a
    // transaction aborted after the first failed statement, so a second query inside it fails with "current
    // transaction is aborted" (measured — that was the shape of the first version of this branch, and
    // `integration/admin-accounts.spec.ts` caught it). `withTransaction` has rolled back by the time this runs.
    if (!isUniqueViolation(error)) throw error;
    const raced = await findAdminByUsername(database, username);
    if (raced === null) throw error;
    return { status: 'exists', admin: toEnsuredAdmin(raced) };
  }
}

/** Raised when a reset names an account that does not exist. */
export class AdminNotFoundError extends Error {
  /** The name that was looked up — an identifier the operator typed, not a secret. */
  readonly username: string;

  /**
   * @param username - Name as supplied, trimmed.
   */
  constructor(username: string) {
    super(`No admin account named '${username}'.`);
    this.name = 'AdminNotFoundError';
    this.username = username;
  }
}

/** What {@link resetAdminPassword} needs. */
export interface ResetAdminPasswordOptions {
  /** Account to reset, in any case and with any surrounding whitespace. */
  readonly username: string;
  /** New plaintext password. Checked against the policy, hashed, and never stored or logged in the clear. */
  readonly password: string;
  /** Clock, injectable so a test can assert `updated_at` and the audit row's instant together. */
  readonly now?: Date;
  /** Who did it, recorded in the audit row. The script passes `reset-admin-password`. */
  readonly actorName?: string;
}

/** What {@link resetAdminPassword} did. Deliberately without the hash. */
export interface ResetAdminPasswordResult {
  /** The account after the reset; `isActive: false` means the new password cannot log in until it is re-enabled. */
  readonly admin: EnsuredAdmin;
  /** Tokens revoked by this run — every session that was open, and only those still open. */
  readonly revokedTokens: number;
}

/**
 * Replaces an admin's password and revokes every open session, atomically (`P1-AUTH-07`, AUTH-4).
 *
 * "Revokes existing tokens" is the half of a password reset that is easy to leave out and matters most: without it, the
 * reason the operator is resetting — a lost laptop, a shared password, a session they no longer trust — keeps working
 * until it expires. The revocation is inside the same transaction as the new hash, so the two cannot disagree.
 *
 * A deactivated account can be reset (the operator may be preparing to re-enable it); the result says `isActive: false`
 * so the script can warn instead of implying the new password works.
 *
 * @param database - Kysely instance. The transaction is opened internally.
 * @param options - Username, new password, clock and audit actor.
 * @returns The account and how many sessions it killed.
 * @throws {AdminUsernameError} When the name is unusable by the login contract.
 * @throws {PasswordPolicyError} When the password breaks the policy; the error lists every rule.
 * @throws {AdminNotFoundError} When no account has that name, or it disappeared before the update — the transaction is
 * rolled back either way, so nothing is audited and no token is revoked.
 */
export async function resetAdminPassword(
  database: Kysely<Database>,
  options: ResetAdminPasswordOptions,
): Promise<ResetAdminPasswordResult> {
  const username = parseAdminUsername(options.username);
  assertPasswordAcceptable(options.password, { username });

  const now = options.now ?? new Date();
  const existing = await findAdminByUsername(database, username);
  if (existing === null) throw new AdminNotFoundError(username);

  // Hashed outside the transaction, as in `ensureAdmin`: 74 ms of Argon2 holding a pool slot buys nothing.
  const passwordHash = await hashPassword(options.password);

  return withTransaction(database, async (trx) => {
    const updated = await updateAdminPassword(trx, existing.id, passwordHash, now);
    // Deleted between the lookup and the update. Throwing rolls back the (empty) work and, more importantly, keeps the
    // caller from reporting "password updated" for an account that is no longer there.
    if (updated === null) throw new AdminNotFoundError(username);

    const revokedTokens = await revokeAllTokens(trx, updated.id, { now });

    await insertAuditLog(trx, {
      actorId: null,
      actorName: options.actorName ?? 'reset-admin-password',
      action: AUDIT_ACTIONS.passwordReset,
      targetType: 'admin',
      targetId: updated.id,
      // The count is the fact an operator asks about later ("were the other sessions actually killed?"). No hash, no
      // password, no token: `metadata` is the one free-form column and it carries facts *about* the change only.
      metadata: { username: updated.username, revokedTokens },
      at: now,
    });

    return {
      admin: { id: updated.id, username: updated.username, isActive: updated.is_active },
      revokedTokens,
    };
  });
}

/**
 * Reports whether an error is PostgreSQL's unique-violation (`23505`).
 *
 * Narrowed from `unknown` by shape rather than by `instanceof`: the driver's error class is not exported, and a
 * `code`-carrying object is exactly what it throws.
 *
 * @param error - Whatever the insert rejected with.
 * @returns `true` for a unique violation.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
