/**
 * SQL migrations, applied by Kysely's migrator (task `P1-DB-01`).
 *
 * The migrations themselves are plain `.sql` files in `db/migrations/`, named `NNNN_name.sql`. That is a
 * deliberate choice over writing `.ts` migration modules: the files are reviewable by someone who knows SQL and
 * not TypeScript, they are the same bytes a `psql` session would run, and `bun run db:migrate` and a test can
 * both apply exactly what a production deployment applies.
 *
 * Kysely still drives them, so bookkeeping (`kysely_migration`, `kysely_migration_lock`), ordering and the
 * "apply each migration in one transaction" guarantee come from a library instead of from hand-rolled code.
 *
 * **Forward-only.** A migration declares no `down`: rolling back a schema change in production is a restore,
 * not a script (`03-data-model.md` §4). Measured, because the intuition is wrong: `migrateDown()` does **not**
 * throw for such a migration — it reports `{ status: 'NotExecuted' }` and changes nothing, so a rollback attempt
 * fails quietly rather than loudly. `tests/integration/migrations.spec.ts` pins that behaviour, because
 * "quietly" is only acceptable while somebody is asserting it.
 *
 * @module db/migrator
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { sql, type Kysely } from 'kysely';
// Kysely 0.29 moved the migration API to a subpath; importing `Migrator` from `kysely` yields a type that
// exists only to say "import from 'kysely/migration' instead" (`KyselyTypeError`).
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

/** Where the SQL files live. Resolved from this module, so the caller's working directory cannot matter. */
export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

/** `NNNN_name.sql`, lower-case and underscore-separated. */
const MIGRATION_FILE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** One migration file on disk. */
export interface MigrationFile {
  /** Kysely's name for it: the file name without `.sql`, e.g. `0001_init`. */
  readonly name: string;
  /** Absolute path. */
  readonly path: string;
}

/**
 * Lists the migration files in apply order.
 *
 * Throws rather than skipping anything unexpected: a file named `init.sql`, `1_init.sql` or `0001_init.SQL`
 * would otherwise be silently ignored, and the schema would be missing tables nobody notices until a query
 * fails. Duplicate sequence numbers are rejected for the same reason — their order would be decided by
 * alphabetical accident.
 *
 * @param dir - Directory to read; defaults to {@link MIGRATIONS_DIR}.
 * @returns Files sorted by name, which zero-padding makes the numeric order.
 * @throws When a `.sql` file does not follow the naming rule, or two files share a sequence number.
 */
export async function listMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.sql')) continue;
    const match = MIGRATION_FILE.exec(entry.name);
    if (match === null) {
      throw new Error(
        `${entry.name} is not a migration: expected NNNN_name.sql (e.g. 0002_catalog.sql) in ${dir}`,
      );
    }
    const sequence = match[1] as string;
    const clash = seen.get(sequence);
    if (clash !== undefined) {
      throw new Error(
        `Migration sequence ${sequence} is used twice (${clash} and ${entry.name}); order would be arbitrary`,
      );
    }
    seen.set(sequence, entry.name);
    files.push({ name: entry.name.slice(0, -'.sql'.length), path: join(dir, entry.name) });
  }

  return files.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * A Kysely {@link MigrationProvider} over a directory of `.sql` files.
 *
 * Each file is executed as **one** raw statement batch, inside the transaction Kysely opens for the migration:
 * `pg` sends it through the simple query protocol, so `CREATE TABLE …; CREATE INDEX …;` and `DO $$ … $$` blocks
 * work as written. Splitting on semicolons here would break on exactly those blocks.
 */
export class SqlMigrationProvider implements MigrationProvider {
  /** @param dir - Directory of `.sql` files; defaults to {@link MIGRATIONS_DIR}. */
  constructor(private readonly dir: string = MIGRATIONS_DIR) {}

  /**
   * Reads every migration into Kysely's shape.
   *
   * @returns Migration name → `{ up }`. No `down`, by design (forward-only).
   */
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = await listMigrationFiles(this.dir);
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const script = await readFile(file.path, 'utf8');
      migrations[file.name] = {
        up: async (db: Kysely<unknown>): Promise<void> => {
          await sql.raw(script).execute(db);
        },
      };
    }
    return migrations;
  }
}

/** What {@link migrateToLatest} did. */
export interface MigrationOutcome {
  /** Migration names applied by this call, in order. Empty when the schema was already up to date. */
  readonly applied: readonly string[];
}

/**
 * Normalizes whatever Kysely reports as a migration failure into a real `Error`.
 *
 * Kysely types it as `unknown`, and a driver is free to throw a string or a plain object. Passing that on keeps
 * the failure's identity but loses the stack, and a caller catching `Error` — every caller — would miss it.
 *
 * @param error - The value Kysely reported.
 * @returns The same error when it already is one, wrapped otherwise, with the original as `cause`.
 */
export function asMigrationError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(`migration failed: ${inspect(error)}`, { cause: error });
}

/**
 * Applies every pending migration.
 *
 * @param db - Kysely instance over the target database.
 * @param dir - Migrations directory; defaults to {@link MIGRATIONS_DIR}.
 * @returns Which migrations ran and which were already in place.
 * @throws When a migration fails. The error is Kysely's own, with the failing file named.
 */
export async function migrateToLatest<DB>(
  db: Kysely<DB>,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationOutcome> {
  const migrator = new Migrator({ db, provider: new SqlMigrationProvider(dir) });
  const { error, results } = await migrator.migrateToLatest();
  if (error !== undefined) throw asMigrationError(error);

  // Only `Success` rows describe this call. Kysely reports `NotExecuted` for migrations it skipped after an
  // earlier failure — and that case has already thrown — so an "already applied" list built from the results
  // would always be empty, which is a field that lies by omission rather than a fact.
  return {
    applied: (results ?? [])
      .filter((result) => result.status === 'Success')
      .map((result) => result.migrationName),
  };
}

/**
 * Drops and recreates the `public` schema.
 *
 * Destructive, and deliberately named so: only `bun run db:reset` calls it, and that script refuses to run with
 * `NODE_ENV=production` (`09-development.md` §4). Dropping the schema also drops Kysely's bookkeeping table, so
 * the reset really is a fresh database and not a schema with a memory of one.
 *
 * @param db - Kysely instance over the database to reset.
 */
export async function resetDatabase<DB>(db: Kysely<DB>): Promise<void> {
  await sql`drop schema public cascade`.execute(db);
  await sql`create schema public`.execute(db);
}
