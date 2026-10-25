import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * Acceptance test for `P1-DB-02` against a real Postgres: the Kysely types, the migration and
 * `03-data-model.md` describe **the same tables**, and the values that come back are the ones the types promise.
 *
 * Three sources are compared rather than two, because the failure this catches is always one of them drifting:
 * a column added to the SQL and forgotten in TypeScript compiles and then returns `undefined` at runtime, and a
 * column typed as the wrong JS type compiles and then breaks on the first comparison.
 */

/** The document that defines the tables. */
// Four levels up from `tests/integration/`: integration → tests → api → apps → repository root.
const DOC = resolve(import.meta.dirname, '../../../../docs/03-data-model.md');

/** `schema.ts`, read as text because TypeScript types do not exist at runtime. */
const SCHEMA_SOURCE = resolve(import.meta.dirname, '../../src/db/schema.ts');

/** Table → the interface that describes it. */
const TABLE_INTERFACES = {
  admins: 'Admins',
  admin_tokens: 'AdminTokens',
  settings: 'Settings',
  audit_logs: 'AuditLogs',
} as const;

/** Section headings whose `CREATE TABLE` blocks belong to `0001_init.sql`. */
const PHASE_ONE_HEADINGS = ['### 2.1 ', '### 2.2 ', '### 2.11 '] as const;

/** A column name plus its nullability, as one source states it. */
interface ColumnShape {
  readonly name: string;
  readonly nullable: boolean;
}

/**
 * Columns as `03-data-model.md` declares them.
 *
 * @returns One entry per phase-1 table, in declaration order.
 */
function documentedColumns(): Record<string, ColumnShape[]> {
  const doc = readFileSync(DOC, 'utf8');
  const tables: Record<string, ColumnShape[]> = {};

  for (const heading of PHASE_ONE_HEADINGS) {
    const start = doc.indexOf(heading);
    expect(start, `${heading.trim()} must exist`).toBeGreaterThan(-1);
    const nextHeading = doc.indexOf('\n### ', start + heading.length);
    const section = doc.slice(start, nextHeading === -1 ? undefined : nextHeading);

    for (const match of section.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
      const table = match[1] as string;
      tables[table] = (match[2] as string)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('--') && !line.startsWith('CONSTRAINT'))
        .map((line) => /^(\w+)\s+([\s\S]*)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({
          name: match[1] as string,
          nullable: !/NOT NULL|PRIMARY KEY/i.test(match[2] as string),
        }));
    }
  }
  return tables;
}

/**
 * Property names of each `export interface` in `schema.ts`.
 *
 * @returns Interface name → property names, in declaration order.
 */
