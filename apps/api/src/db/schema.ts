/**
 * Kysely types for the phase-1 tables (task `P1-DB-02`).
 *
 * The columns here mirror `03-data-model.md` §2.1, §2.2 and §2.11 and `0001_init.sql`. Repositories import these
 * types — never `any`, never `unknown` for a row — so a query against a column that does not exist fails to
 * compile instead of at 3 a.m. (`10-laws.md` L5).
 *
 * **Every select type below was measured, not assumed.** `pg` does not hand back what the SQL type suggests:
 *
 * | SQL | JS the driver actually returns |
 * |---|---|
 * | `bigserial` / `bigint` | **`string`** — int8 is returned as text to avoid losing precision past 2^53 |
 * | `uuid`, `inet`, `text` | `string` |
 * | `timestamptz` | `Date` |
 * | `bytea` | `Buffer` |
 * | `jsonb` | the parsed value (`object`, not a string) |
 * | `boolean` | `boolean` |
 *
 * `audit_logs.id` is the one that bites: typing it `number` compiles, reads correctly in a small database, and
 * silently compares wrong once the id is compared to a number, sorted, or sent as JSON. It is `string` here
 * because that is what arrives.
 *
 * Naming is the database's: `snake_case`, because a Kysely query is SQL with autocomplete, and `selectFrom('admins')
 * .select('password_hash')` reads as the column it is. Hand-mapping names would add a translation layer whose only
 * job is to be forgotten in one place.
 *
 * @module db/schema
 */

import type { ColumnType, Generated, GeneratedAlways } from 'kysely';

/**
 * A JSON value, as `jsonb` round-trips it.
 *
 * Deliberately not `any` and not `object`: a `jsonb` column can hold a scalar, an array or an object, and a
 * consumer has to narrow it before use — which is the point of storing free-form JSON behind a typed column.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A `timestamptz` the server fills in (`DEFAULT now()`).
 *
 * Reads as `Date`; writes accept a `Date` or an ISO string, because `pg` serializes both and a caller building an
 * explicit timestamp should not have to construct a `Date` to say what it means. Omitting it on insert lets the
 * default run — which is the normal case.
 */
export type CreatedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/** A `timestamptz` that may be absent — `last_login_at`, `revoked_at`. */
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

/** A `timestamptz` the caller must supply — `expires_at`. */
export type RequiredTimestamp = ColumnType<Date, Date | string, Date | string>;

/**
 * `admins` (`03-data-model.md` §2.1).
 *
 * One row in practice (D-4), seeded from `ADMIN_USERNAME`/`ADMIN_PASSWORD` by the launch script. Username
 * uniqueness is case-insensitive and enforced by a unique index on `lower(username)`, so a lookup must be written
 * case-insensitively too — `where(sql`lower(username)`, '=', …)` — or it will miss the row the index protects.
 */
export interface Admins {
  /**
   * `uuid PRIMARY KEY DEFAULT gen_random_uuid()`. `GeneratedAlways`, not `Generated`: an insert type of `never` means
   * a caller *cannot* supply an id, which is the only way to keep a sequence and its row in step.
   */
  id: GeneratedAlways<string>;
  username: string;
  /** argon2id, produced by `P1-AUTH-01`. Never logged, never selected into a response. */
  password_hash: string;
  /** `DEFAULT true`: a new admin is usable unless the seed script says otherwise. */
  is_active: Generated<boolean>;
  last_login_at: NullableTimestamp;
  created_at: CreatedTimestamp;
  /** Bumped by the service on every change; the database has no trigger, by design (D-11). */
  updated_at: CreatedTimestamp;
}

/**
 * `admin_tokens` (`03-data-model.md` §2.2, D-3).
 *
 * Opaque Bearer tokens: the row keeps `sha256(token)`, never the token. Revocation is a timestamp, not a delete,
 * so an audit can still say when a session ended.
 */
