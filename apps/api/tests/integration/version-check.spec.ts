import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  appliedMigrations,
  checkSchemaVersion,
  EXPECTED_MIGRATIONS,
  SchemaSkewError,
} from '../../src/index';
import { migrateToLatest } from '../../src/db/migrator';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * Acceptance test for `P1-DB-04` against real databases: **skew is detected at startup**, in both directions, and
 * a database that is merely behind is brought up to date when this process owns migration.
 *
 * Each case needs a database in a different state — empty, migrated, migrated-by-something-newer, migrated with a
 * file this build does not ship — so each test creates its own (`tests/helpers/fresh-db.ts`).
 */

const skipReason = await freshDatabaseSkipReason();

/** A migrations directory containing exactly the given names, for tests that need an unusual file set. */
async function tempMigrations(names: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mapirror-vc-'));
  for (const name of names) {
    await writeFile(
      join(dir, `${name}.sql`),
      // The files have to be valid SQL: in the "behind" cases they are actually applied.
      'CREATE TABLE IF NOT EXISTS version_probe (id int primary key);',
    );
  }
  return dir;
}

describe.skipIf(skipReason !== null)('checkSchemaVersion', () => {
  it('migrates an empty database when this process owns migration', async () => {
    await withFreshDatabase(
      async (database) => {
        const report = await checkSchemaVersion(database, { migrateOnBoot: true });

        expect(report.migrated).toEqual(EXPECTED_MIGRATIONS);
        // The report describes the database it leaves behind, not the one it found: `applied` includes the
        // migrations this run recorded, which is what makes the post-boot log useful.
        expect(report.applied).toEqual(EXPECTED_MIGRATIONS);
        expect(report.pending).toEqual([]);
        expect(report.unknown).toEqual([]);
        // And it really applied them, rather than only reporting so.
        expect(await appliedMigrations(database)).toEqual(EXPECTED_MIGRATIONS);
      },
      { prefix: 'vc' },
    );
  });

  it('is a no-op on a database that already matches', async () => {
    await withFreshDatabase(
      async (database) => {
        const before = await appliedMigrations(database);

        const report = await checkSchemaVersion(database, { migrateOnBoot: true });

        expect(report.migrated).toEqual([]);
        expect(report.pending).toEqual([]);
        expect(await appliedMigrations(database)).toEqual(before);
      },
      { prefix: 'vc', migrate: true },
    );
  });

  it('refuses a database that is behind when MIGRATE_ON_BOOT is false', async () => {
    // The compose entrypoint owns migration (`P1-DOCK-04`), so the API must *not* quietly migrate behind its back —
    // but it must also not serve against a schema it knows is incomplete.
    await withFreshDatabase(
      async (database) => {
        const error = await checkSchemaVersion(database, { migrateOnBoot: false }).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(SchemaSkewError);
        expect((error as SchemaSkewError).report.pending).toEqual(EXPECTED_MIGRATIONS);
        // Nothing was applied: refusing happened before any migration attempt.
        expect(await appliedMigrations(database)).toEqual([]);
      },
      { prefix: 'vc' },
    );
  });

  it('refuses a database migrated by a newer build, and does not try to migrate it', async () => {
    await withFreshDatabase(
      async (database) => {
        // Exactly what a rollback looks like: the bookkeeping names a migration this build has no file for.
        await sql`insert into kysely_migration (name, timestamp) values ('0009_from_the_future', now())`.execute(
          database.db,
        );

        const error = await checkSchemaVersion(database, { migrateOnBoot: true }).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(SchemaSkewError);
        expect((error as SchemaSkewError).report.unknown).toEqual(['0009_from_the_future']);
        expect(error instanceof SchemaSkewError ? error.message : '').toMatch(/newer version/);
      },
      { prefix: 'vc', migrate: true },
    );
  });

  it('refuses when the migrations on disk are not the ones this build expects', async () => {
    // The image-without-its-SQL case: an empty directory against an empty database looks consistent, so only the
    // constant catches it.
    const dir = await tempMigrations([]);
    try {
      await withFreshDatabase(
        async (database) => {
          const error = await checkSchemaVersion(database, { migrateOnBoot: true, dir }).catch(
            (caught: unknown) => caught,
          );

          expect(error).toBeInstanceOf(SchemaSkewError);
          expect((error as SchemaSkewError).report.missingFromDisk).toEqual(EXPECTED_MIGRATIONS);
        },
        { prefix: 'vc' },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a migration file that the constant does not know about', async () => {
    // A file added without updating EXPECTED_MIGRATIONS. Applying it would record a name the *next* build also
    // rejects, so the boot stops with the inconsistency rather than baking it into the database.
    const dir = await tempMigrations([...EXPECTED_MIGRATIONS, '0004_unannounced']);
    try {
      await withFreshDatabase(
        async (database) => {
          const error = await checkSchemaVersion(database, { migrateOnBoot: true, dir }).catch(
            (caught: unknown) => caught,
          );

          expect(error).toBeInstanceOf(SchemaSkewError);
          expect((error as SchemaSkewError).report.unexpectedOnDisk).toEqual(['0004_unannounced']);
          expect(await appliedMigrations(database)).toEqual([]);
        },
        { prefix: 'vc' },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies the pending subset and reports it, when the extra migration is expected', async () => {
    // The happy path for a second migration: one applied, one pending, both shipped by this build.
    const dir = await tempMigrations(['0001_init', '0002_catalog']);
    const appliedDir = await tempMigrations(['0001_init']);
    try {
      await withFreshDatabase(
        async (database) => {
          await migrateToLatest(database.db, appliedDir);
          const report = await checkSchemaVersion(database, {
            migrateOnBoot: true,
            dir,
            expected: ['0001_init', '0002_catalog'],
          });

          expect(report.migrated).toEqual(['0002_catalog']);
          expect(report.applied).toEqual(['0001_init', '0002_catalog']);
          expect(report.pending).toEqual([]);
          expect(await appliedMigrations(database)).toEqual(['0001_init', '0002_catalog']);
        },
        { prefix: 'vc' },
      );
    } finally {
      await Promise.all([
        rm(dir, { recursive: true, force: true }),
        rm(appliedDir, { recursive: true, force: true }),
      ]);
    }
  });
});
