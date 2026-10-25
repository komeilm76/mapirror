/**
 * Builds an app for tests that do not care about the database.
 *
 * Once the `db` stage exists, building the **full** pipeline means opening a pool and proving it can answer — so
 * every routing, header or logging test would need a Postgres server. That trade is wrong twice over: the fast
 * gate must stay fast (`09-development.md` §6), and a test that asserts a `503` stub does not learn anything from
 * a live connection.
 *
 * So the handle is a stub here, and the tests that *do* care — the boot check, the pool close, a query round
 * trip, a rollback — live in `tests/integration/db.spec.ts` against a real server. The stub is deliberately
 * hostile to being used: querying it throws a message naming this file, so an app test that accidentally depends
 * on SQL fails loudly instead of silently passing on a fake.
 *
 * @module tests/helpers/test-app
 */

import type { Kysely } from 'kysely';

import { buildApp, type BuildAppOptions, type Database, type SqlDatabase } from '../../src/index';

/** What a query does on the stub: fail, and say where to go instead. */
const STUB_MESSAGE =
  'the database in this test is a stub — use tests/integration/db.spec.ts for behaviour that needs SQL';

/**
 * A database handle that answers its liveness check and refuses to be queried.
 *
 * `check` resolves, because the `db` stage pings at boot and these tests are about routing, headers or logging —
 * not about whether Postgres is up. `close` resolves too: every test app is closed in a `finally`, and a stub
 * that threw there would mask the assertion that actually failed.
 *
 * @returns A handle whose `db` throws at the property level, i.e. on any query builder call.
 */
export function stubDatabase(): SqlDatabase {
  const db = new Proxy({} as Kysely<Database>, {
    get() {
      throw new Error(STUB_MESSAGE);
    },
  });
  return { db, close: () => Promise.resolve(), check: () => Promise.resolve() };
}

/**
 * `buildApp` with the stub database filled in.
 *
 * @param options - Anything `buildApp` takes; `database` is replaced unless given.
 * @returns The booted instance.
 */
export function buildTestApp(options: BuildAppOptions = {}) {
  return buildApp({ ...options, database: options.database ?? stubDatabase() });
}
