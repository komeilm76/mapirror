/** Durable admission for asynchronous bulk update checks (`P4-UPD-02`).
 *
 * @module modules/jobs/enqueue-update-check
 */

import type { Kysely } from 'kysely';

import type { Database } from '../../db/schema';

/** Values for a requested bulk update check. */
export interface EnqueueUpdateCheckOptions {
  /** Explicit cached-country ids; omitted means the worker selects all cached countries when it runs. */
  readonly countryIds?: readonly string[];
  /** Administrator requesting the job. */
  readonly createdBy: string;
}

/** Inserts one independent bulk update-check job and returns its durable id. */
export async function enqueueUpdateCheckJob(
  database: Kysely<Database>,
  options: EnqueueUpdateCheckOptions,
): Promise<string> {
  const job = await database
    .insertInto('jobs')
    .values({
      type: 'update_check',
      payload: options.countryIds === undefined ? {} : { countryIds: [...options.countryIds] },
      created_by: options.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return job.id;
}
