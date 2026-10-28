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

import type { AdminIdentity } from '../../src/db/repositories/admin-tokens';

import {
  buildApp,
  EXPECTED_MIGRATIONS,
  type BuildAppOptions,
  type Database,
  type SchemaCheck,
  type SqlDatabase,
} from '../../src/index';

/** What a query does on the stub: fail, and say where to go instead. */
const STUB_MESSAGE =
  'the database in this test is a stub — use tests/integration/db.spec.ts for behaviour that needs SQL';

/** A valid identity returned by tests that exercise the guard without a database-backed token verifier. */
export const TEST_ADMIN_IDENTITY: AdminIdentity = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'guard-test-admin',
  isActive: true,
};

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
 * A schema check that reports an in-sync schema without touching a database.
 *
 * The `db` stage verifies (and may migrate) the schema at boot, which needs a real server. The specs that use this
 * helper assert routing, headers, logging and the error envelope — none of which learn anything from a live
 * connection — so they state "the schema is fine" explicitly instead of satisfying it with a live database. The
 * real check is covered in `tests/version-check.spec.ts` and `tests/integration/version-check.spec.ts`.
 *
 * @returns The check, reporting the expected migrations as already applied.
 */
export function schemaInSync(): SchemaCheck {
  return () =>
    Promise.resolve({
      expected: EXPECTED_MIGRATIONS,
      onDisk: EXPECTED_MIGRATIONS,
      applied: EXPECTED_MIGRATIONS,
      pending: [],
      unknown: [],
      missingFromDisk: [],
      unexpectedOnDisk: [],
      migrated: [],
    });
}

/**
 * `buildApp` with the stub database and an in-sync schema filled in.
 *
 * @param options - Anything `buildApp` takes; `database` and `schemaCheck` are replaced unless given.
 * @returns The booted instance.
 */
export function buildTestApp(options: BuildAppOptions = {}) {
  return buildApp({
    schemaCheck: options.schemaCheck ?? schemaInSync(),
    ...options,
    database: options.database ?? stubDatabase(),
  });
}
