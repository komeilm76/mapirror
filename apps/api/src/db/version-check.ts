/**
 * Applies pending migrations at boot and refuses to serve a schema that does not match the code
 * (task `P1-DB-04`).
 *
 * Three things can disagree, and each has a different cause and a different answer:
 *
 * | Disagreement | What it means | What happens |
 * |---|---|---|
 * | files on disk ≠ {@link EXPECTED_MIGRATIONS} | The image shipped without its `.sql` files, or a migration was added without updating the constant | Boot fails, naming the difference |
 * | database behind the files | A deploy that skipped its migration step | Migrated when `MIGRATE_ON_BOOT`, otherwise boot fails |
 * | database ahead of the files | An older image is running against a newer schema — a rollback | Boot fails |
 *
 * The last one is the one people forget. Migrations are forward-only (`03-data-model.md` §4), so a rolled-back
 * image is not merely "not migrated": the schema it expects may have lost a column it selects, and the failure
 * arrives as a `500` on some request hours later instead of a refusal at boot. Refusing is the same rule the `db`
 * stage already follows — a server that starts and then fails every request is worse than one that does not start,
 * because a supervisor and a load balancer both believe it is healthy.
 *
 * The constant exists for a reason a database cannot detect: if the `.sql` files are missing from the image (a
 * `.dockerignore` rule, a copy step that forgot them), the file list is *empty* and looks perfectly consistent with
 * an empty database — so the count is compared against a constant baked into the code, not merely against itself.
 *
 * @module db/version-check
 */

import { sql } from 'kysely';

import type { SqlDatabase } from './client';
import { listMigrationFiles, migrateToLatest, MIGRATIONS_DIR } from './migrator';

/**
 * The migrations this build expects to ship.
 *
 * Must be updated in the same commit as a new `.sql` file — `tests/version-check.spec.ts` asserts exactly that
 * against the files on disk, so the rule is enforced rather than remembered.
 */
export const EXPECTED_MIGRATIONS: readonly string[] = [
  '0001_init',
  '0002_catalog',
  '0003_download_events',
  '0004_upload_sessions',
  '0005_intervals',
];

/** Startup code for a schema that does not match the code (`INTERNAL_ERROR_CODES`). */
export const SCHEMA_SKEW_CODE = 'SCHEMA_SKEW';

/** How the three sources compared. */
export interface SchemaVersionReport {
  /** Migrations the code believes it ships ({@link EXPECTED_MIGRATIONS}). */
  readonly expected: readonly string[];
  /** Migration files actually found on disk. */
  readonly onDisk: readonly string[];
  /** Migrations the database records as applied. */
  readonly applied: readonly string[];
  /** On disk (and expected), not applied — the database is behind. */
  readonly pending: readonly string[];
  /** Applied, but unknown to this build — the database is ahead. */
  readonly unknown: readonly string[];
  /** A migration file that is not in {@link EXPECTED_MIGRATIONS}, or a missing one. */
  readonly missingFromDisk: readonly string[];
  readonly unexpectedOnDisk: readonly string[];
}

/** Thrown when the boot must not continue; carries the report so the log can show all of it. */
export class SchemaSkewError extends Error {
  /** Startup code, mirroring `INTERNAL_ERROR_CODES`. */
  readonly code = SCHEMA_SKEW_CODE;

  /** @param message - One sentence an operator can act on. @param report - The full comparison. */
  constructor(
    message: string,
    readonly report: SchemaVersionReport,
  ) {
    super(message);
    this.name = 'SchemaSkewError';
  }
}

/**
 * Compares what the code ships with what is on disk and what the database has applied.
 *
 * Pure and exported: the interesting logic is arithmetic on three lists, and testing it does not need a server.
 *
 * @param input - The three lists.
 * @returns The report.
 */
export function compareSchema(input: {
  expected: readonly string[];
  onDisk: readonly string[];
  applied: readonly string[];
}): SchemaVersionReport {
  const { expected, onDisk, applied } = input;
  const disk = new Set(onDisk);
  const appliedSet = new Set(applied);

  return {
    expected,
    onDisk,
    applied,
    pending: onDisk.filter((name) => !appliedSet.has(name)),
    // Anything the database knows that this build does not ship: a newer schema, or a file deleted from an image
    // that once shipped it. Both are unsafe to serve.
    unknown: applied.filter((name) => !disk.has(name)),
    missingFromDisk: expected.filter((name) => !disk.has(name)),
    unexpectedOnDisk: onDisk.filter((name) => !expected.includes(name)),
  };
}

