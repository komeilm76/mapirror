/**
 * Race-safe download-job enqueueing and duplicate conflict translation (`P2-JOB-07`, CACHE-1).
 *
 * PostgreSQL's partial unique index is the authority for one `queued` or `running` job per country/version. This module
 * maps only that named constraint to the documented `JOB_ALREADY_RUNNING` conflict; it does not check first and race.
 *
 * @module modules/jobs/enqueue-download
 */

import type { Kysely } from 'kysely';

import { lockCountryCacheForEnqueue } from '../../db/repositories/cache';
import type { Database } from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import { AppError } from '../../lib/errors';

/** Validated values needed to create a queued download job. */
export interface EnqueueDownloadJobInput {
  /** Existing catalog country UUID. */
  readonly countryId: string;
  /** Requested source version label, including the mutable `latest` label. */
  readonly version: string;
  /** Optional source selector persisted for the worker. */
  readonly origin?: 'geofabrik_snapshot' | 'geofabrik_latest';
  /** Whether the worker should skip when the source has not changed. */
  readonly onlyIfChanged?: boolean;
  /** Admin UUID that requested the job. */
  readonly createdBy?: string;
}

/**
 * Creates a queued download job, relying on PostgreSQL to arbitrate concurrent duplicate requests.
 *
 * A prior `select` cannot provide a uniqueness guarantee: two API processes could both see no active row. The unique
 * partial index serializes the inserts instead, and only `jobs_one_active_download` is translated into the public 409.
 * Other database errors are preserved for the normal error handler.
 *
 * The caller must validate the request and perform source/version and disk-capacity checks before calling this
 * function. No transaction should span those network or filesystem checks.
 *
 * @param database - API database handle.
 * @param input - Validated country, version and optional job metadata.
 * @returns The generated job UUID.
 * @throws {AppError} `JOB_ALREADY_RUNNING` when the same country/version already has a queued or running download.
 */
export async function enqueueDownloadJob(
  database: Kysely<Database>,
  input: EnqueueDownloadJobInput,
): Promise<string> {
  const payload = {
    countryId: input.countryId,
    version: input.version,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.onlyIfChanged === undefined ? {} : { onlyIfChanged: input.onlyIfChanged }),
  };

  try {
    return await withTransaction(database, async (trx) => {
      // Cache deletion holds the matching session advisory lock through post-commit file cleanup. This short
      // transaction-scoped lock serializes the final admission step with deletion across API processes.
      await lockCountryCacheForEnqueue(trx, input.countryId);
      const country = await trx
        .selectFrom('countries')
        .select('id')
        .where('id', '=', input.countryId)
        .forKeyShare()
        .executeTakeFirst();
      if (country === undefined) {
        throw new AppError('NOT_FOUND', 'The requested catalog region does not exist.');
      }

      const job = await trx
        .insertInto('jobs')
        .values({
          type: 'download',
          payload,
          ...(input.createdBy === undefined ? {} : { created_by: input.createdBy }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return job.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'jobs_one_active_download')) {
      throw new AppError(
        'JOB_ALREADY_RUNNING',
        'A download for this country and version is already queued or running.',
        { countryId: input.countryId, version: input.version },
        { cause: error },
      );
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}
