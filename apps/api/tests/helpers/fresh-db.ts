/**
 * A throwaway database per test (integration helper).
 *
 * Several suites assert something about a database in a known state — "a fresh database, migrate, then the
 * documented tables exist" (`P1-DB-01`), "the Kysely types match the columns that actually exist" (`P1-DB-02`).
 * A shared `mapirror_test` cannot answer either: it is whatever the last run left behind, and two suites running
 * in parallel would contend for it.
 *
 * So each call creates a real database on the same server, hands it over, and drops it afterwards. `CREATE
 * DATABASE` needs a role with `CREATEDB`; where the role has it the suite runs, and where it does not the suite
 * **skips with the reason** instead of failing on something the developer did not do wrong.
 *
 * @module tests/helpers/fresh-db
 */

import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { createDatabase, parseEnv, type SqlDatabase } from '../../src/index';

/** DSN of the test server, as documented in `09-development.md` §5. */
export const TEST_DSN =
  process.env.DATABASE_URL_TEST ?? 'postgres://mapirror:mapirror@localhost:5432/mapirror_test';

/**
 * Rewrites a DSN to point at another database on the same server.
 *
 * @param database - Target database name.
 * @param dsn - Source DSN; defaults to {@link TEST_DSN}.
 * @returns A DSN with the same host, port, role and password.
 */
export function dsnFor(database: string, dsn: string = TEST_DSN): string {
  const url = new URL(dsn);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Thrown when this environment cannot host a suite; the caller reports it as a skip with the message. */
export class SkipError extends Error {}

/** Names created and not yet dropped, so a crashed test still leaves the server clean. */
const created = new Set<string>();

/**
 * Creates an empty database and hands it over, dropping it afterwards whatever happens.
 *
 * @param run - Receives a handle to the fresh database and its name.
 * @param options - `prefix` names the database for easier debugging; `migrate` runs `0001_init` first.
 * @throws {SkipError} When the "postgres" database is unreachable or the role may not create databases.
 */
export async function withFreshDatabase(
  run: (database: SqlDatabase, name: string) => Promise<void>,
  options: { prefix?: string; migrate?: boolean } = {},
): Promise<void> {
  const name = `mapirror_${options.prefix ?? 'tmp'}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: dsnFor('postgres') });

  try {
    await admin.connect();
  } catch {
    await admin.end().catch(() => undefined);
    throw new SkipError('cannot reach the "postgres" database to create a scratch database');
  }

  try {
    await admin.query(`create database ${name}`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    const code = (error as { code?: string }).code;
    if (code === '42501' || code === '3D000') {
      throw new SkipError(`the test role may not create databases (${code})`);
    }
    throw error;
  }
  created.add(name);

  const database = createDatabase(parseEnv({ DATABASE_URL: dsnFor(name) }));
  try {
    if (options.migrate === true) {
      // Imported lazily so a unit test that merely loads this module does not pull in the migrator.
      const { migrateToLatest } = await import('../../src/db/migrator');
      await migrateToLatest(database.db);
    }
    await run(database, name);
  } finally {
    await database.close();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
    created.delete(name);
  }
}

/**
 * Drops a scratch database by name.
 *
 * Exported for the teardown of a suite that threw outside {@link withFreshDatabase}'s control.
 *
 * @param name - Database to drop; missing databases are ignored.
 */
export async function dropDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: dsnFor('postgres') });
  try {
    await admin.connect();
    await admin.query(`drop database if exists ${name} with (force)`);
    created.delete(name);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/**
 * Asks the server once whether a scratch database can be created.
 *
 * @returns `null` when the suite can run, or the reason it must be skipped.
 */
export async function freshDatabaseSkipReason(): Promise<string | null> {
  try {
    await withFreshDatabase(() => Promise.resolve(), { prefix: 'probe' });
    return null;
  } catch (error) {
    return error instanceof SkipError ? error.message : (error as Error).message;
  }
}
