/**
 * Startup housekeeping: delete token rows that expired long ago (task `P1-AUTH-02`, `03-data-model.md` §2.2).
 *
 * It lives in `lib/` rather than in `server.ts` for one reason: **it has to be testable without starting a process.**
 * The first version of this ran inline in `start()`, before the socket opened, with no bound — and a single row lock
 * held on an expired token by some other transaction made the `DELETE` wait, so the process sat in boot and never
 * called `listen`. Measured: `healthz` never answered, the log stopped after the schema check, and the container looked
 * alive to Docker while answering nothing. Two changes came out of that probe, and both are the point of this module:
 *
 * 1. **It is bounded.** `statement_timeout` (via `withTransaction`) cancels the statement after
 *    {@link HOUSEKEEPING_TIMEOUT_MS}, so a contended table costs at most a few seconds and a warning line.
 * 2. **It is never on the boot path.** `server.ts` calls it *after* `listen`, fire-and-forget. Housekeeping is
 *    optional work: nothing a client asks for depends on it, so nothing a client asks for may wait for it.
 *
 * A failure here is always `warn` and never fatal. The alternative — refusing to serve because an old row could not be
 * deleted — turns a maintenance problem into an outage.
 *
 * @module lib/housekeeping
 */

import type { Kysely } from 'kysely';

import { pruneExpiredTokens } from '../modules/auth/tokens';
import type { Database } from '../db/schema';
import { withTransaction } from '../db/transaction';

/**
 * How long the pruning statement may run.
 *
 * Five seconds is generous for an indexed delete on a table this size, and short enough that it cannot be confused
 * with a hung process. The point is not to finish slowly, it is to **give up**: the row will be there on the next
 * boot, and a stopped boot is an outage while a skipped prune is nothing.
 */
export const HOUSEKEEPING_TIMEOUT_MS = 5_000;

/** The two log levels this module uses; `app.log` satisfies it, and so does a stub in a test. */
export interface HousekeepingLog {
  readonly info: (context: object, message: string) => void;
  readonly warn: (context: object, message: string) => void;
}

/**
 * Prunes expired tokens, bounded and non-fatal.
 *
 * @param database - Kysely instance (the pool's, not a transaction: it opens its own, so the timeout applies).
 * @param log - Logger for the outcome; `info` only when something was deleted, `warn` on any failure.
 * @param options - `timeoutMs` and `now` exist for tests; the defaults suit the real boot.
 * @returns How many rows were deleted, or `null` when the attempt was abandoned — the two are different, and a caller
 * that only saw `0` could not tell "nothing to do" from "we gave up".
 */
export async function runHousekeeping(
  database: Kysely<Database>,
  log: HousekeepingLog,
  options: { readonly timeoutMs?: number; readonly now?: Date } = {},
): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? HOUSEKEEPING_TIMEOUT_MS;

  try {
    const pruned = await withTransaction(
      database,
      (trx) => pruneExpiredTokens(trx, options.now === undefined ? {} : { now: options.now }),
      { statementTimeoutMs: timeoutMs },
    );

    // Silent when there was nothing to do: a log line every boot saying "0 rows" trains people to ignore the line.
    if (pruned > 0) log.info({ pruned }, 'expired tokens pruned');
    return pruned;
  } catch (error) {
    // Includes the timeout (`57014`), a lock that never came free, and a database that went away mid-statement. All
    // three mean the same thing for the caller: nothing was deleted, and serving continues.
    log.warn({ err: error, timeoutMs }, 'could not prune expired tokens; continuing');
    return null;
  }
}
