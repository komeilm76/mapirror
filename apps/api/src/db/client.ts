/**
 * The database handle (task `P1-API-06`).
 *
 * One Kysely instance over one `pg` pool, created from the validated configuration and owned by the process for
 * its whole life. Repositories take the instance (or a transaction) as a parameter — they never import this
 * module — so a query can always be traced to the thing that opened it, and a service can compose two writes in
 * one transaction without reaching for a global.
 *
 * **Typed, not `any`.** The table map lives in `db/schema.ts` (`P1-DB-02`) and is re-exported from here, so a
 * query against a table or column that does not exist fails to compile — the guarantee law `L5` asks for. The
 * catalog, cache, version and job tables join this map with `P2-DB-01`; later tables join with their own migrations.
 *
 * @module db/client
 */

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import type { AppConfig } from '../config/env';
import type { Database } from './schema';
import { AppError } from '../lib/errors';

// The table map lives in `db/schema.ts` (§`P1-DB-02`) and is re-exported here, so every caller that already
// imports from this module keeps working and there is exactly one definition of the schema.
export type { Database } from './schema';

/**
 * Receives an error that happened on a connection, idle or in use.
 *
 * @param error - The driver's error for the lost connection.
 */
export type ConnectionErrorListener = (error: Error) => void;

/**
 * A live database handle: the query builder, a liveness check, and the way to close what it opened.
 *
 * `check` belongs to the handle rather than to a free function so that the *contract* — "can this database answer
 * a trivial query right now?" — is what the boot path depends on. The pool implements it with `select 1`; a test
 * double answers however the test needs. A free function would have to know how to query every implementation.
 */
export interface SqlDatabase {
  /** Kysely instance; pass it, or a transaction from it, into repositories. */
  readonly db: Kysely<Database>;
  /** Closes the pool. Idempotent, because a shutdown path may race a failed boot. */
  readonly close: () => Promise<void>;
  /** Resolves when the database answers, rejects when it does not. */
  readonly check: (timeoutMs?: number) => Promise<void>;
}

/**
 * How long a single connectivity probe may take.
 *
 * Short on purpose: this runs before the server accepts traffic, so a slow probe is a slow boot. A database that
 * cannot answer `select 1` in five seconds is not going to serve a request in one.
 */
export const PING_TIMEOUT_MS = 5_000;

/**
 * The connection string the pool is given.
 *
 * `DATABASE_URL` may leave the password out, and `POSTGRES_PASSWORD` / `POSTGRES_PASSWORD_FILE` supplies it. That is how
 * `compose.yaml` passes it (task `P1-DOCK-05`), and the reason is not tidiness: an operator's password is arbitrary text,
 * and arbitrary text in a URL does not survive. Measured, pass 43, on a PostgreSQL requiring SCRAM: a `@` written
 * straight into a DSN makes `pg` connect to a **host called `ss`** (`getaddrinfo ENOTFOUND ss`), a `#`, `?` or `/` makes
 * the string an invalid URL that the config schema refuses with a message about `DATABASE_URL` — a variable the operator
 * never edited — and a `%` that is not already an escape makes the driver's `decodeURIComponent` throw `URI malformed`.
 * Completion, percent-encoded, makes every one of them work and keeps the password in exactly one place.
 *
 * Two details worth keeping:
 *
 * - **`%` is escaped by hand.** `URL`'s own password setter encodes `@`, `/`, `#`, `?`, spaces and non-ASCII, but leaves a
 *   bare `%` alone (it is not in the userinfo percent-encode set) — so a password containing `%41` would otherwise
 *   authenticate as `A`. Measured both ways.
 * - **A DSN that carries its own password wins** and is returned unchanged. That is the native-development path, where
 *   the DSN is explicit and `POSTGRES_PASSWORD` exists only for the bundled container; a value that is not needed must not
 *   silently replace one that is.
 *
 * @param config - Validated configuration.
 * @returns A connection string the driver can parse, with the password in it when one was configured.
 */
export function databaseUrlFor(config: AppConfig): string {
  const password = config.postgresPassword;
  if (password === undefined) return config.databaseUrl;

  const url = new URL(config.databaseUrl);
  if (url.password !== '') return config.databaseUrl;
  url.password = password.replace(/%/gu, '%25');
  return url.toString();
}

