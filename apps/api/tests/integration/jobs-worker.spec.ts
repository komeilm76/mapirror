import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import { claimNextJob, startJobWorker } from '../../src/modules/jobs/worker';
import { withTransaction } from '../../src/db/transaction';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/** The queue must be exercised against PostgreSQL: row locks and concurrent claim semantics are server behaviour. */
const skipReason = await freshDatabaseSkipReason();

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe.skipIf(skipReason !== null)('PostgreSQL job worker', () => {
  it('claims the highest-priority due job and leaves future work queued', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const low = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {}, priority: 1 })
          .returning('id')
          .executeTakeFirstOrThrow();
        const high = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {}, priority: 8 })
          .returning('id')
          .executeTakeFirstOrThrow();
        const future = await db
          .insertInto('jobs')
          .values({
            type: 'prune',
            payload: {},
            priority: 99,
            run_after: new Date(Date.now() + 60_000),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const unsupported = await db
          .insertInto('jobs')
          .values({ type: 'download', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();

        const claimed = await claimNextJob(db, 'priority-worker', ['prune']);

        expect(claimed?.id).toBe(high.id);
        expect(claimed).toMatchObject({
          status: 'running',
          locked_by: 'priority-worker',
          attempts: 1,
        });
        const untouched = await db
          .selectFrom('jobs')
          .select(['id', 'status'])
          .where('id', 'in', [low.id, future.id, unsupported.id])
          .execute();
        expect(untouched).toEqual(
          expect.arrayContaining([
            { id: low.id, status: 'queued' },
            { id: future.id, status: 'queued' },
            { id: unsupported.id, status: 'queued' },
          ]),
        );
      },
      { migrate: true, prefix: 'jobclaim' },
    );
  });

  it('skips a higher-priority row locked by another transaction', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const locked = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {}, priority: 10 })
          .returning('id')
          .executeTakeFirstOrThrow();
        const available = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {}, priority: 0 })
          .returning('id')
          .executeTakeFirstOrThrow();

        let pendingClaim: Promise<Awaited<ReturnType<typeof claimNextJob>>> | undefined;
        const observation = await withTransaction(
          db,
          async (trx) => {
            await sql`select id from jobs where id = ${locked.id} for update`.execute(trx);
            pendingClaim = claimNextJob(db, 'skip-lock-worker', ['prune']);
            return Promise.race([
              pendingClaim.then((job) => ({ job, withinWindow: true })),
              new Promise<{ job: null; withinWindow: false }>((resolve) =>
                setTimeout(() => resolve({ job: null, withinWindow: false }), 250),
              ),
            ]);
          },
          { retries: 0 },
        );
        const eventualClaim = await pendingClaim;

        expect(observation.withinWindow).toBe(true);
        expect(observation.job?.id).toBe(available.id);
        expect(eventualClaim?.id).toBe(available.id);
      },
      { migrate: true, prefix: 'jobskip' },
    );
  });

  it('marks a failed handler with a generic persisted message', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const job = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();
        let attempts = 0;
        const worker = startJobWorker(
          db,
          {
            prune: () => {
              attempts += 1;
              return Promise.reject(new Error('private database detail'));
            },
          },
          {
            concurrency: 1,
            pollIntervalMs: 5,
            retryBaseDelayMs: 5,
            retryMaxDelayMs: 20,
            log,
          },
        );

        try {
          await waitForStatus(db, job.id, 'failed');
        } finally {
          await worker.stop();
        }

        const failed = await db
          .selectFrom('jobs')
          .select(['status', 'error_code', 'error_message', 'locked_by', 'locked_at', 'attempts'])
          .where('id', '=', job.id)
          .executeTakeFirstOrThrow();
        expect(failed).toMatchObject({
          status: 'failed',
          error_code: 'JOB_HANDLER_FAILED',
          error_message: 'The job handler failed.',
          locked_by: null,
          locked_at: null,
          attempts: 3,
        });
        expect(attempts).toBe(3);
        expect(failed.error_message).not.toContain('private database detail');
      },
      { migrate: true, prefix: 'jobfailure' },
    );
  });

  it('lets two independent workers process each queued job exactly once', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const jobs = await db
          .insertInto('jobs')
          .values(
            Array.from({ length: 24 }, (_, index) => ({
              type: 'prune' as const,
              payload: { index },
            })),
          )
          .returning('id')
          .execute();
        const executions = new Map<string, number>();
        const handler = async (job: { id: string }) => {
          executions.set(job.id, (executions.get(job.id) ?? 0) + 1);
          await new Promise((resolve) => setTimeout(resolve, 8));
          return { processed: true };
        };
        const options = {
          concurrency: 1,
          pollIntervalMs: 10,
          log,
          workerId: () => 'integration-worker',
        };
        const first = startJobWorker(db, { prune: handler }, options);
        const second = startJobWorker(
          db,
          { prune: handler },
          { ...options, workerId: () => 'second-integration-worker' },
        );

        try {
          await waitForAllSucceeded(db, jobs.length);
        } finally {
          await Promise.all([first.stop(), second.stop()]);
        }

        expect([...executions.keys()].sort()).toEqual(jobs.map(({ id }) => id).sort());
        expect([...executions.values()]).toEqual(Array.from({ length: jobs.length }, () => 1));

        const rows = await db
          .selectFrom('jobs')
          .select(['status', 'attempts', 'locked_by', 'locked_at', 'result'])
          .execute();
        expect(rows).toHaveLength(jobs.length);
        expect(rows.every((row) => row.status === 'succeeded' && row.attempts === 1)).toBe(true);
        expect(rows.every((row) => row.locked_by === null && row.locked_at === null)).toBe(true);
        expect(
          rows.every(
            ({ result }) =>
              result !== null &&
              typeof result === 'object' &&
              !Array.isArray(result) &&
              result.processed === true,
          ),
        ).toBe(true);
      },
      { migrate: true, prefix: 'jobworkers' },
    );
  }, 15_000);
});

/** Fails instead of hanging forever if a handler failure is not persisted. */
async function waitForStatus(
  db: Parameters<typeof claimNextJob>[0],
  id: string,
  status: 'failed',
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await db
      .selectFrom('jobs')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (row.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`job ${id} did not reach ${status} before the deadline`);
}

/** Fails instead of hanging forever if the workers stop making progress. */
async function waitForAllSucceeded(
  db: Parameters<typeof claimNextJob>[0],
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const count = await db
      .selectFrom('jobs')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('status', '=', 'succeeded')
      .executeTakeFirstOrThrow();
    if (count.count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const rows = await db.selectFrom('jobs').select(['id', 'status', 'error_code']).execute();
  throw new Error(
    `workers did not finish ${expected} jobs before deadline: ${JSON.stringify(rows)}`,
  );
}
