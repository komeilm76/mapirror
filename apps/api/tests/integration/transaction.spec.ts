import { sql, type Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import {
  isTransient,
  TRANSACTION_IDLE_TIMEOUT_MS,
  withTransaction,
} from '../../src/db/transaction';
import type { Database, SqlDatabase } from '../../src/index';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * Acceptance test for `P1-DB-03`: **the rollback test passes**, and so do the four bounds that make a transaction
 * safe in a long-running process.
 *
 * Every test here runs against a real Postgres on a database it creates for itself, because the interesting
 * behaviours — a server-side idle kill, a read-only refusal, a serialization failure, a connection killed mid
 * transaction — are the server's, not Kysely's, and a mock would assert only what I already believe.
 */

const skipReason = await freshDatabaseSkipReason();

/** A table to write to, created per test so nothing depends on another test's leftovers. */
async function withProbeTable(
  run: (context: { db: Kysely<Database>; handle: SqlDatabase }) => Promise<void>,
): Promise<void> {
  await withFreshDatabase(
    async (database) => {
      await sql`create table tx_probe (id int primary key, n int not null)`.execute(database.db);
      await sql`insert into tx_probe (id, n) values (1, 0)`.execute(database.db);
      await run({ db: database.db, handle: database });
    },
    { prefix: 'tx', migrate: true },
  );
}

/** Reads the probe row's counter. */
async function counter(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ n: number }>`select n from tx_probe where id = 1`.execute(db);
  return result.rows[0]!.n;
}