/**
 * Reads the applied migrations from Kysely's bookkeeping table.
 *
 * The table does not exist until the first migration runs, which is not an error: it means "nothing applied yet".
 * Checking `to_regclass` first keeps that case out of the exception path, where it would need a try/catch around a
 * perfectly normal situation.
 *
 * @param database - Handle to the database.
 * @returns Applied migration names, in the order Kysely recorded them.
 */
export async function appliedMigrations(database: SqlDatabase): Promise<string[]> {
  const exists = await sql<{ present: string | null }>`
    select to_regclass('public.kysely_migration')::text as present
  `.execute(database.db);
  if (exists.rows[0]?.present === null || exists.rows[0] === undefined) return [];

  const rows = await sql<{ name: string }>`
    select name from kysely_migration order by name
  `.execute(database.db);
  return rows.rows.map((row) => row.name);
}

/**
 * The shape the `db` stage calls at boot.
 *
 * Declared here rather than in the stage so `PipelineContext` can name it without importing the stage.
 */
export type SchemaCheck = (
  database: SqlDatabase,
  config: { readonly migrateOnBoot: boolean },
) => Promise<SchemaVersionReport & { migrated: readonly string[] }>;

/**
 * Runs the whole boot sequence for the schema: optional migration, then the version check.
 *
 * @param database - Handle to the database, already proven reachable.
 * @param options - `migrateOnBoot` from the configuration; `dir` and `expected` exist for tests.
 * @returns The report, which the caller logs.
 * @throws {SchemaSkewError} When the schema cannot be brought in line with the code.
 */
export async function checkSchemaVersion(
  database: SqlDatabase,
  options: {
    migrateOnBoot: boolean;
    dir?: string;
    expected?: readonly string[];
  },
): Promise<SchemaVersionReport & { migrated: readonly string[] }> {
  const expected = options.expected ?? EXPECTED_MIGRATIONS;
  const onDisk = (await listMigrationFiles(options.dir ?? MIGRATIONS_DIR)).map((file) => file.name);

  const before = compareSchema({ expected, onDisk, applied: await appliedMigrations(database) });

  // Checked before migrating: if the image is missing files, migrating would apply the *wrong* subset and record it
  // as done. The constant is the only way to notice, because an empty database and an empty directory agree.
  if (before.missingFromDisk.length > 0 || before.unexpectedOnDisk.length > 0) {
    throw new SchemaSkewError(
      'the migrations on disk do not match what this build expects; the image is incomplete or the ' +
        'EXPECTED_MIGRATIONS constant is stale',
      before,
    );
  }

  // A database ahead of the code cannot be fixed by migrating — the migrations that would undo it do not exist
  // (forward-only). Refused here rather than after a pointless migration attempt.
  if (before.unknown.length > 0) {
    throw new SchemaSkewError(
      'the database contains migrations this build does not ship; it was migrated by a newer version',
      before,
    );
  }

  if (before.pending.length === 0) return { ...before, migrated: [] };

  if (!options.migrateOnBoot) {
    throw new SchemaSkewError(
      `the database is ${before.pending.length} migration(s) behind and MIGRATE_ON_BOOT is false`,
      before,
    );
  }

  const { applied } = await migrateToLatest(database.db, options.dir ?? MIGRATIONS_DIR);
  // The report is built from what is now known rather than by re-reading the bookkeeping: `migrateToLatest` throws
  // on any failure and only returns the migrations it actually recorded, so reaching this line means every file on
  // disk is applied. A second query whose result could only ever be "no pending migrations" is a branch nothing can
  // take — and this repository removes those instead of leaving an untestable line behind (`16-changelog.md` pass 14).
  return {
    ...before,
    applied: [...before.applied, ...applied].sort(),
    pending: [],
    migrated: applied,
  };
}