export interface AdminTokens {
  /** Generated; not suppliable on insert (see {@link Admins.id}). */
  id: GeneratedAlways<string>;
  /** `ON DELETE CASCADE`: deleting the admin ends their sessions. */
  admin_id: string;
  /** `sha256(token)`, 32 bytes. The column has a `CHECK` on the length, so a truncated hash fails loudly. */
  token_hash: Buffer;
  /** First 8 characters, for the "active sessions" list. Not a credential on its own. */
  token_prefix: string;
  expires_at: RequiredTimestamp;
  revoked_at: NullableTimestamp;
  last_used_at: NullableTimestamp;
  user_agent: string | null;
  /** `inet`: the driver returns the text form (`10.0.0.1`, `2001:db8::1`), not a structured value. */
  ip: string | null;
  created_at: CreatedTimestamp;
}

/**
 * `settings` (`03-data-model.md` §2.11).
 *
 * A key/value store rather than a wide row: adding a setting must not need a migration. `key` is the primary key
 * and has no default, so it is required on insert while the other two are not.
 */
export interface Settings {
  /** Dotted key, e.g. `cache.keepVersions`. */
  key: string;
  /** `jsonb NOT NULL`. Read back as the parsed value; a consumer narrows it. */
  value: JsonValue;
  updated_at: CreatedTimestamp;
}

/**
 * `audit_logs` (`03-data-model.md` §2.11).
 *
 * Append-only: nothing updates or deletes a row. `actor_name` is a snapshot so the log still reads correctly after
 * the account is gone, and `actor_id` is `ON DELETE SET NULL` — the two behave differently on purpose, and a test
 * proves both.
 */
export interface AuditLogs {
  /**
   * `bigserial PRIMARY KEY`. **A `string` at runtime** — `pg` returns int8 as text so ids past 2^53 survive.
   * Compare with `BigInt(row.id)` when ordering numerically; never `row.id + 1`.
   *
   * `GeneratedAlways` matters more here than anywhere else: an insert that supplied an id would advance the row's
   * value but not the sequence, and the next generated id would collide — a failure that appears later, elsewhere.
   */
  id: GeneratedAlways<string>;
  /** `ON DELETE SET NULL`: the account may vanish, the log may not. */
  actor_id: string | null;
  /** Snapshot of the username at the time of the action. */
  actor_name: string;
  /** Dotted action name: `auth.login`, `cache.publish`, `version.delete`. */
  action: string;
  target_type: string | null;
  target_id: string | null;
  /** `jsonb NOT NULL DEFAULT '{}'`: free-form context, never credentials. */
  metadata: ColumnType<JsonValue, JsonValue | undefined, JsonValue>;
  ip: string | null;
  created_at: CreatedTimestamp;
}

/** A row of `admins`, as selected. */
export type Admin = SelectRow<Admins>;
/** A row of `admin_tokens`, as selected. */
export type AdminToken = SelectRow<AdminTokens>;
/** A row of `settings`, as selected. */
export type Setting = SelectRow<Settings>;
/** A row of `audit_logs`, as selected. */
export type AuditLog = SelectRow<AuditLogs>;

/**
 * The shape Kysely hands back for a table interface.
 *
 * Written out instead of importing `Selectable` so this module depends on nothing but the column helpers — a
 * circular import between `schema.ts` and `client.ts` would be the first thing a new repository hits.
 */
export type SelectRow<T> = {
  [K in keyof T]: T[K] extends ColumnType<infer S, unknown, unknown> ? S : T[K];
};

/**
 * Every table Kysely knows about.
 *
 * Phase 2 (`P2-DB-01`) adds `countries`, `country_cache`, `map_versions`, `jobs`, the interval tables, upload
 * sessions, metrics and download events. Until a table is listed here, a query against it does not compile — which
 * is the property that makes this file worth having.
 */
export interface Database {
  admins: Admins;
  admin_tokens: AdminTokens;
  settings: Settings;
  audit_logs: AuditLogs;
}
