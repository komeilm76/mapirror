import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ERROR_STATUS,
  IMPORT_STATUSES,
  INTERVAL_FREQUENCIES,
  JOB_STATUSES,
  JOB_TYPES,
  ROUTE_PREFIXES,
  RUN_ITEM_STATUSES,
  UPDATE_STATES,
  VERSION_ORIGINS,
  VERSION_STATUSES,
} from '../../packages/shared/src/index';

/**
 * Proves the code and the specification still say the same thing.
 *
 * `04-api.md` opens with "this document and the code cannot drift silently" and `03-data-model.md` defines
 * the enums the API validates against. Those are claims, and this file is what makes them true: it parses
 * the markdown and compares the extracted sets with the constants, in **both** directions, so adding a
 * code or an enum value on either side alone fails the gate.
 *
 * Markdown tables are parsed by shape, not by position — a reordered row is fine, a missing one is not.
 *
 * The constants are imported by relative path, not by package name: the repository root does not depend on
 * `@mapirror/shared` (only the two apps do), and adding a root dependency just to satisfy a test would
 * also make the test pass against a registry copy. A relative import can only reach the workspace.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Reads a repository file.
 *
 * @param path - Repository-relative path.
 * @returns File contents.
 */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/**
 * Extracts the code column from every error-table row in `04-api.md` §0.2.
 *
 * @returns Code names in document order.
 */
