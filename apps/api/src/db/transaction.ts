/**
 * One database transaction, with the bounds a long-running service needs (task `P1-DB-03`).
 *
 * Kysely already gives a transaction (`db.transaction().execute(fn)`); this module exists because a raw one has
 * three failure modes that only appear in production:
 *
 * 1. **A session can idle inside a transaction forever.** The classic "idle in transaction" outage: a code path
 *    throws after `BEGIN` but before the rollback, the connection stays checked out holding row locks, the pool
 *    loses one of its slots, and the next request waits. Every transaction here sets
 *    `idle_in_transaction_session_timeout`, so the *server* reclaims it. A transaction that is idle for 30 s is not
 *    slow, it is abandoned — and doing HTTP inside a transaction is a bug this makes loud rather than slow.
 * 2. **A statement can run without end.** `statement_timeout` is available per transaction for the work that must
 *    not hold a connection indefinitely; it is off by default, because an analytics query in the metrics sampler is
 *    legitimately slow and silently killing it would be worse than the risk.
 * 3. **Concurrency produces transient failures.** `40001` (serialization failure) and `40P01` (deadlock detected)
 *    mean the database aborted *our* transaction, not that our code is wrong — the documented response is to run
 *    the transaction again. Retrying is safe here for one reason and one only: the transaction rolled back
 *    completely, so the work is the only thing that has to be repeatable. Anything outside the database — unlinking
 *    a file, sending a notification — belongs **after** `withTransaction` returns (`15-decisions.md` ADR-009).
 *
 * Measured, not assumed: `SET LOCAL statement_timeout` cancels a query with `57014`; a read-only transaction
 * refuses a write with `25006`; `idle_in_transaction_session_timeout` terminates the session from the server side;
 * and two concurrent `serializable` transactions really do produce one `40001`.
 *
 * @module db/transaction
 */

import { sql, Transaction, type Kysely } from 'kysely';

/**
 * How long a transaction may sit idle before the server terminates the session.
 *
 * Thirty seconds: long enough that no honest transaction hits it, short enough that a leaked one cannot hold locks
 * across a lunch break. The server enforces it, so a client that leaks the connection — a crash in the middle of
 * `work`, a promise nobody awaited — cannot leak the locks too.
 */
export const TRANSACTION_IDLE_TIMEOUT_MS = 30_000;

/** Wait before the first retry; doubled for each subsequent attempt. */
export const RETRY_BACKOFF_MS = 20;

/** SQLSTATEs that mean "the database aborted this transaction; running it again is the documented response". */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/** Isolation levels PostgreSQL understands, spelled as `START TRANSACTION` wants them. */
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** What a caller may adjust. Every field has a documented default; nothing has to be passed. */
export interface TransactionOptions {
  /**
   * Isolation level. Default: the server's (`read committed`).
   *
   * `serializable` is the correct choice when a read and a write in the same transaction must see a consistent
   * snapshot — the scheduler's claim, and any "recompute a count from the rows" path. It costs a retry under
   * contention, which is what {@link TransactionOptions.retries} is for.
   */
  readonly isolation?: IsolationLevel;
  /**
   * Refuse every write in this transaction, enforced by the server (`25006`), not by convention.
   *
   * Use it for read paths that should never write: a reporting query that mutates is a bug, and this turns it into
   * an error at the statement instead of a surprise in production.
   */
  readonly readOnly?: boolean;
  /** `statement_timeout` for this transaction. Off by default — see the module comment. */
  readonly statementTimeoutMs?: number;
  /** Override {@link TRANSACTION_IDLE_TIMEOUT_MS}; mainly so tests do not wait 30 s. */
  readonly idleTimeoutMs?: number;
  /**
   * Additional attempts after a transient failure. Default `1`, i.e. at most two runs.
   *
   * `0` disables retrying for work that genuinely must not run twice even inside a rolled-back transaction (it
   * exists for callers that are certain; the default is the documented behaviour for `40001`).
   */
  readonly retries?: number;
  /** Base backoff, doubled per attempt. Default {@link RETRY_BACKOFF_MS}. */
  readonly backoffMs?: number;
}

/**
 * Reads the SQLSTATE out of whatever the driver threw.
 *
 * `pg` attaches `code` to its `DatabaseError`; a wrapper may keep the original under `cause`, so both are checked.
 *
 * @param error - Value caught from a failed query.
 * @returns The SQLSTATE, or `undefined` when there is none.
 */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  // Bounded, because a malicious or accidental self-referencing chain would otherwise loop forever.
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Reports whether a failure is the kind the database expects to be retried.
 *
 * @param error - Value caught from a failed transaction.
 * @returns `true` for a serialization failure or a deadlock.
 */
