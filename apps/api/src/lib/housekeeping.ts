/**
 * Startup housekeeping for old authentication tokens and expired upload sessions.
 *
 * Work is bounded and never holds the listening socket hostage: `server.ts` calls this after `listen`, fire-and-forget.
 * A failure is a warning, not a reason to take the API offline. Upload cleanup locks a bounded batch, skips active
 * installs, removes only validated UUID-derived paths under `TMP_DIR`, then deletes the rows in the same DB transaction.
 *
 * @module lib/housekeeping
 */

import type { Kysely } from 'kysely';

import type { Database } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { pruneExpiredTokens } from '../modules/auth/tokens';
import type { UploadStorage } from '../modules/storage/upload-storage';

/** How long one housekeeping transaction may run before it is rolled back and abandoned. */
export const HOUSEKEEPING_TIMEOUT_MS = 5_000;
/** Maximum expired upload rows/files handled in one pass, keeping filesystem work bounded. */
export const EXPIRED_UPLOAD_BATCH_SIZE = 100;
/** Housekeeping runs immediately after listen, then this often while the API remains up. */
export const HOUSEKEEPING_INTERVAL_MS = 15 * 60 * 1_000;

/** The two log levels this module uses; `app.log` satisfies it, and so does a stub in a test. */
export interface HousekeepingLog {
  readonly info: (context: object, message: string) => void;
  readonly warn: (context: object, message: string) => void;
}

/**
 * Prunes expired rows and staged files in one bounded transaction.
 *
 * If `uploadStorage` is omitted, only token pruning runs; production supplies it so the configured `TMP_DIR` is used.
 * Expired `installing` sessions are skipped because their job owns the staged file. At most one batch is removed per
 * invocation; a later interval sweep drains any larger backlog.
 *
 * @param database - Kysely pool instance, not an existing transaction.
 * @param log - Logger for the outcome; silent when nothing was deleted and warning-only on failure.
 * @param options - Injectable clock, timeout and upload-storage root for tests.
 * @returns Total number of token rows and upload-session rows deleted, or `null` if the transaction was abandoned.
 */
export async function runHousekeeping(
  database: Kysely<Database>,
  log: HousekeepingLog,
  options: {
    readonly timeoutMs?: number;
    readonly now?: Date;
    readonly uploadStorage?: UploadStorage;
  } = {},
): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? HOUSEKEEPING_TIMEOUT_MS;
  const now = options.now ?? new Date();

  try {
    const result = await withTransaction(
      database,
      async (trx) => {
        const prunedTokens = await pruneExpiredTokens(trx, { now });
        let prunedUploads = 0;

        if (options.uploadStorage !== undefined) {
          const expired = await trx
            .selectFrom('upload_sessions')
            .select(['id', 'temp_path'])
            .where('expires_at', '<=', now)
            .where('status', '!=', 'installing')
            .orderBy('expires_at', 'asc')
            .orderBy('id', 'asc')
            .limit(EXPIRED_UPLOAD_BATCH_SIZE)
            .forUpdate()
            .skipLocked()
            .execute();

          const cleanedIds: string[] = [];
          for (const session of expired) {
            try {
              // Strict `fileAt()` validation prevents a corrupt row from turning cleanup into arbitrary path deletion.
              // A corrupt/unremovable file is retained and reported; it must not starve other expired sessions.
              await options.uploadStorage.fileAt(session.temp_path).remove();
              cleanedIds.push(session.id);
            } catch (error) {
              log.warn(
                { err: error, uploadSessionId: session.id },
                'expired upload file could not be safely removed; session retained',
              );
            }
          }

          if (cleanedIds.length > 0) {
            const deleted = await trx
              .deleteFrom('upload_sessions')
              .where('id', 'in', cleanedIds)
              .where('expires_at', '<=', now)
              .where('status', '!=', 'installing')
              .executeTakeFirst();
            prunedUploads = Number(deleted.numDeletedRows);
          }
        }

        return { prunedTokens, prunedUploads };
      },
      { statementTimeoutMs: timeoutMs },
    );

    if (result.prunedTokens > 0) {
      log.info({ pruned: result.prunedTokens }, 'expired tokens pruned');
    }
    if (result.prunedUploads > 0) {
      log.info({ pruned: result.prunedUploads }, 'expired upload sessions pruned');
    }
    return result.prunedTokens + result.prunedUploads;
  } catch (error) {
    log.warn({ err: error, timeoutMs }, 'could not run housekeeping; continuing');
    return null;
  }
}

/**
 * Starts an immediate housekeeping sweep and repeats it without overlapping transactions.
 *
 * @param database - Kysely pool instance used by each bounded sweep.
 * @param log - Logger for sweep outcomes.
 * @param options - Sweep options plus the repeat interval.
 * @returns A stop handle that clears the timer and waits for any in-flight sweep to finish.
 */
export function startHousekeeping(
  database: Kysely<Database>,
  log: HousekeepingLog,
  options: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly uploadStorage?: UploadStorage;
  } = {},
): { stop: () => Promise<void> } {
  const intervalMs = options.intervalMs ?? HOUSEKEEPING_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`intervalMs must be a positive whole number, got ${intervalMs}`);
  }
  const sweepOptions = {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.uploadStorage === undefined ? {} : { uploadStorage: options.uploadStorage }),
  };
  let stopped = false;
  let active: Promise<number | null> | undefined;

  const run = (): void => {
    if (stopped || active !== undefined) return;
    const pending = runHousekeeping(database, log, sweepOptions);
    active = pending;
    void pending.then(
      () => {
        if (active === pending) active = undefined;
      },
      (error: unknown) => {
        if (active === pending) active = undefined;
        log.warn({ err: error }, 'housekeeping sweep failed unexpectedly');
      },
    );
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
