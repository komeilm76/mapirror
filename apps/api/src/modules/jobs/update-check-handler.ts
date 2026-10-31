/** Per-country execution and safe aggregation for bulk update-check jobs (`P4-UPD-02`).
 *
 * @module modules/jobs/update-check-handler
 */

import { UpdateCheckJobPayloadSchema, type UpdateCheckJobResult } from '@mapirror/shared';

import type { Job } from '../../db/schema';
import { UpdateCheckNotCachedError, type UpdateChecker } from '../updates/update-check';
import type { JobHandler } from './worker';

/** Dependencies for a bulk update-check worker. */
export interface UpdateCheckHandlerOptions {
  /** Shared checker, including its bounded source-detail cache. */
  readonly checker: UpdateChecker;
}

/** Creates the durable `update_check` worker handler. */
export function createUpdateCheckHandler(options: UpdateCheckHandlerOptions): JobHandler {
  return async (job: Job, context): Promise<UpdateCheckJobResult> => {
    if (job.type !== 'update_check')
      throw new TypeError('update check handler received a non-update job');
    const payload = UpdateCheckJobPayloadSchema.parse(job.payload);
    throwIfAborted(context.signal);

    let countryQuery = context.database
      .selectFrom('country_cache')
      .select('country_id')
      .orderBy('country_id', 'asc');
    if (payload.countryIds !== undefined) {
      countryQuery = countryQuery.where('country_id', 'in', payload.countryIds);
    }
    const cachedCountries = await countryQuery.execute();
    const requestedCount = payload.countryIds?.length ?? cachedCountries.length;
    const missingCount = requestedCount - cachedCountries.length;
    const total = requestedCount;
    let checked = 0;
    let processed = 0;
    let updateAvailable = 0;
    let upToDate = 0;
    let unknown = 0;

    await context.reportProgress({
      progressBytes: BigInt(missingCount),
      totalBytes: BigInt(total),
    });
    for (const { country_id: countryId } of cachedCountries) {
      if (context.signal.aborted) break;
      try {
        const result = await options.checker.check(countryId, context.database);
        checked += 1;
        if (result.state === 'update_available') updateAvailable += 1;
        else if (result.state === 'up_to_date') upToDate += 1;
        else unknown += 1;
      } catch (error) {
        if (!(error instanceof UpdateCheckNotCachedError)) throw error;
        // The cache row was removed after target resolution; count it as a skipped item, not a failed job.
      }
      processed += 1;
      await context.reportProgress({
        progressBytes: BigInt(missingCount + processed),
        totalBytes: BigInt(total),
      });
    }

    const skipped = total - checked;
    if (!context.signal.aborted) {
      await context.reportProgress({ progressBytes: BigInt(total), totalBytes: BigInt(total) });
    }
    return { total, checked, updateAvailable, upToDate, unknown, skipped };
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Update check job was canceled.');
}
