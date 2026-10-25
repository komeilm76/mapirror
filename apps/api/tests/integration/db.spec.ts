import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildApp,
  checkDatabase,
  createDatabase,
  parseEnv,
  type AppConfig,
  type SqlDatabase,
} from '../../src/index';

/**
 * The `db` stage against a **real** Postgres (`09-development.md` §7: integration tests use
 * `DATABASE_URL_TEST`). Everything here is behaviour a stub cannot show: that the boot really opens a pool, that a
 * query really round-trips, that a failed connection really fails the boot, and that closing the app really
 * releases the connections.
 *
 * When no server answers, the suite reports itself as skipped **with the reason** rather than passing quietly —
 * and the behaviours that must never depend on a live server (the failure path, the decorator, the close hook)
 * are covered by unit tests next to this file, so nothing important is only tested here.
 */

/** DSN from the environment, defaulting to the documented local test database. */
const DSN =
  process.env.DATABASE_URL_TEST ?? 'postgres://mapirror:mapirror@localhost:5432/mapirror_test';

/** A config pointing at the test database, with a small pool so the count is easy to reason about. */
function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...parseEnv({ DATABASE_URL: DSN, DB_POOL_MAX: '3' }), ...overrides };
}

/**
 * Probes the server once, before the suite decides whether to run.
 *
 * @returns `true` when a server answered `select 1`.
 */
async function serverAvailable(): Promise<boolean> {
  const handle = createDatabase(testConfig());
  try {
    await handle.check(2_000);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

const available = await serverAvailable();

describe.skipIf(!available)('the db stage against a real server', () => {
  let handle: SqlDatabase | undefined;

  beforeAll(() => {
    handle = createDatabase(testConfig());
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('finds a server, which is what makes the rest of this file meaningful', async () => {
    await expect(handle?.check()).resolves.toBeUndefined();
  });

  it('round-trips a query through Kysely', async () => {
    const result = await sql<{ sum: number }>`select 2 + 3 as sum`.execute(handle!.db);
    expect(result.rows[0]?.sum).toBe(5);
  });

  it('enforces a constraint, i.e. it is really Postgres and not an emulation', async () => {
    // A scratch table, dropped afterwards: the phase-1 schema belongs to `P1-DB-01`, not to this test.
    await sql`drop table if exists p1_api_06_probe`.execute(handle!.db);
    await sql`create table p1_api_06_probe (id integer primary key)`.execute(handle!.db);
    try {
      await sql`insert into p1_api_06_probe (id) values (1)`.execute(handle!.db);
      await expect(
        sql`insert into p1_api_06_probe (id) values (1)`.execute(handle!.db),
      ).rejects.toMatchObject({
        code: '23505',
      });
    } finally {
      await sql`drop table if exists p1_api_06_probe`.execute(handle!.db);
    }
  });

  it('rolls a transaction back, so a service can compose writes safely', async () => {
    await sql`drop table if exists p1_api_06_tx`.execute(handle!.db);
    await sql`create table p1_api_06_tx (id integer primary key)`.execute(handle!.db);
    try {
      await expect(
        handle!.db.transaction().execute(async (trx) => {
          await sql`insert into p1_api_06_tx (id) values (10)`.execute(trx);
          throw new Error('rollback on purpose');
        }),
      ).rejects.toThrow('rollback on purpose');

      const after = await sql<{ n: number }>`select count(*)::int as n from p1_api_06_tx`.execute(
        handle!.db,
      );
      expect(after.rows[0]?.n).toBe(0);
    } finally {
      await sql`drop table if exists p1_api_06_tx`.execute(handle!.db);
    }
  });

  it('boots the whole pipeline, with the database it was handed', async () => {
    const instance = await buildApp({
      config: testConfig(),
      database: createDatabase(testConfig()),
    });
    try {
      expect(instance.db).toBeDefined();
      const response = await instance.inject({ method: 'GET', url: '/_public/api/countries' });
      expect(response.statusCode).toBe(503);
    } finally {
      await instance.close();
    }
  });

  it('survives a connection the server kills underneath it', async () => {
    // Postgres drops idle connections for ordinary reasons: an administrator ends the session, the server restarts,
    // a failover moves the primary. The driver reports that as an `error` event on the pool, and a Node `EventEmitter`
    // that emits `error` with no listener throws — so without the stage's listener, one database restart would take
    // the API process down instead of costing a single query.
    const backend = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(handle!.db);
    const victim = backend.rows[0]!.pid;

    const killer = createDatabase(testConfig());
    try {
      await sql`select pg_terminate_backend(${victim})`.execute(killer.db);
    } finally {
      await killer.close();
    }

    // Let the driver notice the dead socket; the assertion that matters is that this line is reached at all.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(handle!.check()).resolves.toBeUndefined();
  });
});

describe('the db stage when the server is not there', () => {
  it('refuses to boot, because a server that starts and 500s is worse than one that does not start', async () => {
    // Port 1 is closed by definition; the pool therefore cannot connect and the `onReady` ping fails.
    const unreachable = parseEnv({ DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });

    await expect(
      buildApp({ config: unreachable, database: createDatabase(unreachable) }),
    ).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
  }, 20_000);

  it('reports DB_UNAVAILABLE rather than the driver’s own text', async () => {
    // The message is what a client would see if this ever escaped to a response: it must name no DSN (L9).
    const unreachable = parseEnv({ DATABASE_URL: 'postgres://user:hunter2@127.0.0.1:1/none' });
    const handle = createDatabase(unreachable);

    await expect(checkDatabase(handle)).rejects.toMatchObject({
      code: 'DB_UNAVAILABLE',
      message: 'The database is not reachable.',
    });
    await handle.close();
  }, 20_000);

  it('bounds the wait, so an unreachable host cannot hang the boot', async () => {
    // 10.255.255.1 is non-routable: the TCP connect hangs rather than being refused, which is the case a timeout
    // exists for. The probe must give up on its own rather than wait for the shutdown timer.
    const hanging = parseEnv({ DATABASE_URL: 'postgres://u:p@10.255.255.1:5432/none' });
    const handle = createDatabase(hanging);
    const started = Date.now();

    await expect(handle.check(300)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(5_000);
    await handle.close();
  }, 20_000);
});