function documentedErrorCodes(): string[] {
  const api = read('docs/04-api.md');
  const start = api.indexOf('### Error envelope');
  // The next top-level heading, not the next `---`: the first `---` after the heading is the table's own
  // column separator (`|---|---|`), and stopping there would parse zero rows while looking successful.
  const end = api.indexOf('\n## ', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const codes: string[] = [];
  for (const match of api.slice(start, end).matchAll(/^\| \d{3} \|(.+)$/gm)) {
    for (const code of (match[1] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      codes.push(code[1] as string);
    }
  }
  return codes;
}

/**
 * Extracts the values of a `CREATE TYPE <name> AS ENUM ('a','b')` statement from `03-data-model.md`.
 *
 * @param typeName - Enum type name.
 * @returns Values in declaration order.
 */
function documentedEnum(typeName: string): string[] {
  const model = read('docs/03-data-model.md');
  const pattern = new RegExp(`CREATE TYPE ${typeName} AS ENUM \\(([^)]*)\\)`);
  const match = pattern.exec(model);
  expect(match, `CREATE TYPE ${typeName} in 03-data-model.md`).not.toBeNull();
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((value) => value[1] as string);
}

/**
 * Extracts the values of a `CHECK (<column> IN ('a','b'))` constraint **within one table**.
 *
 * Scoped to the table on purpose: `status` exists on `jobs` and on `map_versions` with different value
 * sets, so an unscoped search silently returns the union of both and every assertion about it is wrong.
 *
 * @param table - Table name.
 * @param column - Column name inside that table.
 * @returns The allowed values in declaration order.
 */
function documentedCheckValues(table: string, column: string): string[] {
  const model = read('docs/03-data-model.md');
  const start = model.indexOf(`CREATE TABLE ${table} (`);
  expect(start, `CREATE TABLE ${table}`).toBeGreaterThan(-1);
  const end = model.indexOf('\n);', start);
  expect(end).toBeGreaterThan(start);
  const block = model.slice(start, end);

  const match = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(block);
  expect(match, `CHECK constraint for ${table}.${column}`).not.toBeNull();
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((value) => value[1] as string);
}

describe('error codes (04-api.md §0.2 ↔ ERROR_STATUS)', () => {
  it('documents every code the code knows', () => {
    const documented = new Set(documentedErrorCodes());
    const missing = Object.keys(ERROR_STATUS).filter((code) => !documented.has(code));
    expect(missing, 'codes in ERROR_STATUS but not in 04-api.md').toEqual([]);
  });

  it('implements every code the docs promise', () => {
    const documented = documentedErrorCodes();
    const unknown = documented.filter((code) => !Object.hasOwn(ERROR_STATUS, code));
    expect(unknown, 'codes in 04-api.md but not in ERROR_STATUS').toEqual([]);
  });

  it('agrees on the HTTP status of each code', () => {
    const api = read('docs/04-api.md');
    const wrong: string[] = [];
    for (const match of api.matchAll(/^\| (\d{3}) \|(.+)$/gm)) {
      const status = Number(match[1]);
      for (const code of (match[2] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
        const name = code[1] as string;
        if (
          Object.hasOwn(ERROR_STATUS, name) &&
          ERROR_STATUS[name as keyof typeof ERROR_STATUS] !== status
        ) {
          wrong.push(
            `${name}: docs ${status}, code ${ERROR_STATUS[name as keyof typeof ERROR_STATUS]}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('documents the disabled-account code instead of a lockout code', () => {
    // Throttling is 429 RATE_LIMITED; a deactivated account is 403 ACCOUNT_DISABLED. The old name read
    // like a lockout and invited exactly that mistake. Prose may mention the history — a table row
    // listing it as a live code may not.
    const api = read('docs/04-api.md');
    const tableRows = api.split('\n').filter((line) => /^\| \d{3} \|/.test(line));
    expect(tableRows.some((row) => row.includes('ACCOUNT_LOCKED'))).toBe(false);
    expect(tableRows.some((row) => row.includes('ACCOUNT_DISABLED'))).toBe(true);
    expect(read('docs/14-security.md')).toContain('ACCOUNT_DISABLED');
  });
});

describe('enums (03-data-model.md ↔ constants)', () => {
  it.each([
    ['interval_frequency', INTERVAL_FREQUENCIES],
    ['job_type', JOB_TYPES],
    ['job_status', JOB_STATUSES],
  ])('%s matches', (typeName, values) => {
    expect([...values]).toEqual(documentedEnum(typeName));
  });

  it('version origin and status match their CHECK constraints', () => {
    expect([...VERSION_ORIGINS]).toEqual(documentedCheckValues('map_versions', 'origin'));
    expect([...VERSION_STATUSES]).toEqual(documentedCheckValues('map_versions', 'status'));
  });

  it('update state matches its CHECK constraint', () => {
    expect([...UPDATE_STATES]).toEqual(documentedCheckValues('country_cache', 'update_state'));
  });

  it('keeps the three `status` vocabularies apart', () => {
    // `status` exists on jobs (an enum), map_versions and upload_sessions/interval_run_items (CHECKs), all
    // with different value sets. An unscoped parse returns their union — which is how this test was first
    // written, and it passed for the wrong reason until the parser was scoped to a table.
    expect([...JOB_STATUSES]).toEqual(documentedEnum('job_status'));
    expect([...VERSION_STATUSES]).toEqual(documentedCheckValues('map_versions', 'status'));
    expect([...IMPORT_STATUSES]).toEqual(documentedCheckValues('upload_sessions', 'status'));
    expect([...RUN_ITEM_STATUSES]).toEqual(documentedCheckValues('interval_run_items', 'status'));
    const sets = [JOB_STATUSES, VERSION_STATUSES, IMPORT_STATUSES, RUN_ITEM_STATUSES].map((list) =>
      JSON.stringify([...list].sort()),
    );
    expect(new Set(sets).size).toBe(sets.length);
  });
});

describe('route prefixes (04-api.md §0 ↔ ROUTE_PREFIXES)', () => {
  it('names every prefix in the normative route table, verbatim', () => {
    const table = read('docs/04-api.md');
    for (const prefix of [
      ROUTE_PREFIXES.site,
      ROUTE_PREFIXES.authApi,
      ROUTE_PREFIXES.adminApi,
      ROUTE_PREFIXES.publicApi,
    ]) {
      expect(table, prefix).toContain(`\`${prefix}`);
    }
    expect(table).toContain('`GET /_auth/login`');
    expect(table).toContain('`/healthz`');
    expect(table).toContain('`/readyz`');
  });

  it('states the root redirect the code assumes', () => {
    expect(read('docs/04-api.md')).toContain('302 /_site/');
    expect(read('docs/10-laws.md')).toContain('returns `302` to `/_site/`');
  });
});
