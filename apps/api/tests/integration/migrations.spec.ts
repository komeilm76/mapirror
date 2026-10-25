import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  MIGRATIONS_DIR,
  SqlMigrationProvider,
  migrateToLatest,
  resetDatabase,
} from '../../src/db/migrator';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';
import { Migrator } from 'kysely/migration';

/**
 * Acceptance test for `P1-DB-01` against a real Postgres: **a fresh database, migrate, and the documented tables
 * and indexes exist**.
 *
 * Each test creates its own database rather than working inside `mapirror_test`, because "fresh" is the claim
 * being tested and a shared database is never fresh. That also keeps this suite from interfering with the other
 * integration tests when Vitest runs files in parallel. `CREATE DATABASE` needs a role with `CREATEDB`; where the
 * test role has it, the suite runs, and where it does not, it says so instead of failing.
 */

/** Asks the server once whether a scratch database can be created; the answer becomes the skip decision. */
const canCreate = await freshDatabaseSkipReason();

describe.skipIf(canCreate !== null)('migrations on a fresh database', () => {
  it('creates every documented phase-1 table and index', async () => {
    await withFreshDatabase(async (database) => {
      const outcome = await migrateToLatest(database.db);
      expect(outcome.applied).toEqual(['0001_init']);

      const tables = await sql<{ table_name: string }>`
        select table_name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'
      `.execute(database.db);
      const names = tables.rows.map((row) => row.table_name);

      for (const table of ['admins', 'admin_tokens', 'settings', 'audit_logs']) {
        expect(names, table).toContain(table);
      }

      const indexes = await sql<{ indexname: string }>`
        select indexname from pg_indexes where schemaname = 'public'
      `.execute(database.db);
      const indexNames = indexes.rows.map((row) => row.indexname);
      for (const index of [
        'admins_username_key',
        'admin_tokens_hash_key',
        'admin_tokens_admin_idx',
        'audit_logs_created_idx',
        'audit_logs_action_idx',
      ]) {
        expect(indexNames, index).toContain(index);
      }

      // The extension the phase-2 trigram search index depends on.
      const extensions = await sql<{ extname: string }>`
        select extname from pg_extension where extname = 'pg_trgm'
      `.execute(database.db);
      expect(extensions.rows).toHaveLength(1);
    });
  });

  it('is a no-op the second time, because the bookkeeping is Kysely’s', async () => {
    await withFreshDatabase(async (database) => {
      await migrateToLatest(database.db);
      const second = await migrateToLatest(database.db);

      expect(second.applied).toEqual([]);
      // Re-running must not have dropped or recreated anything: the seeded row survives.
      await sql`insert into settings (key, value) values ('probe.key', '{"kept":true}'::jsonb)`.execute(
        database.db,
      );
      await migrateToLatest(database.db);
      const settings = await sql<{ key: string }>`select key from settings`.execute(database.db);
      expect(settings.rows.map((row) => row.key)).toEqual(['probe.key']);
    });
  });

  it('refuses to roll back, because migrations are forward-only', async () => {
    await withFreshDatabase(async (database) => {
      await migrateToLatest(database.db);

      const migrator = new Migrator({
        db: database.db,
        provider: new SqlMigrationProvider(MIGRATIONS_DIR),
      });
      const { error, results } = await migrator.migrateDown();

      // `03-data-model.md` §4: a rollback in production is a restore, not a script. Measured rather than
      // assumed: Kysely does not throw — it reports the migration as `NotExecuted` and leaves the schema alone.
      // Pinned here because "fails quietly" is only acceptable while a test is asserting that it fails at all.
      expect(error).toBeUndefined();
      expect(results).toEqual([
        { migrationName: '0001_init', direction: 'Down', status: 'NotExecuted' },
      ]);
      const tables = await sql<{ n: number }>`
        select count(*)::int as n from information_schema.tables
         where table_schema = 'public' and table_name = 'admins'
      `.execute(database.db);
      expect(tables.rows[0]?.n).toBe(1);
    });
  });

  it('enforces the invariants the schema promises, not just the column types', async () => {
    await withFreshDatabase(async (database) => {
      await migrateToLatest(database.db);
      const db = database.db;

      await sql`insert into admins (username, password_hash) values ('admin', 'argon2id$probe')`.execute(
        db,
      );
      // Case-insensitive uniqueness (`03-data-model.md` §2.1).
      await expect(
        sql`insert into admins (username, password_hash) values ('Admin', 'argon2id$other')`.execute(
          db,
        ),
      ).rejects.toMatchObject({ code: '23505' });

      const admin = await sql<{ id: string }>`select id from admins`.execute(db);
      const adminId = admin.rows[0]!.id;

      // A token hash that is not 32 bytes can never match a presented token: a check, not a comment.
      await expect(
        sql`insert into admin_tokens (admin_id, token_hash, token_prefix, expires_at)
            values (${adminId}::uuid, ${Buffer.from('short')}, 'mm_short', now() + interval '1 day')`.execute(
          db,
        ),
      ).rejects.toMatchObject({ code: '23514' });

      await sql`insert into admin_tokens (admin_id, token_hash, token_prefix, expires_at)
                values (${adminId}::uuid, ${Buffer.alloc(32, 7)}, 'mm_ok', now() + interval '1 day')`.execute(
        db,
      );

      // Audit rows keep the actor's name after the account is gone (§2.11).
      await sql`insert into audit_logs (actor_id, actor_name, action) values (${adminId}::uuid, 'admin', 'auth.login')`.execute(
        db,
      );

      // Deleting the admin cascades to tokens and nulls the audit actor, which is two FKs behaving differently
      // in the same statement.
      await sql`delete from admins where id = ${adminId}::uuid`.execute(db);
      const tokens = await sql<{ n: number }>`select count(*)::int as n from admin_tokens`.execute(
        db,
      );
      expect(tokens.rows[0]?.n).toBe(0);
      const audit = await sql<{ actor_id: string | null; actor_name: string }>`
        select actor_id, actor_name from audit_logs
      `.execute(db);
      expect(audit.rows).toEqual([{ actor_id: null, actor_name: 'admin' }]);
    });
  });

  it('a migration that fails is not recorded as applied, so a fixed rerun retries it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mapirror-bad-migration-'));
    try {
      await writeFile(join(dir, '0001_broken.sql'), 'CREATE TABLE admins (this is not SQL);');
      await writeFile(
        join(dir, '0002_never_reached.sql'),
        'CREATE TABLE after_the_failure (id int);',
      );

      await withFreshDatabase(async (database) => {
        await expect(migrateToLatest(database.db, dir)).rejects.toThrow();

        // Nothing is recorded, so fixing the file and running again applies it — this is what an operator does
        // at 2 a.m., and it only works if the failure was not written into the bookkeeping.
        const recorded = await sql<{ name: string }>`select name from kysely_migration`.execute(
          database.db,
        );
        expect(recorded.rows).toEqual([]);
        const tables = await sql<{ table_name: string }>`
          select table_name from information_schema.tables
           where table_schema = 'public' and table_name = 'after_the_failure'
        `.execute(database.db);
        expect(tables.rows).toEqual([]);

        // And the real migrations still apply cleanly afterwards.
        const outcome = await migrateToLatest(database.db);
        expect(outcome.applied).toEqual(['0001_init']);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports nothing applied when the directory is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mapirror-empty-migrations-'));
    try {
      await withFreshDatabase(async (database) => {
        await expect(migrateToLatest(database.db, dir)).resolves.toEqual({ applied: [] });
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reset drops the schema and its data, then migrates again', async () => {
    await withFreshDatabase(async (database) => {
      await migrateToLatest(database.db);
      await sql`insert into settings (key, value) values ('probe.reset', '{}'::jsonb)`.execute(
        database.db,
      );

      await resetDatabase(database.db);
      // Reset must also clear Kysely's bookkeeping, or the next migration run would believe the schema exists.
      const outcome = await migrateToLatest(database.db);

      expect(outcome.applied).toEqual(['0001_init']);
      const settings = await sql<{ n: number }>`select count(*)::int as n from settings`.execute(
        database.db,
      );
      expect(settings.rows[0]?.n).toBe(0);
    });
  });
});
