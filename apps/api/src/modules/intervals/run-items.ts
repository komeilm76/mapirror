/** Durable country-item and aggregate-run completion shared by workers, cancellation, and recovery (`P4-INT-05`).
 *
 * @module modules/intervals/run-items
 */

import { sql } from 'kysely';

import type { RepositoryExecutor } from '../../db/repositories/executor';

/** One terminal outcome written when the linked download job becomes terminal. */
export type IntervalRunItemOutcome =
  | { readonly status: 'downloaded'; readonly bytes: string; readonly version: string | null }
  | {
      readonly status: 'failed';
      readonly errorCode: string;
      readonly errorMessage: string;
    }
  | {
      readonly status: 'skipped';
      readonly version: string | null;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
    };

/**
 * Finalizes a country snapshot once and refreshes its run's aggregate counts in the caller's transaction.
 *
 * Jobs that are not linked to an interval item are intentionally ignored. Callers must update the job row in the same
 * transaction so an item can never become terminal while its job remains retryable (or vice versa).
 *
 * @param executor - The transaction that also changes the linked job's state.
 * @param jobId - Terminal download job id.
 * @param outcome - Safe persisted outcome for the country item.
 */
export async function finalizeIntervalRunItem(
  executor: RepositoryExecutor,
  jobId: string,
  outcome: IntervalRunItemOutcome,
): Promise<void> {
  const changed = await executor
    .updateTable('interval_run_items')
    .set(
      outcome.status === 'downloaded'
        ? {
            status: 'downloaded',
            bytes: outcome.bytes,
            version: outcome.version,
            error_code: null,
            error_message: null,
          }
        : {
            status: outcome.status,
            bytes: 0n,
            version: outcome.status === 'skipped' ? outcome.version : null,
            error_code: outcome.errorCode,
            error_message: outcome.errorMessage,
          },
    )
    .where('job_id', '=', jobId)
    .where('status', '=', 'queued')
    .returning('run_id')
    .executeTakeFirst();

  if (changed === undefined) return;

  const counts = await executor
    .selectFrom('interval_run_items')
    .select([
      sql<number>`count(*) filter (where status = 'queued')::int`.as('queued'),
      sql<number>`count(*) filter (where status = 'downloaded')::int`.as('downloaded'),
      sql<number>`count(*) filter (where status = 'failed')::int`.as('failed'),
      sql<number>`count(*) filter (where status = 'skipped')::int`.as('skipped'),
      sql<string>`coalesce(sum(bytes), 0)::text`.as('bytes'),
    ])
    .where('run_id', '=', changed.run_id)
    .executeTakeFirstOrThrow();

  const complete = counts.queued === 0;
  const status = complete
    ? counts.failed === 0
      ? 'succeeded'
      : counts.downloaded > 0
        ? 'partial'
        : 'failed'
    : 'running';
  await executor
    .updateTable('interval_runs')
    .set({
      status,
      countries_total: counts.queued + counts.downloaded + counts.failed + counts.skipped,
      countries_ok: counts.downloaded,
      countries_failed: counts.failed,
      countries_skipped: counts.skipped,
      bytes_downloaded: counts.bytes,
      ...(complete
        ? {
            finished_at: sql<Date>`now()`,
            error_message:
              counts.failed === 0
                ? null
                : counts.downloaded > 0
                  ? 'One or more country downloads failed.'
                  : 'All country downloads failed.',
          }
        : {}),
    })
    .where('id', '=', changed.run_id)
    .where('status', '=', 'running')
    .execute();
}
