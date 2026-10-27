import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Job } from '../../src/db/schema';
import {
  JobCancellationRequestedError,
  requestJobCancellation,
} from '../../src/modules/jobs/cancellation';
import { createJobProgressReporter } from '../../src/modules/jobs/progress';
import { claimNextJob, startJobWorker } from '../../src/modules/jobs/worker';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/** Progress updates and the cancellation race are verified against PostgreSQL, not a mocked query builder. */
const skipReason = await freshDatabaseSkipReason();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe.skipIf(skipReason !== null)('PostgreSQL job progress and cancellation', () => {
  it('keeps progress monotonic even when a stale reporter submits a lower byte count', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const inserted = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();
        const job = await claimNextJob(db, 'progress-worker', ['prune']);
        expect(job?.id).toBe(inserted.id);

        const currentReporter = createJobProgressReporter(db, job!, 'progress-worker', {
          minIntervalMs: 5_000,
        });
        const staleReporter = createJobProgressReporter(db, job!, 'progress-worker', {
          minIntervalMs: 5_000,
        });
        await currentReporter.report({
          progressBytes: 100n,
          totalBytes: 200n,
          phase: 'downloading',
        });
        await staleReporter.report({
          progressBytes: 60n,
          totalBytes: 200n,
          phase: 'downloading',
        });
        const afterStaleUpdate = await db
          .selectFrom('jobs')
          .select('progress_bytes')
          .where('id', '=', inserted.id)
          .executeTakeFirstOrThrow();
        expect(afterStaleUpdate.progress_bytes).toBe('100');
        await currentReporter.report({
          progressBytes: 150n,
          totalBytes: 200n,
          phase: 'verifying',
        });
        const beforeThrottleFlush = await db
          .selectFrom('jobs')
          .select('progress_bytes')
          .where('id', '=', inserted.id)
          .executeTakeFirstOrThrow();
        expect(beforeThrottleFlush.progress_bytes).toBe('100');
        await Promise.all([currentReporter.flush(), staleReporter.stop()]);

        const row = await db
          .selectFrom('jobs')
          .select(['progress_bytes', 'total_bytes', 'speed_bps', 'phase'])
          .where('id', '=', inserted.id)
          .executeTakeFirstOrThrow();
        expect(row.progress_bytes).toBe('150');
        expect(row.total_bytes).toBe('200');
        expect(row.speed_bps).not.toBeNull();
        expect(row.phase).toBe('verifying');
        await currentReporter.stop();
      },
      { migrate: true, prefix: 'jobprogress' },
    );
  });

  it('cancels a queued job immediately and makes it unclaimable', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const job = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();

        const first = await requestJobCancellation(db, job.id);
        const repeated = await requestJobCancellation(db, job.id);
        const row = await db
          .selectFrom('jobs')
          .select(['status', 'cancel_requested', 'finished_at'])
          .where('id', '=', job.id)
          .executeTakeFirstOrThrow();

        expect(first).toMatchObject({ found: true, accepted: true, status: 'canceled' });
        expect(repeated).toMatchObject({ found: true, accepted: true, status: 'canceled' });
        expect(row).toMatchObject({ status: 'canceled', cancel_requested: true });
        expect(row.finished_at).toBeInstanceOf(Date);
        expect(await claimNextJob(db, 'must-not-claim', ['prune'])).toBeNull();
      },
      { migrate: true, prefix: 'jobcancelqueued' },
    );
  });

  it('runs an already-aborted handler so it can clean a resumed .part before cancellation is persisted', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const directory = await mkdtemp(join(tmpdir(), 'mapirror-cancel-start-'));
        const job = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {}, cancel_requested: true })
          .returning('id')
          .executeTakeFirstOrThrow();
        const partPath = join(directory, `${job.id}.part`);
        const handlerStarted = deferred<void>();
        await writeFile(partPath, 'resumed partial bytes');
        const worker = startJobWorker(
          db,
          {
            prune: async (_job, { signal }) => {
              handlerStarted.resolve();
              expect(signal.aborted).toBe(true);
              expect(signal.reason).toBeInstanceOf(JobCancellationRequestedError);
              await rm(partPath, { force: true });
            },
          },
          {
            concurrency: 1,
            pollIntervalMs: 5,
            cancellationPollIntervalMs: 25,
            log,
            workerId: () => 'pre-canceled-worker',
          },
        );

        try {
          await withTimeout(handlerStarted.promise, 1_500);
          const canceled = await waitForJob(db, job.id, (row) => row.status === 'canceled', 1_500);
          expect(canceled.cancel_requested).toBe(true);
          await expect(readFile(partPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          await worker.stop();
          await rm(directory, { recursive: true, force: true });
        }
      },
      { migrate: true, prefix: 'jobcancelpre' },
    );
  });

  it('aborts a running handler promptly and waits for its .part cleanup before marking canceled', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const directory = await mkdtemp(join(tmpdir(), 'mapirror-cancel-'));
        const job = await db
          .insertInto('jobs')
          .values({ type: 'prune', payload: {} })
          .returning('id')
          .executeTakeFirstOrThrow();
        const partPath = join(directory, `${job.id}.part`);
        const started = deferred<void>();
        const cleanupStarted = deferred<void>();
        const allowCleanup = deferred<void>();
        const worker = startJobWorker(
          db,
          {
            prune: async (_job, { signal }) => {
              await writeFile(partPath, 'partial bytes');
              started.resolve();
              try {
                await waitForAbort(signal, 4_000);
                if (signal.reason instanceof JobCancellationRequestedError) {
                  cleanupStarted.resolve();
                  await allowCleanup.promise;
                  await rm(partPath, { force: true });
                }
                return { canceled: signal.aborted };
              } finally {
                await rm(partPath, { force: true });
              }
            },
          },
          {
            concurrency: 1,
            pollIntervalMs: 5,
            cancellationPollIntervalMs: 25,
            log,
            workerId: () => 'cancel-worker',
          },
        );

        try {
          await started.promise;
          const requestedAt = Date.now();
          const request = await requestJobCancellation(db, job.id);
          expect(request).toMatchObject({ found: true, accepted: true, status: 'running' });
          await withTimeout(cleanupStarted.promise, 1_500);
          const duringCleanup = await db
            .selectFrom('jobs')
            .select('status')
            .where('id', '=', job.id)
            .executeTakeFirstOrThrow();
          expect(duringCleanup.status).toBe('running');
          await expect(readFile(partPath, 'utf8')).resolves.toBe('partial bytes');
          allowCleanup.resolve();
          const canceled = await waitForJob(db, job.id, (row) => row.status === 'canceled', 2_000);

          expect(Date.now() - requestedAt).toBeLessThan(2_000);
          expect(canceled.cancel_requested).toBe(true);
          await expect(readFile(partPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          allowCleanup.resolve();
          await worker.stop();
          await rm(directory, { recursive: true, force: true });
        }
      },
      { migrate: true, prefix: 'jobcancelrunning' },
    );
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Bounds an awaited signal so a broken cancellation monitor cannot hang the integration suite. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation exceeded ${timeoutMs} ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Waits for a handler abort with a bounded timeout so a broken monitor cannot hang a test worker. */
function waitForAbort(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Polls a job row until the expected state or deadline. */
async function waitForJob(
  db: Parameters<typeof claimNextJob>[0],
  id: string,
  predicate: (job: Job) => boolean,
  timeoutMs: number,
): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  let latest: Job | undefined;
  while (Date.now() < deadline) {
    latest = await db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${id} did not reach expected state: ${JSON.stringify(latest)}`);
}
