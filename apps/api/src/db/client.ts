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
 * phase-2 tables join the same map (`P2-DB-01`); until then a query against one is a type error, which is the
 * correct behaviour for a table the schema does not have yet.
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

/** Receives an error that happened on a connection the pool was not using. */
export type PoolErrorListener = (error: Error) => void;

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
 * Creates the pool and the Kysely instance from configuration.
 *
 * The pool connects lazily: `new pg.Pool()` does no I/O, so this function cannot fail. That is deliberate — the
 * one place that decides whether the database is usable is {@link checkDatabase}, which the `db` stage runs
 * during boot, so a failure has exactly one shape and one message.
 *
 * @param config - Validated configuration (DSN and pool size).
 * @param onPoolError - Called when a connection is lost while idle. The stage passes the app logger, so a
 * database that keeps dropping connections is visible in the log; omitting it keeps the pool silent, which is
 * what a short-lived test handle wants.
 * @returns The handle every repository receives.
 */
export function createDatabase(config: AppConfig, onPoolError?: PoolErrorListener): SqlDatabase {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    // A connection attempt that hangs is worse than one that fails: the default has no timeout, so a black-holed
    // route to the database would stall the boot until the shutdown timer fired, with a message about shutdown.
    connectionTimeoutMillis: PING_TIMEOUT_MS,
    // Let an idle client go rather than hold a slot on the server forever; the pool reconnects on demand.
    idleTimeoutMillis: 30_000,
  });

  // An error on an **idle** client is not tied to any query, so `pg` emits it on the pool. Node's default for an
  // unhandled `error` event is to throw, which would take the process down for a database restart; the pool
  // discards the broken client and the next query reconnects. Listening is not optional — reporting is: a
  // handler that only discards the error is how a database that drops connections every few minutes stays
  // invisible until it becomes an outage.
  pool.on('error', (error: Error) => {
    onPoolError?.(error);
  });

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