export function isTransient(error: unknown): boolean {
  const code = sqlStateOf(error);
  return code !== undefined && TRANSIENT_SQLSTATES.has(code);
}

/**
 * Rejects anything that is not a positive whole number of milliseconds.
 *
 * These values are interpolated into `SET LOCAL`, which does not accept bind parameters — so the check is not
 * decoration, it is the thing that keeps the SQL a number.
 *
 * @param value - Candidate duration.
 * @param name - Option name, for the message.
 * @returns The value, narrowed to an integer.
 * @throws {RangeError} When the value is not a positive whole number.
 */
function wholeMilliseconds(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive whole number of milliseconds, got ${value}`);
  }
  return value;
}

/** Waits for a backoff. Extracted so the retry loop reads as three lines. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `work` in one transaction, with the bounds described in the module comment.
 *
 * The callback receives the transaction, not the pool: every query inside it must go through `trx` or it runs on a
 * *different* connection and is not part of the transaction at all. Repositories take a `Kysely`/`Transaction`
 * parameter for exactly this reason (`15-decisions.md` D-11).
 *
 * **This cannot nest, and says so.** Kysely 0.29 removed nesting: `transaction()` and `startTransaction()` on a
 * `Transaction` both throw ("calling the transaction method for a Transaction is not supported"), and savepoints
 * exist only on the `ControlledTransaction` you get from `startTransaction()`. So the parameter is a root
 * `Kysely`, a `Transaction` is refused with a message that explains the alternative, and a service that has to
 * participate in a caller's transaction takes the `Kysely`/`Transaction` it is given instead of opening its own
 * (`15-decisions.md` D-11: repositories accept an instance or a `tx`).
 *
 * @param db - Kysely instance, or an enclosing transaction for a nested (savepoint) call.
 * @param work - Database work. **May run more than once** when a transient failure is retried; keep side effects
 * outside it.
 * @param options - Isolation, read-only, timeouts and retry budget; all optional.
 * @returns Whatever `work` returned, once its transaction has committed.
 * @throws The first non-transient error, or the last transient one after the retry budget is spent. The
 * transaction has always been rolled back by then.
 */
export async function withTransaction<DB, T>(
  db: Kysely<DB>,
  work: (trx: Transaction<DB>) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  // Checked before anything is opened: without this the failure is Kysely's "calling the transaction method for a
  // Transaction is not supported", thrown from inside the driver's plumbing, which does not tell a caller what to
  // do instead.
  if (db instanceof Transaction) {
    throw new Error(
      'withTransaction cannot open a transaction inside a transaction: Kysely 0.29 does not nest. Pass the ' +
        'enclosing transaction to the callee and let it use the instance it was given.',
    );
  }

  const retries = options.retries ?? 1;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError(`retries must be a whole number >= 0, got ${retries}`);
  }
  const idleTimeoutMs = wholeMilliseconds(
    options.idleTimeoutMs ?? TRANSACTION_IDLE_TIMEOUT_MS,
    'idleTimeoutMs',
  );
  const statementTimeoutMs =
    options.statementTimeoutMs === undefined
      ? undefined
      : wholeMilliseconds(options.statementTimeoutMs, 'statementTimeoutMs');
  const backoffMs = wholeMilliseconds(options.backoffMs ?? RETRY_BACKOFF_MS, 'backoffMs');

  const runOnce = async (): Promise<T> => {
    let builder = db.transaction();
    if (options.isolation !== undefined) builder = builder.setIsolationLevel(options.isolation);
    if (options.readOnly === true) builder = builder.setAccessMode('read only');

    return builder.execute(async (trx) => {
      // `SET LOCAL` is scoped to this transaction and reverts on commit or rollback, so nothing leaks back into
      // the pooled connection — a plain `SET` here would change the connection for whoever gets it next.
      await sql
        .raw(`set local idle_in_transaction_session_timeout = ${idleTimeoutMs}`)
        .execute(trx);
      if (statementTimeoutMs !== undefined) {
        await sql.raw(`set local statement_timeout = ${statementTimeoutMs}`).execute(trx);
      }
      return work(trx);
    });
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runOnce();
    } catch (error) {
      if (attempt >= retries || !isTransient(error)) throw error;
      // Exponential, bounded by the retry count: 20 ms, 40 ms, 80 ms…
      await pause(backoffMs * 2 ** attempt);
    }
  }
}
