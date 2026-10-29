import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Kysely } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createDatabase,
  parseEnv,
  type Admin,
  type AdminToken,
  type AuditLog,
  type DownloadEvent,
  type Country,
  type CountryCacheRow,
  type Database,
  type Job,
  type MapVersion,
  type Setting,
  type UploadSession,
} from '../src/index';

/**
 * Acceptance test for `P1-DB-02` and `P2-DB-01`, the half that needs no server: Kysely types describe every migrated
 * table with the values the driver returns, every documented column is covered, and nothing in `db/` uses `any`.
 *
 * The other half (`tests/integration/schema-db.spec.ts`) compares these names against `information_schema` on a
 * freshly migrated database, so a column renamed in SQL but not in TypeScript fails there.
 */

/** Where the module under test and its neighbours live. */
const DB_DIR = resolve(import.meta.dirname, '../src/db');

/** Table → interface name in `schema.ts`. Explicit, so renaming one without the other fails loudly. */
const TABLE_INTERFACES = {
  admins: 'Admins',
  admin_tokens: 'AdminTokens',
  countries: 'Countries',
  country_cache: 'CountryCache',
  map_versions: 'MapVersions',
  upload_sessions: 'UploadSessions',
  jobs: 'Jobs',
  settings: 'Settings',
  audit_logs: 'AuditLogs',
  download_events: 'DownloadEvents',
} as const;

/**
 * Reads the property names of each `export interface` in `schema.ts`.
 *
 * Parsed from the file rather than reflected at runtime because TypeScript types do not exist at runtime — the
 * point of the check is that the *source* covers every column, so the source is what gets read.
 *
 * @returns Interface name → its property names, in declaration order.
 */
function interfaceProperties(): Map<string, string[]> {
  const source = readFileSync(join(DB_DIR, 'schema.ts'), 'utf8');
  const found = new Map<string, string[]>();
  for (const match of source.matchAll(/export interface (\w+) \{([\s\S]*?)\n\}/g)) {
    const body = match[2] as string;
    const properties = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map(
      (property) => property[1] as string,
    );
    found.set(match[1] as string, properties);
  }
  return found;
}

/** The `CREATE TABLE` blocks in sections backed by migrations 0001 through 0004. */
const DOC = resolve(import.meta.dirname, '../../../docs/03-data-model.md');

/** Document sections backed by `0001_init.sql` through `0004_upload_sessions.sql`. */
const MIGRATED_HEADINGS = [
  '### 2.1 ',
  '### 2.2 ',
  '### 2.3 ',
  '### 2.4 ',
  '### 2.5 ',
  '### 2.6 ',
  '### 2.8 ',
  '### 2.10 ',
  '### 2.11 ',
] as const;

/** One column as the document declares it. */
interface DocColumn {
  readonly table: string;
  readonly name: string;
  readonly nullable: boolean;
}

/**
 * Parses the document's phase-1 `CREATE TABLE` blocks.
 *
 * @returns Every column, with the nullability the SQL states.
 */
function documentedColumns(): DocColumn[] {
  const doc = readFileSync(DOC, 'utf8');
  const columns: DocColumn[] = [];

  for (const heading of MIGRATED_HEADINGS) {
    const start = doc.indexOf(heading);
    expect(start, `${heading.trim()} must exist in 03-data-model.md`).toBeGreaterThan(-1);
    const nextHeading = doc.indexOf('\n### ', start + heading.length);
    const section = doc.slice(start, nextHeading === -1 ? undefined : nextHeading);

    for (const match of section.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
      const table = match[1] as string;
      for (const line of (match[2] as string).split('\n')) {
        // Table columns and table constraints start at two spaces; wrapped CHECK expressions are indented further.
        // Restricting this parse to top-level lines prevents `status <> 'ready'` inside a constraint from becoming a
        // second, phantom `status` column.
        const column = /^ {2}(\w+)\s+(.+)$/.exec(line);
        if (column === null) continue;
        const name = column[1] as string;
        if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(name.toUpperCase()))
          continue;
        columns.push({
          table,
          name,
          nullable: !/NOT NULL|PRIMARY KEY/i.test(column[2] as string),
        });
      }
    }
  }
  return columns;
}

describe('the migrated table interfaces', () => {
  it('declare every column the document declares, and nothing else', () => {
    const properties = interfaceProperties();
    const columns = documentedColumns();
    expect(columns.length).toBeGreaterThan(0);

    for (const [table, interfaceName] of Object.entries(TABLE_INTERFACES)) {
      const documented = columns.filter((column) => column.table === table).map((c) => c.name);
      expect(documented.length, table).toBeGreaterThan(0);
      expect(properties.get(interfaceName), `${interfaceName} vs ${table}`).toEqual(documented);
    }
  });

  it('leaves nothing out of the Database map, and invents no table', () => {
    expect(Object.keys(TABLE_INTERFACES).sort()).toEqual([
      'admin_tokens',
      'admins',
      'audit_logs',
      'countries',
      'country_cache',
      'download_events',
      'jobs',
      'map_versions',
      'settings',
      'upload_sessions',
    ]);
    const source = readFileSync(join(DB_DIR, 'schema.ts'), 'utf8');
    const block = /export interface Database \{([\s\S]*?)\n\}/.exec(source)?.[1] as string;
    const mapped = [...block.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1] as string);
    expect(mapped).toEqual(Object.keys(TABLE_INTERFACES));
  });
});

