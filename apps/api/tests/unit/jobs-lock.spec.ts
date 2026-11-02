import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database } from '../../src/db/schema';
import { releaseJobLock, tryAcquireJobLock } from '../../src/modules/jobs/lock';

function makeSession(answers: unknown[]) {
  const executeQuery = vi.fn(() => {
    const answer = answers.shift();
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer ?? { rows: [] });
  });
  const executor = {
    transformQuery: vi.fn((node: unknown) => node),
    compileQuery: vi.fn((node: unknown) => node),
    executeQuery,
  };
  const session = { getExecutor: () => executor } as unknown as Kysely<Database>;
  return { session, executor };
}

describe('job advisory-lock queries', () => {
  it('returns true only for an explicit acquired row', async () => {
    const { session } = makeSession([{ rows: [{ acquired: true }] }]);
    await expect(tryAcquireJobLock(session, 'job-one')).resolves.toBe(true);
  });

  it('returns false for a held lock, no row, or a non-true driver value', async () => {
    const { session, executor } = makeSession([
      { rows: [{ acquired: false }] },
      { rows: [] },
      { rows: [{ acquired: 1 }] },
    ]);

    await expect(tryAcquireJobLock(session, 'job-two')).resolves.toBe(false);
    await expect(tryAcquireJobLock(session, 'job-three')).resolves.toBe(false);
    await expect(tryAcquireJobLock(session, 'job-four')).resolves.toBe(false);
    expect(executor.executeQuery).toHaveBeenCalledTimes(3);
  });

  it('releases a lock normally', async () => {
    const { session, executor } = makeSession([{ rows: [{ pg_advisory_unlock: true }] }]);

    await expect(releaseJobLock(session, 'job-five')).resolves.toBeUndefined();
    expect(executor.executeQuery).toHaveBeenCalledTimes(1);
  });

  it('falls back to releasing every session lock, then rethrows the original unlock error', async () => {
    const original = new Error('unlock failed');
    const { session, executor } = makeSession([original, { rows: [] }]);

    await expect(releaseJobLock(session, 'job-six')).rejects.toBe(original);
    expect(executor.executeQuery).toHaveBeenCalledTimes(2);
  });

  it('preserves the original error if the defensive unlock-all also fails', async () => {
    const original = new Error('unlock failed');
    const { session, executor } = makeSession([original, new Error('session already closed')]);

    await expect(releaseJobLock(session, 'job-seven')).rejects.toBe(original);
    expect(executor.executeQuery).toHaveBeenCalledTimes(2);
  });
});
