import { describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../../src/config/env';
import { createDatabase } from '../../src/db/client';
import type { Job } from '../../src/db/schema';
import {
  reapStaleJobs,
  startJobReaper,
  JOB_REAPER_INTERVAL_MS,
  STALE_JOB_AGE_MS,
} from '../../src/modules/jobs/reaper';
import { claimNextJob, startJobWorker } from '../../src/modules/jobs/worker';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/** Reaping and session-level advisory locks are PostgreSQL behavior, so these acceptance tests use a real server. */
const skipReason = await freshDatabaseSkipReason();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe.skipIf(skipReason !== null)('PostgreSQL job heartbeat and recovery', () => {
  it('refreshes locked_at while a slow handler is still running', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const job = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();
        const gate = deferred<void>();
        const worker = startJobWorker(
          db,
          {
            prune: async () => {
              await gate.promise;
              return { done: true };
            },
          },
          { concurrency: 1, pollIntervalMs: 5, heartbeatIntervalMs: 20, log },
        );

        try {
          const first = await waitForJob(db, job.id, (row) => row.status === 'running');
          expect(first.locked_at).toBeInstanceOf(Date);
          const refreshed = await waitForJob(
            db,
            job.id,
            (row) => row.locked_at !== null && row.locked_at > first.locked_at!,
          );
          expect(refreshed.locked_at!.getTime()).toBeGreaterThan(first.locked_at!.getTime());
          gate.resolve();
          await waitForJob(db, job.id, (row) => row.status === 'succeeded');
        } finally {
          gate.resolve();
          await worker.stop();
        }
      },
      { migrate: true, prefix: 'jobheartbeat' },
    );
  });

  it('lets handlers use their pinned session without exhausting a one-connection pool', async () => {
    await withFreshDatabase(
      async (_freshDatabase, name) => {
        const singleConnectionDb = createDatabase(
          parseEnv({ DATABASE_URL: dsnFor(name), DB_POOL_MAX: '1' }),
        );
        try {
          const job = await singleConnectionDb.db
            .insertInto('jobs')
            .values({ type: 'prune', payload: {} })
            .returning('id')
            .executeTakeFirstOrThrow();
          const worker = startJobWorker(
            singleConnectionDb.db,
            {
              prune: async (_job, { database }) => {
                const seen = await database.selectFrom('jobs').select('id').execute();
                return { seen: seen.length };
              },
            },
            { concurrency: 1, pollIntervalMs: 5, log },
          );
          try {
            const succeeded = await waitForJob(
              singleConnectionDb.db,
              job.id,
              (row) => row.status === 'succeeded',
            );
            expect(succeeded.result).toEqual({ seen: 1 });
          } finally {
            await worker.stop();
          }
        } finally {
          await singleConnectionDb.close();
        }
      },
      { migrate: true, prefix: 'jobpinneddb' },
    );
  });

  it('never steals a stale-looking job while the slow worker still holds its advisory lock', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const job = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();
        const gate = deferred<void>();
        const worker = startJobWorker(
          db,
          {
            prune: async () => {
              await gate.promise;
              return { done: true };
            },
          },
          { concurrency: 1, pollIntervalMs: 5, heartbeatIntervalMs: 60_000, log },
        );

        try {
          await waitForJob(db, job.id, (row) => row.status === 'running');
          await db
            .updateTable('jobs')
            .set({ locked_at: new Date(Date.now() - 60_000) })
            .where('id', '=', job.id)
            .execute();

          const result = await reapStaleJobs(db, { staleAfterMs: 100 });
          expect(result).toMatchObject({ examined: 1, requeued: 0, failed: 0, lockBusy: 1 });
          expect(
            await db
              .selectFrom('jobs')
              .select('status')
              .where('id', '=', job.id)
              .executeTakeFirst(),
          ).toEqual({ status: 'running' });

          gate.resolve();
          await waitForJob(db, job.id, (row) => row.status === 'succeeded');
        } finally {
          gate.resolve();
          await worker.stop();
        }
      },
      { migrate: true, prefix: 'jobslowlock' },
    );
  });

  it('delays a failed handler retry until run_after and uses only the configured number of attempts', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const job = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {}, max_attempts: 2 })
          .returning('id')
          .executeTakeFirstOrThrow();
        let executions = 0;
        const worker = startJobWorker(
          db,
          {
            prune: () => {
              executions += 1;
              return Promise.reject(new Error('expected retry'));
            },
          },
          { concurrency: 1, pollIntervalMs: 5, retryBaseDelayMs: 150, retryMaxDelayMs: 200, log },
        );

        try {
          const queued = await waitForJob(
            db,
            job.id,
            (row) => row.status === 'queued' && row.attempts === 1,
          );
          expect(queued.run_after.getTime()).toBeGreaterThan(Date.now());
          const failed = await waitForJob(db, job.id, (row) => row.status === 'failed');
          expect(failed.attempts).toBe(2);
          expect(executions).toBe(2);
        } finally {
          await worker.stop();
        }
      },
      { migrate: true, prefix: 'jobbackoff' },
    );
  });

  it('requeues an abandoned attempt with WORKER_LOST and fails after attempts are exhausted', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const retryable = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();
        const exhausted = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {}, max_attempts: 1 })
          .returning('id')
          .executeTakeFirstOrThrow();
        const abandoned = await Promise.all([
          claimNextJob(db, 'dead-worker-a', ['prune']),
          claimNextJob(db, 'dead-worker-b', ['prune']),
        ]);
        expect(abandoned.map((row) => row?.id).sort()).toEqual([retryable.id, exhausted.id].sort());
        await db
          .updateTable('jobs')
          .set({ locked_at: new Date(Date.now() - 60_000) })
          .where('id', 'in', [retryable.id, exhausted.id])
          .execute();

        const result = await reapStaleJobs(db, {
          staleAfterMs: 100,
          retryBaseDelayMs: 10,
          retryMaxDelayMs: 20,
        });
        expect(result).toMatchObject({ examined: 2, requeued: 1, failed: 1, lockBusy: 0 });

        const rows = await db
          .selectFrom('jobs')
          .select([
            'id',
            'status',
            'attempts',
            'max_attempts',
            'run_after',
            'error_code',
            'error_message',
            'finished_at',
          ])
          .where('id', 'in', [retryable.id, exhausted.id])
          .execute();
        const retried = rows.find((row) => row.id === retryable.id)!;
        const failed = rows.find((row) => row.id === exhausted.id)!;
        expect(retried).toMatchObject({
          status: 'queued',
          attempts: 1,
          error_code: 'WORKER_LOST',
          error_message: 'The worker stopped before this job completed.',
          finished_at: null,
        });
        expect(retried.run_after.getTime()).toBeGreaterThan(Date.now());
        expect(failed).toMatchObject({ status: 'failed', attempts: 1, error_code: 'WORKER_LOST' });
        expect(failed.finished_at).toBeInstanceOf(Date);
      },
      { migrate: true, prefix: 'jobrecovery' },
    );
  });

  it('runs the recovery pass immediately and then on its configured cadence', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const job = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();
        await claimNextJob(db, 'terminated-worker', ['prune']);
        await db
          .updateTable('jobs')
          .set({ locked_at: new Date(Date.now() - 60_000) })
          .where('id', '=', job.id)
          .execute();

        const reaper = startJobReaper(db, {
          log,
          pollIntervalMs: 20,
          staleAfterMs: 100,
          retryBaseDelayMs: 10,
          retryMaxDelayMs: 20,
        });
        try {
          const recovered = await waitForJob(db, job.id, (row) => row.status === 'queued');
          expect(recovered.error_code).toBe('WORKER_LOST');
        } finally {
          await reaper.stop();
        }
      },
      { migrate: true, prefix: 'jobreaperloop' },
    );
  });

  it('keeps the production stale-age plus scan cadence within the five-minute recovery bound', () => {
    expect(STALE_JOB_AGE_MS + JOB_REAPER_INTERVAL_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Polls a job row until an acceptance predicate holds, failing with a useful row snapshot on timeout. */
async function waitForJob(
  db: Parameters<typeof claimNextJob>[0],
  id: string,
  predicate: (job: Job) => boolean,
): Promise<Job> {
  const deadline = Date.now() + 3_000;
  let latest: Job | undefined;
  while (Date.now() < deadline) {
    latest = await db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${id} did not reach expected state: ${JSON.stringify(latest)}`);
}
