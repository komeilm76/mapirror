/**
 * The login flow (`P1-AUTH-03`, requirements AUTH-2 and AUTH-5).
 *
 * Everything that decides "may this person in" lives here, in one readable order. The order is the design, so it is
 * stated once and tested:
 *
 * 1. **Throttle first.** Before the password is touched. A locked-out client costs a map lookup; verifying anyway
 *    would spend 64 MiB of Argon2 memory per attempt, which is exactly the amplification the throttle exists to stop.
 * 2. **Find the account** by case-insensitive username (the expression the unique index is built on).
 * 3. **Verify the password — always.** When the username does not exist, the submitted password is verified against a
 *    fixed dummy hash so the request costs the same ~74 ms as a wrong password for a real account. Without that, "no
 *    such user" answers in a millisecond and "wrong password" in seventy, and the difference is a username oracle.
 * 4. **Then, and only then, look at the account.** A deactivated account answers `403 ACCOUNT_DISABLED`, but only
 *    after the password checked out: answering `403` to a wrong password would confirm the username to an attacker
 *    who has nothing.
 * 5. **On success**, one transaction locks and rechecks the account hash before writing the token, `last_login_at` and
 *    the audit row. That closes the race where a password reset commits after verification but before token issuance;
 *    all three writes still commit together, because a session without an audit entry is precisely what the audit log
 *    is for.
 *
 * A failed attempt writes an `auth.login_failed` row and counts against the throttle. That write is deliberately
 * *outside* the transaction (there is none on this path) and wrapped: a broken audit table must not turn a `401` into
 * a `500`, and the failure count matters more than the row.
 *
 * @module modules/auth/service
 */

import type { LoginResponse } from '@mapirror/shared';
import type { Kysely } from 'kysely';

import { insertAuditLog, AUDIT_ACTIONS } from '../../db/repositories/audit-logs';
import { findAdminByUsername, recordLogin } from '../../db/repositories/admins';
import type { Database } from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import { normaliseIp } from '../../lib/client-ip';
import { AppError } from '../../lib/errors';
import { verifyPassword } from './password';
import type { LoginThrottle } from './login-throttle';
import { issueToken } from './tokens';

/**
 * A hash of a secret nobody holds, used to spend the same time on an unknown username as on a wrong password.
 *
 * Generated once with this module's own parameters (`ARGON2_PARAMS`, 64 MiB / 3 passes) and pasted in as a constant
 * rather than computed at import: hashing at startup would cost 74 ms of boot and, worse, would make the *first*
 * unknown-user login wait for a promise nobody awaited. The password behind it was 64 random hex characters that were
 * discarded, so nothing can verify against it — the only property this string needs is "costs a full verification".
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$yed6kD2hzR9tf9BDYUNjXg$G7r08y9dkScAqYtGYE8miteQ5fisww/r3zamRG8xC2o';

/** The sentence a failed login answers with, for every reason a *credential* check can fail. */
const INVALID_CREDENTIALS_MESSAGE = 'The username or password is incorrect.';

/** What the login flow needs from the process. */
export interface LoginDeps {
  /** Pool-level Kysely instance: success runs in a transaction, so a `Transaction` is not accepted here. */
  readonly database: Kysely<Database>;
  /** Shared throttle (`P1-AUTH-03`); one per process. */
  readonly throttle: LoginThrottle;
  /** Token lifetime, `AUTH_TOKEN_TTL_HOURS`. */
  readonly tokenTtlHours: number;
  /** Client address as submitted — normalised here. `request.ip`, which is untrusted (pass 22). */
  readonly ip?: string | null;
  /** `User-Agent`, stored on the token row for the sessions list. */
  readonly userAgent?: string | null;
  /** Clock, injected so tests can drive a lockout window without waiting. */
  readonly now?: Date;
  /** Where a failure to *record* a failure is reported. Optional: a caller without a logger loses the line, not the
   * behaviour. */
  readonly log?: { readonly warn: (context: object, message: string) => void };
}

/** What the route sends back, and what the SPA stores. */
export type LoginResult = LoginResponse;

/**
 * Authenticates an admin and mints a bearer token.
 *
 * @param deps - Database, throttle, configuration and request context.
 * @param request - Parsed body (`LoginRequestSchema`).
 * @returns The token (shown once), its expiry and the admin profile.
 * @throws {AppError} `RATE_LIMITED`/429 with `details.lockedUntil` and `details.retryAfterSeconds`,
 * `INVALID_CREDENTIALS`/401 (one generic message for every credential failure), or `ACCOUNT_DISABLED`/403 for a
 * deactivated account whose password was correct.
 */
