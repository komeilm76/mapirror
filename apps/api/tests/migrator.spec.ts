import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MIGRATIONS_DIR,
  SqlMigrationProvider,
  asMigrationError,
  listMigrationFiles,
} from '../src/db/migrator';

/**
 * Acceptance test for `P1-DB-01`, the half that needs no server: the migrator's rules about which files are
 * migrations, the order they run in, and — the part that keeps this repository honest — that the SQL agrees with
 * `03-data-model.md`.
 *
 * The live-database half (`tests/integration/migrations.spec.ts`) proves the objects really get created. Keeping
 * the doc-parity check here means a machine without Postgres still fails when the document and the migration
 * drift apart, which is the drift that actually happens: someone edits the doc, or adds a table to the SQL.
 */

const dirs: string[] = [];

/** A scratch directory that teardown removes. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mapirror-migrations-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('listMigrationFiles', () => {
  it('finds the real provisioned migrations, in order', async () => {
    const files = await listMigrationFiles();

    expect(files.map((file) => file.name)).toEqual([
      '0001_init',
      '0002_catalog',
      '0003_download_events',
      '0004_upload_sessions',
      '0005_intervals',
      '0006_interval_run_item_job_index',
      '0007_metrics_samples',
    ]);
    expect(files[0]?.path).toBe(join(MIGRATIONS_DIR, '0001_init.sql'));
    // The file has to exist, because the provider reads it by path.
    expect(await readFile(files[0]!.path, 'utf8')).toContain('CREATE TABLE admins');
  });

  it('orders 0002 before 0010, which is the whole reason for zero padding', async () => {
    const dir = await tempDir();
    for (const name of ['0010_ten.sql', '0002_two.sql', '0001_initial.sql']) {
      await writeFile(join(dir, name), 'select 1;');
    }

    expect((await listMigrationFiles(dir)).map((file) => file.name)).toEqual([
      '0001_initial',
      '0002_two',
      '0010_ten',
    ]);
  });

  it('ignores a directory that is named like a migration', async () => {
    // `readdir` returns directories too; trying to read one fails with a confusing EISDIR halfway through a run.
    const dir = await tempDir();
    await writeFile(join(dir, '0001_init.sql'), 'select 1;');
    await mkdir(join(dir, '0002_not_a_file.sql'));

    expect((await listMigrationFiles(dir)).map((file) => file.name)).toEqual(['0001_init']);
  });

  it('ignores files that are not SQL', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '0001_init.sql'), 'select 1;');
    await writeFile(join(dir, 'README.md'), 'notes');

    expect((await listMigrationFiles(dir)).map((file) => file.name)).toEqual(['0001_init']);
  });

  it.each([
    ['init.sql', 'no sequence number'],
    ['1_init.sql', 'sequence is not four digits'],
    ['0001-init.sql', 'hyphen instead of underscore'],
    ['0001_Init.sql', 'upper-case name'],
  ])('refuses %s (%s) instead of silently skipping it', async (name) => {
    const dir = await tempDir();
    await writeFile(join(dir, name), 'select 1;');

    // Skipping it would leave the schema missing tables and nothing would say so.
    await expect(listMigrationFiles(dir)).rejects.toThrow(
      /not a migration: expected NNNN_name\.sql/,
    );
  });

  it('refuses a file with the wrong extension case rather than treating it as data', async () => {
    // `.SQL` passes a case-insensitive "is this SQL" filter and then fails the naming rule: either answer is
    // fine, but it must not be silently ignored.
    const dir = await tempDir();
    await writeFile(join(dir, '0001_init.SQL'), 'select 1;');

    await expect(listMigrationFiles(dir)).rejects.toThrow(/not a migration/);
  });

  it('refuses two migrations with the same sequence number', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '0001_first.sql'), 'select 1;');
    await writeFile(join(dir, '0001_second.sql'), 'select 1;');

    // Their order would be decided by the alphabetical accident of the second word.
    await expect(listMigrationFiles(dir)).rejects.toThrow(/used twice/);
  });
});

describe('SqlMigrationProvider', () => {
  it('exposes each migration as an up-only migration', async () => {
    const migrations = await new SqlMigrationProvider().getMigrations();

    expect(Object.keys(migrations)).toEqual([
      '0001_init',
      '0002_catalog',
      '0003_download_events',
      '0004_upload_sessions',
      '0005_intervals',
      '0006_interval_run_item_job_index',
      '0007_metrics_samples',
    ]);
    const migration = migrations['0001_init']!;
    const catalogMigration = migrations['0002_catalog']!;
    const downloadEventsMigration = migrations['0003_download_events']!;
    const uploadSessionsMigration = migrations['0004_upload_sessions']!;
    const intervalsMigration = migrations['0005_intervals']!;
    const intervalItemJobIndexMigration = migrations['0006_interval_run_item_job_index']!;
    const metricsSamplesMigration = migrations['0007_metrics_samples']!;
    expect(typeof migration.up).toBe('function');
    expect(typeof catalogMigration.up).toBe('function');
    expect(typeof downloadEventsMigration.up).toBe('function');
    expect(typeof uploadSessionsMigration.up).toBe('function');
    expect(typeof intervalsMigration.up).toBe('function');
    expect(typeof intervalItemJobIndexMigration.up).toBe('function');
    expect(typeof metricsSamplesMigration.up).toBe('function');
    // Forward-only (`03-data-model.md` §4): rollback is a restore, not a script. Asserted as the *shape* of the
    // object, because a `down` that exists and does nothing is worse than one that is absent.
    expect(Object.keys(migration)).toEqual(['up']);
  });

  it('reads every file it reports, so a missing file fails here and not mid-migration', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '0001_init.sql'), 'select 1;');

    const provider = new SqlMigrationProvider(dir);
    const migrations = await provider.getMigrations();

    expect(Object.keys(migrations)).toEqual(['0001_init']);
  });
});

describe('asMigrationError', () => {
  it('passes a real Error through untouched, stack and all', () => {
    const original = new Error('syntax error at or near "CREAT"');

    expect(asMigrationError(original)).toBe(original);
  });

  it('wraps a value that is not an Error, keeping it as the cause', () => {
    // A driver is free to reject with anything; a caller that catches `Error` would otherwise miss it entirely.
    const wrapped = asMigrationError({ code: 'XX000', detail: 'boom' });

    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toContain('XX000');
    expect(wrapped.cause).toEqual({ code: 'XX000', detail: 'boom' });
  });
});

describe('the migration agrees with 03-data-model.md', () => {
  /** The document this repository treats as the schema's source of truth. */
  const DOC = resolve(import.meta.dirname, '../../../docs/03-data-model.md');

  /**
   * The document's phase-1 sections, joined.
   *
   * Sliced by heading rather than by searching the whole file: `03-data-model.md` also declares the phase-2
   * catalog tables and their indexes, and those belong to `0002_*` (`P2-DB-01`). Checking them against this
   * migration would demand tables it is not supposed to create.
   */
  async function phaseOneSections(): Promise<string> {
    const doc = await readFile(DOC, 'utf8');
    return ['### 2.1 ', '### 2.2 ', '### 2.11 ']
      .map((heading) => {
        const start = doc.indexOf(heading);
        expect(start, `${heading.trim()} must exist in 03-data-model.md`).toBeGreaterThan(-1);
        const end = doc.indexOf('\n### ', start + heading.length);
        return doc.slice(start, end === -1 ? undefined : end);
      })
      .join('\n');
  }

  it('creates every phase-1 table the document names', async () => {
    const tables = [...(await phaseOneSections()).matchAll(/CREATE TABLE (\w+)/g)].map(
      (match) => match[1] as string,
    );
    expect(tables.length).toBeGreaterThan(0);

    const sqlText = await readFile(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
    for (const table of tables) {
      expect(sqlText, `${table} is documented but not created`).toContain(`CREATE TABLE ${table} `);
    }
  });

  it('creates every phase-1 index the document names, with the same uniqueness', async () => {
    const indexes = [...(await phaseOneSections()).matchAll(/CREATE (UNIQUE )?INDEX (\w+)/g)].map(
      (match) => ({ name: match[2] as string, unique: match[1] !== undefined }),
    );
    expect(indexes.length).toBeGreaterThan(0);

    const sqlText = await readFile(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
    for (const index of indexes) {
      const declaration = index.unique
        ? `CREATE UNIQUE INDEX ${index.name} `
        : `CREATE INDEX ${index.name} `;
      // Uniqueness included on purpose: a generic index where the document promises `UNIQUE` would let a
      // duplicate row through while every "the index exists" check passed.
      expect(sqlText, `${index.name} is documented but not created`).toContain(declaration);
    }
  });

  it('creates the documented phase-2 tables and indexes in the catalog migration', async () => {
    const doc = await readFile(
      resolve(import.meta.dirname, '../../../docs/03-data-model.md'),
      'utf8',
    );
    const sections = ['### 2.3 ', '### 2.4 ', '### 2.5 ', '### 2.6 '].map((heading) => {
      const start = doc.indexOf(heading);
      expect(start, `${heading.trim()} must exist`).toBeGreaterThan(-1);
      const end = doc.indexOf('\n### ', start + heading.length);
      return doc.slice(start, end === -1 ? undefined : end);
    });
    const documented = sections.join('\n');
    const sqlText = await readFile(join(MIGRATIONS_DIR, '0002_catalog.sql'), 'utf8');
    const tables = [...documented.matchAll(/CREATE TABLE (\w+)/g)].map(
      (match) => match[1] as string,
    );
    const migrationTables = [...sqlText.matchAll(/CREATE TABLE (\w+)/g)].map(
      (match) => match[1] as string,
    );
    expect(tables).toEqual(['countries', 'country_cache', 'map_versions', 'jobs']);
    expect(migrationTables).toEqual(tables);

    const documentedIndexes = [
      ...[...documented.matchAll(/CREATE (UNIQUE )?INDEX (\w+)/g)].map((match) => ({
        name: match[2] as string,
        unique: match[1] !== undefined,
      })),
      ...[...documented.matchAll(/CONSTRAINT (\w+) UNIQUE/g)].map((match) => ({
        name: match[1] as string,
        unique: true,
      })),
    ];
    const migrationIndexes = [
      ...[...sqlText.matchAll(/CREATE (UNIQUE )?INDEX (\w+)/g)].map((match) => ({
        name: match[2] as string,
        unique: match[1] !== undefined,
      })),
      ...[...sqlText.matchAll(/CONSTRAINT (\w+) UNIQUE/g)].map((match) => ({
        name: match[1] as string,
        unique: true,
      })),
    ];
    expect(migrationIndexes).toEqual(documentedIndexes);

    const indexDefinitions = (text: string): string[] =>
      [...text.matchAll(/CREATE (?:UNIQUE )?INDEX\b[\s\S]*?;/g)].map((match) =>
        match[0].replace(/\s+/g, ' ').trim(),
      );
    expect(indexDefinitions(sqlText)).toEqual(indexDefinitions(documented));
  });

  it('creates the documented download-event table and index in the P2-API-09 migration', async () => {
    const doc = await readFile(DOC, 'utf8');
    const heading = '### 2.10 ';
    const start = doc.indexOf(heading);
    expect(start, '### 2.10 download_events must exist').toBeGreaterThan(-1);
    const end = doc.indexOf('\n### ', start + heading.length);
    const section = doc.slice(start, end === -1 ? undefined : end);
    const sqlText = await readFile(join(MIGRATIONS_DIR, '0003_download_events.sql'), 'utf8');

    expect([...section.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1])).toEqual([
      'download_events',
    ]);
    expect([...sqlText.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1])).toEqual([
      'download_events',
    ]);
    expect(
      [...section.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((match) => match[1]),
    ).toEqual(['download_events_country_idx']);
    expect(
      [...sqlText.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((match) => match[1]),
    ).toEqual(['download_events_country_idx']);
  });

  it('creates the documented upload-session table and expiry index in the P4-IMP-01 migration', async () => {
    const doc = await readFile(DOC, 'utf8');
    const heading = '### 2.8 ';
    const start = doc.indexOf(heading);
    expect(start, '### 2.8 upload_sessions must exist').toBeGreaterThan(-1);
    const end = doc.indexOf('\n### ', start + heading.length);
    const section = doc.slice(start, end === -1 ? undefined : end);
    const sqlText = await readFile(join(MIGRATIONS_DIR, '0004_upload_sessions.sql'), 'utf8');

    expect([...section.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1])).toEqual([
      'upload_sessions',
    ]);
    expect([...sqlText.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1])).toEqual([
      'upload_sessions',
    ]);
    expect(
      [...section.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((match) => match[1]),
    ).toEqual(['upload_sessions_temp_path_key', 'upload_sessions_expiry_idx']);
    expect(
      [...sqlText.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((match) => match[1]),
    ).toEqual(['upload_sessions_temp_path_key', 'upload_sessions_expiry_idx']);
  });

  it('creates the documented metrics sample table in the P5-MON-01 migration', async () => {
    const doc = await readFile(DOC, 'utf8');
    const heading = '### 2.9 ';
    const start = doc.indexOf(heading);
    expect(start, '### 2.9 metrics_samples must exist').toBeGreaterThan(-1);
    const end = doc.indexOf('\n### ', start + heading.length);
    const section = doc.slice(start, end === -1 ? undefined : end);
    const sqlText = await readFile(join(MIGRATIONS_DIR, '0007_metrics_samples.sql'), 'utf8');
    const columnsIn = (text: string) =>
      [...text.matchAll(/CREATE TABLE metrics_samples \(([\s\S]*?)\n\);/g)].flatMap((table) =>
        (table[1] as string)
          .split('\n')
          .map((line) => /^ {2}(\w+)\s+(.+)$/.exec(line))
          .filter((match): match is RegExpExecArray => match !== null && match[1] !== 'PRIMARY')
          .map((match) => ({ name: match[1], nullable: !/NOT NULL|PRIMARY KEY/i.test(match[2]!) })),
      );

    expect([...section.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1])).toEqual([
      'metrics_samples',
    ]);
    expect([...sqlText.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1])).toEqual([
      'metrics_samples',
    ]);
    expect(columnsIn(sqlText)).toEqual(columnsIn(section));
  });

  it('creates the documented interval tables and indexes, with mutually exclusive frequency fields', async () => {
    const doc = await readFile(DOC, 'utf8');
    const heading = '### 2.7 ';
    const start = doc.indexOf(heading);
    expect(start, '### 2.7 interval schedules must exist').toBeGreaterThan(-1);
    const end = doc.indexOf('\n### ', start + heading.length);
    const section = doc.slice(start, end === -1 ? undefined : end);
    const sqlText =
      (await readFile(join(MIGRATIONS_DIR, '0005_intervals.sql'), 'utf8')) +
      (await readFile(join(MIGRATIONS_DIR, '0006_interval_run_item_job_index.sql'), 'utf8'));

    const tablesIn = (text: string) =>
      [...text.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]);
    expect(tablesIn(section)).toEqual([
      'intervals',
      'interval_countries',
      'interval_runs',
      'interval_run_items',
    ]);
    expect(tablesIn(sqlText)).toEqual(tablesIn(section));

    const columnsIn = (text: string) =>
      [...text.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)].map((table) => ({
        name: table[1],
        columns: (table[2] as string)
          .split('\n')
          .map((line) => /^ {2}(\w+)\s+(.+)$/.exec(line))
          .filter(
            (match): match is RegExpExecArray =>
              match !== null &&
              !['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(
                match[1]!.toUpperCase(),
              ),
          )
          .map((match) => ({ name: match[1], nullable: !/NOT NULL|PRIMARY KEY/i.test(match[2]!) })),
      }));
    expect(columnsIn(sqlText)).toEqual(columnsIn(section));

    const indexNames = (text: string) =>
      [...text.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((match) => match[1]);
    expect(indexNames(section)).toEqual([
      'intervals_due_idx',
      'interval_countries_country_idx',
      'interval_runs_interval_idx',
      'interval_runs_one_active',
      'interval_run_items_unique',
      'interval_run_items_job_idx',
    ]);
    expect(indexNames(sqlText)).toEqual(indexNames(section));

    const indexDefinitions = (text: string) =>
      [...text.matchAll(/CREATE (?:UNIQUE )?INDEX\b[\s\S]*?;/g)].map((match) =>
        match[0].replace(/\s+/g, ' ').trim(),
      );
    expect(indexDefinitions(sqlText)).toEqual(indexDefinitions(section));
    expect(sqlText).toContain(
      "CREATE TYPE interval_frequency AS ENUM ('daily', 'weekly', 'monthly')",
    );
    expect(sqlText).toContain("(frequency = 'daily' AND weekday IS NULL AND day_of_month IS NULL)");
    expect(sqlText).toContain(
      "(frequency = 'weekly' AND weekday IS NOT NULL AND day_of_month IS NULL)",
    );
    expect(sqlText).toContain(
      "(frequency = 'monthly' AND weekday IS NULL AND day_of_month IS NOT NULL)",
    );
    const shapeRule = (text: string) =>
      /CONSTRAINT intervals_shape CHECK \([\s\S]*?\n {2}\)/
        .exec(text)?.[0]
        .replace(/\s+/g, ' ')
        .trim();
    expect(shapeRule(sqlText)).toBe(shapeRule(section));
  });

  it('does not create a table the document never names', async () => {
    // The other direction, so this file cannot quietly grow a table nobody documented.
    const documented = new Set(
      [...(await phaseOneSections()).matchAll(/CREATE TABLE (\w+)/g)].map(
        (match) => match[1] as string,
      ),
    );
    const sqlText = await readFile(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
    for (const match of sqlText.matchAll(/^CREATE TABLE (\w+) /gm)) {
      expect(documented, `${match[1]} is created but not documented`).toContain(match[1]);
    }
  });
});
