/**
 * Shared vocabulary: token format, sort fields and the enums the database and the UI both use.
 *
 * These are `as const` tuples rather than TypeScript `enum`s: they erase to plain arrays (no runtime
 * object lookups in the browser bundle), they feed Zod's `z.enum(...)` directly when the schema layer
 * lands, and each one mirrors a `CHECK` constraint or `CREATE TYPE` in `03-data-model.md`. A test in
 * `scripts/tests/docs-contract.spec.ts` parses those SQL definitions and fails if a value is added on one
 * side only — the point of this file is that there is exactly one copy.
 *
 * @module constants
 */

/** Prefix on every admin token (`03-data-model.md` §2, D: AUTH). */
export const TOKEN_PREFIX = 'mm_';

/** Entropy behind the token: 32 bytes → 43 base64url characters. */
export const TOKEN_RANDOM_BYTES = 32;

/** Length of the base64url body after {@link TOKEN_PREFIX}. */
export const TOKEN_BODY_LENGTH = 43;

/** Full length of a token, prefix included. */
export const TOKEN_LENGTH = TOKEN_PREFIX.length + TOKEN_BODY_LENGTH;

/** Sort fields accepted by list endpoints (`04-api.md` §0.2). */
export const SORT_FIELDS = ['name', 'size', 'updated', 'created'] as const;

/** Sort fields the public API exposes — `created` is admin-only information. */
export const PUBLIC_SORT_FIELDS = ['name', 'size', 'updated'] as const;

/** Sort direction. */
export const SORT_ORDERS = ['asc', 'desc'] as const;

/** How often an interval runs (`interval_frequency` in the database). */
export const INTERVAL_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

/** Job kinds (`job_type`). */
export const JOB_TYPES = ['download', 'import', 'update_check', 'catalog_sync', 'prune'] as const;

/** Job lifecycle (`job_status`). */
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;

/** Job phases inside a `running` job; finer than the status, so the UI can show real progress. */
export const JOB_PHASES = ['fetching_index', 'downloading', 'verifying', 'installing'] as const;

/** Where a cached version came from (`map_versions.origin`). */
export const VERSION_ORIGINS = ['geofabrik_snapshot', 'geofabrik_latest', 'upload'] as const;

/** Version lifecycle (`map_versions.status`). Only `ready` rows are ever served. */
export const VERSION_STATUSES = ['pending', 'ready', 'failed'] as const;

/** Result of comparing the cache with upstream (`country_cache.update_state`). */
export const UPDATE_STATES = ['unknown', 'up_to_date', 'update_available'] as const;

/** Disk headroom state (`/system/status` → `storage.state`). */
export const STORAGE_STATES = ['ok', 'low', 'full'] as const;

/** Upload import status, as polled while a file is installed (`upload_sessions.status`). */
export const IMPORT_STATUSES = [
  'received',
  'installing',
  'installed',
  'failed',
  'expired',
] as const;

/** Per-country outcome inside one interval run (`interval_run_items.status`). */
export const RUN_ITEM_STATUSES = ['queued', 'skipped', 'downloaded', 'failed'] as const;

/** Month-day cap for monthly intervals: 28 keeps every month possible (no clamping surprises). */
export const MAX_DAY_OF_MONTH = 28;

/** The `?version=` value that means "the newest cached version". */
export const LATEST_VERSION_ALIAS = 'latest';
