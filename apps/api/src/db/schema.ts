/**
 * Kysely types for the phase-1/2 foundation, interval schedules, download events, and import staging (`P1-DB-02`,
 * `P2-DB-01`, `P2-API-09`, `P4-IMP-01`, `P4-INT-01`).
 *
 * The columns here mirror `03-data-model.md` §§2.1–2.8, §2.10 and §2.11, and migrations `0001_init.sql`,
 * `0002_catalog.sql`, `0003_download_events.sql`, `0004_upload_sessions.sql` and `0005_intervals.sql`. Repositories import these types —
 * never `any`, never `unknown` for a row — so queries against
 * nonexistent columns fail to compile instead of at 3 a.m. (`10-laws.md` L5).
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

/** A PostgreSQL `bigint`: `pg` returns int8 values as decimal strings to avoid precision loss. */
export type Int8Column = ColumnType<string, string | number | bigint, string | number | bigint>;
/** A nullable PostgreSQL `bigint`, with nullable/omittable insert values. */
export type NullableInt8Column = ColumnType<
  string | null,
  string | number | bigint | null | undefined,
  string | number | bigint | null
>;
/** A PostgreSQL `bigint` with a database default. */
export type GeneratedInt8Column = ColumnType<
  string,
  string | number | bigint | undefined,
  string | number | bigint
>;

/** Local region catalog row (`03-data-model.md` §2.3). */
export interface Countries {
  id: GeneratedAlways<string>;
  source: Generated<string>;
  source_id: string;
  parent_id: string | null;
  slug: string;
  name: string;
  iso_alpha2: Generated<string[]>;
  iso_other: Generated<string[]>;
  source_pbf_url: string | null;
  source_size_hint_bytes: NullableInt8Column;
  catalog_synced_at: CreatedTimestamp;
  created_at: CreatedTimestamp;
  updated_at: CreatedTimestamp;
}

/** Cached publication and update state, created with a country's first version (`03-data-model.md` §2.4). */
export interface CountryCache {
  country_id: string;
  is_public: Generated<boolean>;
  public_since: NullableTimestamp;
  update_state: Generated<'unknown' | 'up_to_date' | 'update_available'>;
  available_version: string | null;
  available_size_bytes: NullableInt8Column;
  available_at: NullableTimestamp;
  update_checked_at: NullableTimestamp;
  versions_ready_count: Generated<number>;
  total_size_bytes: GeneratedInt8Column;
  created_at: CreatedTimestamp;
  updated_at: CreatedTimestamp;
}

/** Immutable downloaded or uploaded map version (`03-data-model.md` §2.5). */
export interface MapVersions {
  id: GeneratedAlways<string>;
  country_id: string;
  version: string;
  origin: 'geofabrik_snapshot' | 'geofabrik_latest' | 'upload';
  source_url: string | null;
  source_filename: string;
  data_timestamp: NullableTimestamp;
  file_size_bytes: Int8Column;
  checksum_md5: string | null;
  checksum_sha256: string | null;
  storage_path: string;
  status: Generated<'pending' | 'ready' | 'failed'>;
  failure_reason: string | null;
  job_id: string | null;
  uploaded_by: string | null;
  created_at: CreatedTimestamp;
  ready_at: NullableTimestamp;
}

/** Staged administrator upload metadata (`03-data-model.md` §2.8). */
export interface UploadSessions {
  id: GeneratedAlways<string>;
  country_id: string;
  version: string;
  original_name: string;
  /** Strictly validated root-relative UUID filename under `TMP_DIR`, never the client-supplied path. */
  temp_path: string;
  size_bytes: GeneratedInt8Column;
  checksum_md5: string | null;
  status: Generated<'received' | 'installing' | 'installed' | 'failed' | 'expired'>;
  job_id: string | null;
  created_by: string | null;
  created_at: CreatedTimestamp;
  expires_at: CreatedTimestamp;
}

/** Values of PostgreSQL's `interval_frequency` enum. */
export type IntervalFrequency = 'daily' | 'weekly' | 'monthly';
/** Values of an interval run's `triggered_by` column. */
export type IntervalRunTrigger = 'schedule' | 'manual';
/** Values of an interval run's `status` column. */
export type IntervalRunStatus = 'running' | 'succeeded' | 'partial' | 'failed';
/** Values of an interval run item's `status` column. */
export type IntervalRunItemStatus = 'queued' | 'skipped' | 'downloaded' | 'failed';

/** An interval schedule (`03-data-model.md` §2.7). */
export interface Intervals {
  id: GeneratedAlways<string>;
  name: string;
  frequency: IntervalFrequency;
  time_of_day: Generated<string>;
  weekday: number | null;
  day_of_month: number | null;
  keep_versions: Generated<number>;
  only_if_changed: Generated<boolean>;
  enabled: Generated<boolean>;
  next_run_at: RequiredTimestamp;
  last_run_at: NullableTimestamp;
  last_status: string | null;
  created_by: string | null;
  created_at: CreatedTimestamp;
  updated_at: CreatedTimestamp;
}