/**
 * **These assertions are checked by `tsc`, not by Vitest.** `expectTypeOf` is a compile-time DSL: at runtime the
 * calls do nothing, so `bun run test` passes even when a type is wrong — `bun run typecheck` (part of
 * `bun run check`) is what fails, with a message like `Expected: string, Actual: number`. Verified by mutating
 * `AuditLogs.id` to `Generated<number>`. The runtime half of the same claim is asserted against a real server in
 * `tests/integration/schema-db.spec.ts`, which is what catches a type the driver disagrees with.
 */
describe('the selected row types match what the driver returns', () => {
  it('types every id as a string, including the bigserial audit id', () => {
    // Measured with `pg`: int8 arrives as text ("1"), not as a number. `audit_logs.id: number` would compile and
    // then compare wrong the first time it met a number.
    expectTypeOf<Admin['id']>().toEqualTypeOf<string>();
    expectTypeOf<AdminToken['id']>().toEqualTypeOf<string>();
    expectTypeOf<AuditLog['id']>().toEqualTypeOf<string>();
    expectTypeOf<DownloadEvent['id']>().toEqualTypeOf<string>();
    expectTypeOf<DownloadEvent['bytes_sent']>().toEqualTypeOf<string>();
    expectTypeOf<UploadSession['id']>().toEqualTypeOf<string>();
    expectTypeOf<UploadSession['size_bytes']>().toEqualTypeOf<string>();
  });

  it('types timestamptz as Date, bytea as Buffer, jsonb as the parsed value, inet as string', () => {
    expectTypeOf<Admin['created_at']>().toEqualTypeOf<Date>();
    expectTypeOf<Admin['last_login_at']>().toEqualTypeOf<Date | null>();
    expectTypeOf<AdminToken['token_hash']>().toEqualTypeOf<Buffer>();
    expectTypeOf<AdminToken['ip']>().toEqualTypeOf<string | null>();
    expectTypeOf<Setting['value']>().not.toBeAny();
    expectTypeOf<Admin['is_active']>().toEqualTypeOf<boolean>();
  });

  it('types phase-2 bigint columns as strings on reads and scalar JSON as a JSON value', () => {
    // PostgreSQL int8 is returned as decimal text; `int` and `smallint` remain numbers.
    expectTypeOf<Country['source_size_hint_bytes']>().toEqualTypeOf<string | null>();
    expectTypeOf<CountryCacheRow['total_size_bytes']>().toEqualTypeOf<string>();
    expectTypeOf<CountryCacheRow['versions_ready_count']>().toEqualTypeOf<number>();
    expectTypeOf<MapVersion['file_size_bytes']>().toEqualTypeOf<string>();
    expectTypeOf<Job['progress_bytes']>().toEqualTypeOf<string>();
    expectTypeOf<Job['attempts']>().toEqualTypeOf<number>();
    expectTypeOf<Job['payload']>().not.toBeAny();
  });

  it('lets the database generate ids and timestamps, so an insert does not have to invent them', () => {
    const database = createDatabase(parseEnv({}));
    try {
      // Only built, never executed: this asserts the *types* of an insert against the real Kysely builder.
      const insert = database.db
        .insertInto('admins')
        .values({ username: 'admin', password_hash: 'argon2id$…' })
        .returning(['id', 'created_at']);
      const countryInsert = database.db
        .insertInto('countries')
        .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
        .returning(['id', 'slug']);
      const jobInsert = database.db
        .insertInto('jobs')
        .values({ type: 'catalog_sync', payload: { source: 'geofabrik' } })
        .returning(['id', 'status']);
      expect(insert).toBeDefined();
      expect(countryInsert).toBeDefined();
      expect(jobInsert).toBeDefined();
    } finally {
      void database.close();
    }
  });

  it('forbids supplying a generated id, which is how a serial sequence gets desynced', () => {
    const supplyId = (db: Kysely<Database>): unknown =>
      // @ts-expect-error - `id` is GeneratedAlways: the database owns it
      db.insertInto('audit_logs').values({ id: '7', actor_name: 'admin', action: 'auth.login' });

    expect(supplyId).toBeTypeOf('function');
  });

  it('rejects an unknown table and an unknown column at compile time', () => {
    // The guarantee `P1-DB-02` exists for ("no `any` in repositories"). `@ts-expect-error` is checked by `tsc`:
    // if these expressions ever start compiling, the typecheck fails instead of the mistake shipping.
    const unknownTable = (db: Kysely<Database>): unknown =>
      // @ts-expect-error - `intervals` is a later phase-4 table and is not in the map yet
      db.selectFrom('intervals').selectAll();

    const unknownColumn = (db: Kysely<Database>): unknown =>
      // @ts-expect-error - `password` does not exist; the column is `password_hash`
      db.selectFrom('admins').select('password');

    expect(unknownTable).toBeTypeOf('function');
    expect(unknownColumn).toBeTypeOf('function');
  });
});

describe('no `any` in the database layer', () => {
  /**
   * Every `.ts` file under `src/db`, including `migrations/` (SQL only, but walked so a stray file is noticed).
   *
   * @param dir - Directory to walk.
   * @returns Absolute file paths.
   */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  it('never uses `any` in a type position or a cast', () => {
    const files = sourceFiles(DB_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.flatMap((file) => {
      // Comments are stripped *before* scanning, not filtered line by line: the rule is about code, and this file's
      // own documentation says "any" several times. Stripping keeps the check honest in both directions — a
      // `/* any */` on a code line is not a hit, and `const x = 1; // any` is still not one.
      const code = readFileSync(file, 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');
      return code
        .split('\n')
        .map((line, index) => ({ line, index: index + 1 }))
        .filter(({ line }) => /(^|[^A-Za-z0-9_$])any([^A-Za-z0-9_$]|$)/.test(line))
        .map(({ index }) => `${file}:${index}`);
    });

    expect(offenders).toEqual([]);
  });
});