function interfaceProperties(): Map<string, string[]> {
  const source = readFileSync(SCHEMA_SOURCE, 'utf8');
  const found = new Map<string, string[]>();
  for (const match of source.matchAll(/export interface (\w+) \{([\s\S]*?)\n\}/g)) {
    found.set(
      match[1] as string,
      [...(match[2] as string).matchAll(/^ {2}(\w+)\??:/gm)].map(
        (property) => property[1] as string,
      ),
    );
  }
  return found;
}

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('the schema, the document and the database agree', () => {
  it('has exactly the documented columns, with the documented nullability', async () => {
    await withFreshDatabase(
      async (database) => {
        const documented = documentedColumns();
        for (const table of Object.keys(TABLE_INTERFACES)) {
          const rows = await sql<{ column_name: string; is_nullable: string }>`
            select column_name, is_nullable
              from information_schema.columns
             where table_schema = 'public' and table_name = ${table}
             order by ordinal_position
          `.execute(database.db);

          const actual = rows.rows.map((row) => ({
            name: row.column_name,
            nullable: row.is_nullable === 'YES',
          }));
          // Order included: a column added in the middle of the table is a schema change, and the document should
          // say so rather than quietly drifting from the database.
          expect(actual, table).toEqual(documented[table]);
        }
      },
      { prefix: 'schema', migrate: true },
    );
  });

  it('is fully described by the TypeScript interfaces, in the same order', async () => {
    await withFreshDatabase(
      async (database) => {
        const properties = interfaceProperties();
        for (const [table, interfaceName] of Object.entries(TABLE_INTERFACES)) {
          const rows = await sql<{ column_name: string }>`
            select column_name from information_schema.columns
             where table_schema = 'public' and table_name = ${table}
             order by ordinal_position
          `.execute(database.db);

          // A column in SQL but not in the interface returns `undefined` through Kysely while every type says it
          // exists; a property in the interface but not in SQL fails at query time. Neither direction is allowed.
          expect(properties.get(interfaceName), `${interfaceName} vs ${table}`).toEqual(
            rows.rows.map((row) => row.column_name),
          );
        }
      },
      { prefix: 'schema', migrate: true },
    );
  });

  it('round-trips every phase-1 table with the JS types the interfaces declare', async () => {
    await withFreshDatabase(
      async (database) => {
        const db = database.db;

        const admin = await db
          .insertInto('admins')
          .values({ username: 'admin', password_hash: 'argon2id$probe' })
          .returningAll()
          .executeTakeFirstOrThrow();

        // `uuid DEFAULT gen_random_uuid()` really is generated, and arrives as a string.
        expect(typeof admin.id).toBe('string');
        expect(admin.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(admin.is_active).toBe(true);
        expect(admin.created_at).toBeInstanceOf(Date);
        expect(admin.updated_at).toBeInstanceOf(Date);
        expect(admin.last_login_at).toBeNull();

        const tokenHash = Buffer.alloc(32, 9);
        const token = await db
          .insertInto('admin_tokens')
          .values({
            admin_id: admin.id,
            token_hash: tokenHash,
            token_prefix: 'mm_abcdefg',
            expires_at: new Date(Date.now() + 86_400_000),
            ip: '203.0.113.7',
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        expect(Buffer.isBuffer(token.token_hash)).toBe(true);
        expect(token.token_hash.equals(tokenHash)).toBe(true);
        expect(token.expires_at).toBeInstanceOf(Date);
        expect(token.revoked_at).toBeNull();
        // `inet` comes back as its text form, which is what the interface says it is.
        expect(token.ip).toBe('203.0.113.7');

        const setting = await db
          .insertInto('settings')
          .values({ key: 'cache.keepVersions', value: { keep: 3, nested: ['a'] } })
          .returningAll()
          .executeTakeFirstOrThrow();
        // `jsonb` is parsed by the driver, not handed over as a string.
        expect(setting.value).toEqual({ keep: 3, nested: ['a'] });

        const audit = await db
          .insertInto('audit_logs')
          .values({ actor_id: admin.id, actor_name: 'admin', action: 'auth.login' })
          .returningAll()
          .executeTakeFirstOrThrow();

        // The measured trap: `bigserial` is int8, and the driver returns it as a **string**, so the interface must
        // say string. A `number` here would pass every compile and misbehave on the first arithmetic.
        expect(typeof audit.id).toBe('string');
        expect(audit.id).toBe('1');
        expect(audit.metadata).toEqual({});
        expect(audit.created_at).toBeInstanceOf(Date);
      },
      { prefix: 'schema', migrate: true },
    );
  });

  it('rejects a row that breaks a column’s contract, so the types are not stricter than the database', async () => {
    await withFreshDatabase(
      async (database) => {
        const admin = await database.db
          .insertInto('admins')
          .values({ username: 'admin', password_hash: 'argon2id$probe' })
          .returningAll()
          .executeTakeFirstOrThrow();

        // 32 bytes is a `CHECK` in the migration; the interface says `Buffer` and cannot express the length, so the
        // database is the one that has to hold the line. This asserts it does.
        await expect(
          database.db
            .insertInto('admin_tokens')
            .values({
              admin_id: admin.id,
              token_hash: Buffer.from('too short'),
              token_prefix: 'mm_short',
              expires_at: new Date(Date.now() + 60_000),
            })
            .execute(),
        ).rejects.toMatchObject({ code: '23514' });
      },
      { prefix: 'schema', migrate: true },
    );
  });
});
