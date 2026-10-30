/**
 * Typed queries for `audit_logs` (`03-data-model.md` §2.11, first written by `P1-AUTH-03`).
 *
 * Append-only by design: this module exports one function, and nothing anywhere updates or deletes a row. Two columns
 * carry that design:
 *
 * - `actor_name` is a **snapshot** of the username, not a join. The log has to read correctly after the account is
 *   deleted (`actor_id` is `ON DELETE SET NULL`), and a row that says "someone did this" is not an audit trail.
 * - `metadata` is `jsonb NOT NULL DEFAULT '{}'`, and it is the only free-form column — so it is the one that could
 *   accidentally hold a credential. {@link insertAuditLog} refuses values that are not JSON-safe rather than letting
 *   the driver stringify something surprising, and every caller in this codebase passes facts *about* an attempt
 *   (the username tried, the reason it failed), never the password or a token.
 *
 * @module db/repositories/audit-logs
 */

import type { TokenExecutor } from './admin-tokens';
import type { JsonValue } from '../schema';

/**
 * The actions this codebase writes, as constants.
 *
 * Not a database enum and not a `CHECK` constraint on purpose: the audit log must be able to record an action that a
 * future version introduced, and a constraint would make *logging* the failure the thing that fails. The list is the
 * contract with the UI (the audit screen filters on `auth.*`, `cache.*`, …) and with `04-api.md`, and a test asserts
 * every action used in code appears in the docs.
 *
 * Naming: `subject.verb_in_past_tense`, where the subject is the module. A failed login is `auth.login_failed` rather
 * than `auth.login` with `metadata.success: false`, because "show me the failed logins" must be one index scan on a
 * value that exists (`audit_logs_action_idx`), not a scan plus a JSON predicate.
 */
export const AUDIT_ACTIONS = {
  login: 'auth.login',
  loginFailed: 'auth.login_failed',
  logout: 'auth.logout',
  adminCreated: 'auth.admin_created',
  passwordReset: 'auth.password_reset',
  catalogSync: 'catalog.sync',
  cacheDeleteCountry: 'cache.delete_country',
  cachePublish: 'cache.publish',
  cacheUnpublish: 'cache.unpublish',
  versionDelete: 'version.delete',
  intervalCreate: 'interval.create',
  intervalUpdate: 'interval.update',
  intervalDelete: 'interval.delete',
} as const;

/** One documented audit action. */
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** What a caller supplies; every nullable column gets an explicit `null` rather than being omitted. */
export interface NewAuditLog {
  /** The account, when the action is attributed to one. `null` for a login attempt against an unknown username. */
  readonly actorId: string | null;
  /** Username snapshot: the account's name when known, otherwise the **submitted** name (which is the interesting
   * part of a failed attempt — it is what an attacker tried). */
  readonly actorName: string;
  /** One of {@link AUDIT_ACTIONS}, or a future action added there. */
  readonly action: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  /** Structured context. Never a password, a token or a hash. */
  readonly metadata?: JsonValue;
  /** Already normalised (`lib/client-ip.ts`); `inet` refuses anything else. */
  readonly ip?: string | null;
  /**
   * When it happened; the column defaults to `now()` and callers that serve a request leave this out.
   *
   * Supplied by a script (`P1-AUTH-06`), which creates the account and records it in one transaction: passing the same
   * instant to both inserts keeps the two rows pointing at one moment even when a test supplies the clock.
   */
  readonly at?: Date;
}

/**
 * Appends one row.
 *
 * @param executor - Kysely instance or transaction. A caller that is already in a transaction passes it, so the audit
 * row commits with the change it describes.
 * @param entry - What happened.
 * @returns The row as stored, including its generated id.
 */
export async function insertAuditLog(executor: TokenExecutor, entry: NewAuditLog) {
  return executor
    .insertInto('audit_logs')
    .values({
      actor_id: entry.actorId,
      actor_name: entry.actorName,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      ...(entry.at === undefined ? {} : { created_at: entry.at }),
      ip: entry.ip ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
