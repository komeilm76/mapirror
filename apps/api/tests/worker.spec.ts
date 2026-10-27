import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { MAX_WORKER_CONCURRENCY } from '../src/config/limits';
import type { Database } from '../src/db/schema';
import { startJobWorker, type WorkerLog } from '../src/modules/jobs/worker';

const log: WorkerLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('startJobWorker', () => {
  it('rejects concurrency beyond the process safety bound before starting slots', () => {
    // The implementation must validate before allocating `concurrency` polling loops or touching the DB.
    const noDatabase = {} as Kysely<Database>;

    expect(() =>
      startJobWorker(
        noDatabase,
        { prune: () => Promise.resolve() },
        { concurrency: MAX_WORKER_CONCURRENCY + 1, log },
      ),
    ).toThrow(`worker concurrency must be between 1 and ${MAX_WORKER_CONCURRENCY}`);
  });

  it('stops cleanly when no job handler has been registered', async () => {
    // The queue remains untouched until a job-specific task registers its handler.
    const noDatabase = {} as Kysely<Database>;
    const worker = startJobWorker(noDatabase, {}, { concurrency: 2, log });

    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