export async function login(deps: LoginDeps, request: LoginRequestLike): Promise<LoginResult> {
  const now = deps.now ?? new Date();
  const ip = normaliseIp(deps.ip);
  const username = request.username.trim();
  const { throttle } = deps;

  // `check` **reserves** a slot when it allows the attempt, so a burst of concurrent logins cannot all pass the same
  // empty counter and each get a full Argon2 verify (measured, pass 28). Every path below therefore settles the
  // reservation exactly once — `recordFailure`, `recordSuccess` or `release` — and the `finally` is what makes that
  // true for the paths nobody wrote on purpose.
  const verdict = throttle.check(ip, username);
  if (verdict.limited) {
    throw new AppError('RATE_LIMITED', 'Too many failed sign-in attempts. Wait and try again.', {
      lockedUntil: verdict.lockedUntil.toISOString(),
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  let settled = false;
  try {
    const admin = await findAdminByUsername(deps.database, username);
    // `verifyPassword` on the dummy hash when there is no account: same algorithm, same parameters, same time.
    const passwordMatches = await verifyPassword(
      admin?.password_hash ?? DUMMY_PASSWORD_HASH,
      request.password,
    );

    if (admin === null || !passwordMatches) {
      throttle.recordFailure(ip, username);
      settled = true;
      await recordFailure(deps, {
        adminId: admin?.id ?? null,
        actorName: admin?.username ?? username,
        metadata: { reason: admin === null ? 'unknown_username' : 'wrong_password' },
        ip,
      });
      throw new AppError('INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
    }

    if (!admin.is_active) {
      // Reached only with a *correct* password, which is why it can be a 403 that names the account's state: the caller
      // has already proved they know the secret, so there is no username to leak. It is not counted against the
      // throttle — the credentials were right, and locking the account out would punish the person who can prove they
      // are entitled to it. The reservation is given back rather than recorded: the account state, not the credentials,
      // decided this answer, so the failures already on the counter stay there.
      throttle.release(ip, username);
      settled = true;
      await recordFailure(deps, {
        adminId: admin.id,
        actorName: admin.username,
        metadata: { reason: 'account_disabled' },
        ip,
      });
      throw new AppError(
        'ACCOUNT_DISABLED',
        'This account is deactivated. Ask an operator to re-enable it.',
      );
    }

    let rejectedAfterVerify: 'credentials-changed' | 'disabled' | null = null;
    let issued: Awaited<ReturnType<typeof issueToken>>;
    try {
      issued = await withTransaction(deps.database, async (trx) => {
        // Password verification happened before this transaction to keep Argon2 out of a held DB connection. Lock and
        // recheck the account row before issuing: if a reset committed in that gap, the old password must not mint a
        // post-reset token. If this lock wins the race, the reset waits and revokes the token after this commit.
        const current = await trx
          .selectFrom('admins')
          .select(['password_hash', 'is_active'])
          .where('id', '=', admin.id)
          .forUpdate()
          .executeTakeFirst();

        if (current === undefined || current.password_hash !== admin.password_hash) {
          rejectedAfterVerify = 'credentials-changed';
          throw new AppError('INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
        }
        if (!current.is_active) {
          rejectedAfterVerify = 'disabled';
          throw new AppError(
            'ACCOUNT_DISABLED',
            'This account is deactivated. Ask an operator to re-enable it.',
          );
        }

        const token = await issueToken(trx, admin.id, {
          ttlHours: deps.tokenTtlHours,
          now,
          userAgent: deps.userAgent ?? null,
          ip,
        });
        await recordLogin(trx, admin.id, now);
        await insertAuditLog(trx, {
          actorId: admin.id,
          actorName: admin.username,
          action: AUDIT_ACTIONS.login,
          ip,
          // The token id, not the token: an audit row must never hold a credential, and the id is what a "revoke this
          // session" screen needs.
          targetType: 'admin_token',
          targetId: token.tokenId,
          metadata: { userAgent: deps.userAgent ?? null },
        });
        return token;
      });
    } catch (error) {
      if (rejectedAfterVerify === 'credentials-changed') {
        // The presented secret is no longer valid. Count it and audit it like a wrong password, but keep the public
        // answer generic so a reset racing with a request reveals no account state.
        throttle.recordFailure(ip, username);
        settled = true;
        await recordFailure(deps, {
          adminId: admin.id,
          actorName: admin.username,
          metadata: { reason: 'password_changed_during_login' },
          ip,
        });
      } else if (rejectedAfterVerify === 'disabled') {
        throttle.release(ip, username);
        settled = true;
        await recordFailure(deps, {
          adminId: admin.id,
          actorName: admin.username,
          metadata: { reason: 'account_disabled' },
          ip,
        });
      }
      throw error;
    }

    // Only after the token, the login record and the audit row committed: a transaction that failed is not a success
    // that should forgive the failures before it.
    throttle.recordSuccess(ip, username);
    settled = true;

    return {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      admin: { id: admin.id, username: admin.username },
    };
  } finally {
    // A database error, a bad hash, a bug: the attempt neither succeeded nor failed, and the reservation must go back
    // or the allowance shrinks by one for the life of the process.
    if (!settled) throttle.release(ip, username);
  }
}

/** The two fields login reads. A structural type rather than the Zod-inferred one, so the service can be called from a
 * test or a script without a schema parse in between. */
export interface LoginRequestLike {
  readonly username: string;
  readonly password: string;
}

/**
 * Writes a failed-attempt audit row, swallowing (and reporting) its own failure.
 *
 * A failed login must answer `401` even when the audit table is unavailable. The alternative — propagating — turns a
 * logging problem into "nobody can sign in", and the operator would learn about it as an outage rather than as a
 * warning line.
 *
 * @param deps - For the database handle and the optional logger.
 * @param entry - Actor, reason and address.
 */
async function recordFailure(
  deps: LoginDeps,
  entry: {
    readonly adminId: string | null;
    readonly actorName: string;
    readonly metadata: { readonly reason: string };
    readonly ip: string | null;
  },
): Promise<void> {
  try {
    await insertAuditLog(deps.database, {
      actorId: entry.adminId,
      // Snapshot: the submitted name when the account is unknown — that is what an attacker tried, and it is the
      // most useful thing in the row.
      actorName: entry.actorName,
      action: AUDIT_ACTIONS.loginFailed,
      ip: entry.ip,
      metadata: entry.metadata,
    });
  } catch (error) {
    deps.log?.warn({ err: error }, 'could not record a failed login attempt; the 401 stands');
  }
}
