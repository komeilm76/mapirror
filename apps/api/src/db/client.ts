/**
 * The database handle (task `P1-API-06`).
 *
 * One Kysely instance over one `pg` pool, created from the validated configuration and owned by the process for
 * its whole life. Repositories take the instance (or a transaction) as a parameter — they never import this
 * module — so a query can always be traced to the thing that opened it, and a service can compose two writes in
 * one transaction without reaching for a global.
 *
 * **Typed but not yet modelled.** `Database` is empty until `P1-DB-02` writes the table types. It is declared
 * here anyway, because the alternative — `Kysely<any>` — is the one type that would let a query compile against
 * a table that does not exist, and law `L5` bans exactly that.
 *
 * @module db/client
 */

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import type { AppConfig } from '../config/env';
import { AppError } from '../lib/errors';

/**
 * The tables Kysely knows about.
 *
 * Deliberately empty for now: `P1-DB-02` fills it from `03-data-model.md`. An empty interface is not `any` — a
 * query against an unknown table still fails to compile, which is the property that keeps `P1-DB-02` honest.
 */
// `{}` is the honest type until `P1-DB-02` fills the table map: it still rejects unknown tables, which `unknown`
// would not. The empty-object rule is about accidentally accepting `0` or `""` where a shape was meant — here the
// emptiness is the starting point, not an oversight.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Database {}

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
 * @returns The handle every repository receives.
 */
export function createDatabase(config: AppConfig): SqlDatabase {
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
  // unhandled `error` event is to throw, which would take the process down for a database restart. The pool
  // discards the broken client and the next query reconnects.
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