describe.skipIf(skipReason !== null)('withTransaction', () => {
  it('commits when the work returns', async () => {
    await withProbeTable(async ({ db }) => {
      const result = await withTransaction(db, async (trx) => {
        await sql`update tx_probe set n = 1 where id = 1`.execute(trx);
        return 'done';
      });

      expect(result).toBe('done');
      expect(await counter(db)).toBe(1);
    });
  });

  it('rolls back when the work throws, and rethrows the original error', async () => {
    await withProbeTable(async ({ db }) => {
      const failure = new Error('the service changed its mind');

      await expect(
        withTransaction(db, async (trx) => {
          await sql`update tx_probe set n = 99 where id = 1`.execute(trx);
          // A second write after the first, so "rolled back" cannot be explained by "nothing happened".
          await sql`insert into tx_probe (id, n) values (2, 5)`.execute(trx);
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(await counter(db)).toBe(0);
      const rows = await sql<{ n: number }>`select count(*)::int as n from tx_probe`.execute(db);
      expect(rows.rows[0]?.n).toBe(1);
    });
  });

  it('refuses a write in a read-only transaction, at the server', async () => {
    await withProbeTable(async ({ db }) => {
      // Not a convention or a lint rule: PostgreSQL answers `25006`, so a read path that mutates cannot ship.
      await expect(
        withTransaction(
          db,
          async (trx) => {
            await sql`update tx_probe set n = 1 where id = 1`.execute(trx);
          },
          { readOnly: true },
        ),
      ).rejects.toMatchObject({ code: '25006' });

      expect(await counter(db)).toBe(0);
    });
  });

  it('is reclaimed by the server when the work goes idle inside the transaction', async () => {
    await withProbeTable(async ({ db, handle }) => {
      // The outage this prevents: a transaction that stops making progress keeps its locks and its pool slot. The
      // kill happens **server-side**, so it is asynchronous to us — measured: the backend disappears from
      // `pg_stat_activity` while the client is still sleeping, and the client only learns at its next statement.
      // Asserting "the promise rejected quickly" would therefore be asserting the wrong thing; the server letting
      // go is what matters, because that is what frees the row locks.
      let backend: number | undefined;
      const attempt = withTransaction(
        db,
        async (trx) => {
          const me = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
          backend = me.rows[0]!.pid;
          await sql`update tx_probe set n = 7 where id = 1`.execute(trx);
          // Idle in transaction: no statement is running, and nothing on the client cooperates with the timeout.
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          return sql`select 1`.execute(trx);
        },
        { idleTimeoutMs: 200, retries: 0 },
      );

      // Wait for the transaction to be under way, then watch the server reclaim it.
      const deadline = Date.now() + 1_200;
      let goneAt: number | undefined;
      while (Date.now() < deadline && goneAt === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (backend === undefined) continue;
        const still = await sql<{ n: number }>`
          select count(*)::int as n from pg_stat_activity where pid = ${backend}
        `.execute(handle.db);
        if (still.rows[0]?.n === 0) goneAt = Date.now();
      }

      expect(backend, 'the transaction must have started').toBeTypeOf('number');
      expect(goneAt, 'the server must reclaim an idle transaction').toBeDefined();
      // And it happened before the client-side sleep ended, i.e. on the server's schedule.
      await expect(attempt).rejects.toThrow(/connection|terminat/i);

      // The uncommitted write went with it, and the database is usable.
      expect(await counter(db)).toBe(0);
      expect((await sql`select 1`.execute(handle.db)).rows).toHaveLength(1);
    });
  });

  it('survives a connection killed in the middle of a transaction', async () => {
    await withProbeTable(async ({ db, handle }) => {
      // Measured failure this covers: `pg-pool` removes its own `error` listener while a client is checked out, so
      // a mid-transaction drop emitted on an emitter with no listener and Node threw it as an uncaught exception —
      // a Postgres failover would have taken the API down. Vitest fails a file that produces an unhandled error,
      // so reaching the assertions below is half the assertion.
      const work = withTransaction(
        db,
        async (trx) => {
          await sql`select pg_sleep(1)`.execute(trx);
        },
        { retries: 0 },
      );

      // Wait until the transaction is really running, then kill its backend from another connection.
      let pid: number | undefined;
      for (let tries = 0; tries < 40 && pid === undefined; tries += 1) {
        const found = await sql<{ pid: number }>`
          select pid from pg_stat_activity
           where state = 'active' and query like '%pg_sleep%' and pid <> pg_backend_pid()
           limit 1
        `.execute(handle.db);
        pid = found.rows[0]?.pid;
        if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(pid, 'the sleeping transaction must be running').toBeTypeOf('number');

      // Collect uncaught exceptions explicitly instead of relying on the runner to notice them: the failure mode
      // is "the transaction rejected correctly *and* the process was killed", and a test that only asserts the
      // rejection would pass while the second half went unnoticed.
      const uncaught: unknown[] = [];
      const collect = (error: unknown): void => {
        uncaught.push(error);
      };
      process.on('uncaughtException', collect);
      try {
        await sql`select pg_terminate_backend(${pid!})`.execute(handle.db);

        await expect(work).rejects.toThrow(/connection|terminat/i);
        // The socket error arrives asynchronously, after the rejection.
        await new Promise((resolve) => setTimeout(resolve, 250));
      } finally {
        process.off('uncaughtException', collect);
      }

      expect(uncaught).toEqual([]);
      // And the pool recovers: the dead client is gone, the next query opens a new one.
      const after = await sql<{ n: number }>`select n from tx_probe where id = 1`.execute(db);
      expect(after.rows[0]?.n).toBe(0);
    });
  });

  it('retries a serialization failure, so two conflicting transactions both land', async () => {
    await withProbeTable(async ({ db }) => {
      /** Read-modify-write under `serializable`, which is exactly the shape that can fail with 40001. */
      const increment = (): Promise<void> =>
        withTransaction(
          db,
          async (trx) => {
            const current = await sql<{ n: number }>`select n from tx_probe where id = 1`.execute(
              trx,
            );
            // The pause is what creates the conflict: both transactions read the same value before either writes.
            await new Promise((resolve) => setTimeout(resolve, 60));
            await sql`update tx_probe set n = ${current.rows[0]!.n + 1} where id = 1`.execute(trx);
          },
          { isolation: 'serializable', retries: 3, backoffMs: 10 },
        );

      const results = await Promise.allSettled([increment(), increment()]);

      // Measured without retries: one `ok`, one `40001`. With them, both succeed and no increment is lost.
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await counter(db)).toBe(2);
    });
  });

  it('does not retry an error the database did not ask to be retried', async () => {
    await withProbeTable(async ({ db }) => {
      const work = vi.fn(() => {
        throw new Error('a bug in the service');
      });

      await expect(withTransaction(db, work, { retries: 3 })).rejects.toThrow(
        'a bug in the service',
      );
      // One attempt: retrying a constraint violation or a plain bug just multiplies the damage.
      expect(work).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses to nest, and says what to do instead', async () => {
    await withProbeTable(async ({ db }) => {
      // Kysely 0.29 throws "calling the transaction method for a Transaction is not supported" from its own
      // plumbing; a caller needs to be told the alternative, not the symptom.
      await withTransaction(db, async (trx) => {
        await sql`update tx_probe set n = 4 where id = 1`.execute(trx);

        // TypeScript already rejects this call (`Transaction<Database>` is not a nested-transaction argument), so
        // the cast is deliberate: the guard exists for untyped callers — plain JS, a `Kysely`-shaped value from
        // another package — who would otherwise get Kysely's internal message instead of an instruction.
        const nested = withTransaction(trx as unknown as Kysely<Database>, () => Promise.resolve());
        await expect(nested).rejects.toThrow(/cannot open a transaction inside a transaction/);

        // The outer transaction is untouched by the refusal, which is the property that matters.
        await sql`update tx_probe set n = 5 where id = 1`.execute(trx);
      });

      expect(await counter(db)).toBe(5);
    });
  });

  it('rejects options that would otherwise become SQL', async () => {
    await withProbeTable(async ({ db }) => {
      // `SET LOCAL` takes no bind parameters, so these numbers are interpolated. A non-integer is refused rather
      // than pasted into the statement.
      await expect(
        withTransaction(db, () => Promise.resolve(), { idleTimeoutMs: 1.5 }),
      ).rejects.toThrow(RangeError);
      await expect(
        withTransaction(db, () => Promise.resolve(), { idleTimeoutMs: 0 }),
      ).rejects.toThrow(RangeError);
      await expect(
        withTransaction(db, () => Promise.resolve(), { statementTimeoutMs: -1 }),
      ).rejects.toThrow(RangeError);
      await expect(withTransaction(db, () => Promise.resolve(), { retries: -1 })).rejects.toThrow(
        RangeError,
      );
    });
  });

  it('applies a statement timeout when one is asked for', async () => {
    await withProbeTable(async ({ db }) => {
      await expect(
        withTransaction(
          db,
          async (trx) => {
            await sql`select pg_sleep(2)`.execute(trx);
          },
          { statementTimeoutMs: 150, retries: 0 },
        ),
      ).rejects.toMatchObject({ code: '57014' });
    });
  });
});

describe('transaction constants', () => {
  it('defaults to an idle bound that is short enough to matter and long enough to be fair', () => {
    expect(TRANSACTION_IDLE_TIMEOUT_MS).toBe(30_000);
  });
});

describe('isTransient', () => {
  it.each(['40001', '40P01'])('treats %s as retryable', (code) => {
    expect(isTransient(Object.assign(new Error('x'), { code }))).toBe(true);
  });

  it.each(['23505', '25006', '57014', 'ECONNREFUSED'])('does not retry %s', (code) => {
    expect(isTransient(Object.assign(new Error('x'), { code }))).toBe(false);
  });

  it('finds the code through a wrapper’s cause, and survives a value with none', () => {
    const wrapped = new Error('wrapped', {
      cause: Object.assign(new Error('root'), { code: '40001' }),
    });

    expect(isTransient(wrapped)).toBe(true);
    expect(isTransient(new Error('no code'))).toBe(false);
    expect(isTransient('not an error')).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});