/** Country membership for an interval schedule (`03-data-model.md` §2.7). */
export interface IntervalCountries {
  interval_id: string;
  country_id: string;
}

/** One durable interval execution (`03-data-model.md` §2.7). */
export interface IntervalRuns {
  id: GeneratedAlways<string>;
  interval_id: string;
  triggered_by: IntervalRunTrigger;
  status: Generated<IntervalRunStatus>;
  countries_total: Generated<number>;
  countries_ok: Generated<number>;
  countries_failed: Generated<number>;
  countries_skipped: Generated<number>;
  bytes_downloaded: GeneratedInt8Column;
  started_at: CreatedTimestamp;
  finished_at: NullableTimestamp;
  error_message: string | null;
}

/** Country-level snapshot in an interval execution (`03-data-model.md` §2.7). */
export interface IntervalRunItems {
  id: GeneratedAlways<string>;
  run_id: string;
  country_id: string | null;
  country_slug: string;
  country_name: string;
  job_id: string | null;
  status: Generated<IntervalRunItemStatus>;
  version: string | null;
  bytes: GeneratedInt8Column;
  error_code: string | null;
  error_message: string | null;
}

/** Values of PostgreSQL's `job_type` enum. */
export type JobType = 'download' | 'import' | 'update_check' | 'catalog_sync' | 'prune';
/** Values of PostgreSQL's `job_status` enum. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** Durable background work item (`03-data-model.md` §2.6). */
export interface Jobs {
  id: GeneratedAlways<string>;
  type: JobType;
  status: Generated<JobStatus>;
  priority: Generated<number>;
  payload: JsonValue;
  result: JsonValue | null;
  error_code: string | null;
  error_message: string | null;
  phase: string | null;
  progress_bytes: GeneratedInt8Column;
  total_bytes: NullableInt8Column;
  speed_bps: NullableInt8Column;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_after: CreatedTimestamp;
  cancel_requested: Generated<boolean>;
  locked_by: string | null;
  locked_at: NullableTimestamp;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  created_by: string | null;
  created_at: CreatedTimestamp;
}

/** `settings` (`03-data-model.md` §2.11).
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
/** Completed or interrupted file transfer (`03-data-model.md` §2.10, `P2-API-09`). */
export interface DownloadEvents {
  /** `bigserial PRIMARY KEY`; PostgreSQL int8 values arrive as decimal strings. */
  id: GeneratedAlways<string>;
  country_id: string;
  version_id: string | null;
  channel: 'public' | 'admin';
  bytes_sent: GeneratedInt8Column;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: CreatedTimestamp;
}

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
/** A row of `countries`, as selected. */
export type Country = SelectRow<Countries>;
/** A row of `country_cache`, as selected. */
export type CountryCacheRow = SelectRow<CountryCache>;
/** A row of `map_versions`, as selected. */
export type MapVersion = SelectRow<MapVersions>;
/** A row of `upload_sessions`, as selected. */
export type UploadSession = SelectRow<UploadSessions>;
/** A row of `intervals`, as selected. */
export type Interval = SelectRow<Intervals>;
/** A row of `interval_runs`, as selected. */
export type IntervalRun = SelectRow<IntervalRuns>;
/** A row of `interval_run_items`, as selected. */
export type IntervalRunItem = SelectRow<IntervalRunItems>;
/** A row of `jobs`, as selected. */
export type Job = SelectRow<Jobs>;
/** A row of `settings`, as selected. */
export type Setting = SelectRow<Settings>;
/** A row of `audit_logs`, as selected. */
export type AuditLog = SelectRow<AuditLogs>;
/** A row of `download_events`, as selected. */
export type DownloadEvent = SelectRow<DownloadEvents>;

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
 * `P2-DB-01` adds catalog, cache, version and job tables; `P2-API-09` adds download events; `P4-IMP-01` adds upload
 * sessions; `P4-INT-01` adds interval schedules and run history. Metrics tables remain a future task. Until a table is listed here, a query against it does not
 * compile — which is the property that makes this file worth having.
 */
export interface Database {
  admins: Admins;
  admin_tokens: AdminTokens;
  countries: Countries;
  country_cache: CountryCache;
  map_versions: MapVersions;
  upload_sessions: UploadSessions;
  intervals: Intervals;
  interval_countries: IntervalCountries;
  interval_runs: IntervalRuns;
  interval_run_items: IntervalRunItems;
  jobs: Jobs;
  settings: Settings;
  audit_logs: AuditLogs;
  download_events: DownloadEvents;
}