/**
 * Creates the pool and the Kysely instance from configuration.
 *
 * The pool connects lazily: `new pg.Pool()` does no I/O, so this function cannot fail. That is deliberate — the
 * one place that decides whether the database is usable is {@link checkDatabase}, which the `db` stage runs
 * during boot, so a failure has exactly one shape and one message.
 *
 * @param config - Validated configuration (DSN and pool size).
 * @param onConnectionLost - Called when a connection is lost, whether it was idle or serving a query. The stage
 * passes the app logger, so a database that keeps dropping connections is visible in the log; omitting it keeps
 * the pool silent, which is what a short-lived test handle wants.
 * @returns The handle every repository receives.
 */
export function createDatabase(
  config: AppConfig,
  onConnectionLost?: ConnectionErrorListener,
): SqlDatabase {
  const pool = new pg.Pool({
    connectionString: databaseUrlFor(config),
    max: config.dbPoolMax,
    // A connection attempt that hangs is worse than one that fails: the default has no timeout, so a black-holed
    // route to the database would stall the boot until the shutdown timer fired, with a message about shutdown.
    connectionTimeoutMillis: PING_TIMEOUT_MS,
    // Let an idle client go rather than hold a slot on the server forever; the pool reconnects on demand.
    idleTimeoutMillis: 30_000,
  });

  // Two listeners, because `pg` reports a lost connection through two different channels and only one of them was
  // ever handled.
  //
  // 1. **Every client**, attached when it is created. `pg-pool` only keeps an `error` listener on a client while it
  //    sits idle in the pool: on checkout it removes its own. So a connection killed *during a query or a
  //    transaction* — a failover, `pg_terminate_backend`, an idle-in-transaction timeout — emitted `error` on an
  //    emitter with no listener, and Node's response to that is to throw. Measured: the transaction rejected
  //    normally *and* the process took an uncaught exception. This listener is what makes a mid-transaction drop
  //    survivable, and it is also the single place that reports one.
  pool.on('connect', (client: pg.PoolClient) => {
    client.on('error', (error: Error) => {
      onConnectionLost?.(error);
    });
  });
  //
  // 2. **The pool itself**, which `pg-pool` emits to when an idle client dies (and which would otherwise throw for
  //    want of a listener). Swallowed on purpose: the client listener above has already reported the same error,
  //    and logging it twice per dropped connection turns one database restart into two noise lines each.
  pool.on('error', () => undefined);

  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  let closing: Promise<void> | undefined;
  const handle: SqlDatabase = {
    db,
    close: () => {
      // Memoised: `Kysely.destroy()` twice ends the pool twice, and an `onClose` hook may run after a failed boot
      // has already closed it.
      closing ??= db.destroy();
      return closing;
    },
    check: (timeoutMs = PING_TIMEOUT_MS) => checkDatabase(handle, timeoutMs),
  };
  return handle;
}

/**
 * Asks the database whether it is there.
 *
 * @param database - Handle to probe. Callers normally use {@link SqlDatabase.check}, which binds the default
 * timeout; this function is exported for the case where a caller holds a pool it did not create.
 * @param timeoutMs - Upper bound for the whole round trip.
 * @throws {AppError} `DB_UNAVAILABLE` (503) when the query fails or takes too long. The message names no DSN:
 * the driver's own text is logged by the caller, and a connection string contains a password (L9).
 */
export async function checkDatabase(
  database: SqlDatabase,
  timeoutMs = PING_TIMEOUT_MS,
): Promise<void> {
  // Armed before the race, cleared in `finally`: the clear is unconditional because there is no state in which the
  // timer is missing (an earlier version guarded it, and the guard was a branch nothing could take or test).
  // `expire` is assigned by the executor, which `Promise` runs synchronously, so no no-op placeholder is needed.
  let expire!: (error: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    expire = reject;
  });
  const timer = setTimeout(
    () => expire(new Error(`database did not answer within ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    await Promise.race([sql`select 1`.execute(database.db), timeout]);
  } catch (error) {
    // The original error is attached, not printed: `cause` is what the boot log shows.
    throw new AppError('DB_UNAVAILABLE', 'The database is not reachable.', undefined, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}
