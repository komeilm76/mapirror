#!/usr/bin/env bun
/**
 * Repository hygiene checks (tasks `P1-REPO-04`, `P1-REPO-06`).
 *
 * Five classes of mistake are cheap to make and expensive to notice, so they are asserted here instead
 * of relying on review:
 *
 * 1. **Ignore matrix** — secrets (`*.env`, `*.pem`), runtime data (`data/`, `backups/`), dependencies
 *    and build output must be ignored; source, docs and `.env.example` must not be.
 * 2. **Nothing ignored is tracked** — `.gitignore` never untracks a file that was added before its
 *    rule existed, so git itself is asked (`ls-files -ci --exclude-standard`).
 * 3. **Config parity** — every variable in `docs/09-development.md` §5 appears in `.env.example` with
 *    the same default and vice versa (L12), and `.dockerignore` excludes secrets while keeping the
 *    files the images need to build.
 * 4. **No orphan tests** — every `*.spec.ts` / `*.test.ts` file must be collected by a project in
 *    `vitest.projects.ts`. A test that is never collected passes by not running.
 * 5. **Both ignore files agree** — a pattern that protects a secret in one belongs in the other.
 *
 * Run with `bun run check:hygiene`; stage 2 of `bun run check`.
 *
 * Assertion counts are summarised, not per item (one `FAIL` line lists every offending path), so the
 * total stays stable as the repository grows.
 *
 * @module scripts/check-hygiene
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isExcludedFromBuild, parseDockerIgnore } from './lib/dockerignore';

import { TEST_PROJECTS } from '../vitest.projects';

const ROOT = resolve(import.meta.dir, '..');

const passed: string[] = [];
const failed: string[] = [];

/** Paths that must be ignored by git. */
const MUST_BE_IGNORED = [
  'node_modules/dependency/index.js',
  '.env',
  '.env.local',
  '.env.production',
  'data/cache/finland/261023/finland-261023.osm.pbf',
  'backups/2026-10-24T021500Z/db.dump',
  'dist/server.js',
  'coverage/index.html',
  'apps/api/dist/server.js',
  'debug.log',
];

/** Paths that must stay tracked; ignoring any of these breaks clones or hides source. */
const MUST_NOT_BE_IGNORED = [
  '.env.example',
  'package.json',
  'bun.lock',
  'tsconfig.base.json',
  'apps/api/src/index.ts',
  'apps/web/src/index.ts',
  'packages/shared/src/index.ts',
  'scripts/check-hygiene.ts',
  'docs/09-development.md',
  'eslint.config.js',
];

/** Credential-shaped paths that **both** ignore files must cover. */
const MUST_BE_SECRET = [
  'server.pem',
  'server.key',
  'client.p12',
  'secrets/admin_password',
  'secrets/',
];

/** Directories the test-file walk never descends into. */
const UNSCANNED = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'data', 'backups']);

/**
 * Records an assertion outcome.
 *
 * @param condition - Whether the assertion holds.
 * @param message - Description shown as `ok` or `FAIL`.
 */
function check(condition: boolean, message: string): void {
  (condition ? passed : failed).push(message);
}

/**
 * Asks git whether a path is ignored.
 *
 * @param path - Repository-relative path.
 * @returns `true` when a `.gitignore` rule matches, `false` otherwise or when git cannot answer.
 */
function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a repository file.
 *
 * @param path - Repository-relative path.
 * @returns File contents, or an empty string when unreadable.
 */
function read(path: string): string {
  try {
    return readFileSync(join(ROOT, path), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Lists tracked files that match an ignore rule, using git's own matcher rather than a copy of the
 * rules — a second copy is a second thing to forget.
 *
 * @returns Repository-relative paths, or `null` when git could not be asked.
 */
function trackedButIgnored(): string[] | null {
  try {
    return execFileSync('git', ['ls-files', '-ci', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

/**
 * Extracts the environment table from `docs/09-development.md` §5.
 *
 * @returns Variable name → raw default cell.
 */
function docsEnvDefaults(): Map<string, string> {
  const doc = read('docs/09-development.md');
  const start = doc.indexOf('## 5. Environment variables');
  const end = doc.indexOf('## 6.', start);
  const rows = new Map<string, string>();
  if (start === -1 || end === -1) return rows;
  for (const match of doc.slice(start, end).matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|(.*)$/gm)) {
    const cells = (match[2] ?? '').split('|');
    rows.set(match[1] as string, (cells[0] ?? '').trim());
  }
  return rows;
}

/**
 * Extracts variable names and values from `.env.example`.
 *
 * Both active (`NAME=value`) and commented (`# NAME=value`) forms count: alternatives such as
 * `ADMIN_PASSWORD_FILE` are documented but deliberately left commented out, because setting both a
 * value and its `_FILE` sibling is a configuration error.
 *
 * @returns Variable name → declared value, plus the set of commented-out names.
 */
function exampleEnv(): { values: Map<string, string>; commented: Set<string> } {
  const values = new Map<string, string>();
  const commented = new Set<string>();
  for (const line of read('.env.example').split('\n')) {
    const match = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    const name = match?.[2];
    if (!match || name === undefined) continue;
    values.set(name, (match[3] ?? '').trim());
    if (match[1] !== undefined) commented.add(name);
  }
  return { values, commented };
}

/**
 * Reads a literal default from a documentation table cell: a single backticked token, optionally
 * followed by an annotation such as `` (8 GiB) ``. Prose cells (`` *(empty = same-origin)* ``,
 * `from package`) return `undefined` and are not compared.
 *
 * @param cell - Raw default cell from the table.
 * @returns The literal value, or `undefined` when the cell is prose.
 */
function literalDefault(cell: string): string | undefined {
  const trimmed = cell.trim();
  if (trimmed.startsWith('`')) {
    const end = trimmed.indexOf('`', 1);
    if (end === -1) return undefined;
    const rest = trimmed.slice(end + 1).trim();
    if (rest.length > 0 && !rest.startsWith('(')) return undefined;
    return trimmed.slice(1, end);
  }
  // Unquoted single tokens (`info`, `12`) are still literals; anything with a space is prose.
  return /^[^\s`]+$/.test(trimmed) && trimmed !== '—' ? trimmed : undefined;
}

/**
 * Walks the repository collecting test files.
 *
 * @param dir - Absolute directory to scan.
 * @returns Repository-relative paths of `*.spec.ts` / `*.test.ts` files.
 */
function walkTestFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (UNSCANNED.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkTestFiles(absolute));
    else if (/\.(spec|test)\.ts$/.test(entry.name)) found.push(absolute.slice(ROOT.length + 1));
  }
  return found;
}

// ── 1. ignore matrix ─────────────────────────────────────────────────────────────────────────────
for (const path of MUST_BE_IGNORED) check(isIgnored(path), `gitignored: ${path}`);
for (const path of MUST_NOT_BE_IGNORED) check(!isIgnored(path), `tracked-able: ${path}`);

// ── 2. nothing ignored is tracked ────────────────────────────────────────────────────────────────
const tracked = trackedButIgnored();
check(tracked !== null, 'git ls-files answered');
check(
  tracked?.length === 0,
  `no ignored artefacts are tracked${tracked && tracked.length > 0 ? `: ${tracked.join(', ')}` : ''}`,
);

// ── 3. both ignore files protect the same secrets ────────────────────────────────────────────────
const dockerPatterns = parseDockerIgnore(read('.dockerignore'));
check(dockerPatterns.length > 0, '.dockerignore has patterns');
for (const secret of MUST_BE_SECRET) {
  check(isIgnored(secret), `.gitignore covers ${secret}`);
  check(isExcludedFromBuild(secret, dockerPatterns), `.dockerignore covers ${secret}`);
}

// ── 4. env documentation parity: names ───────────────────────────────────────────────────────────
const documented = docsEnvDefaults();
const { values: templated, commented } = exampleEnv();
check(documented.size > 0, 'docs/09 §5 lists environment variables');
check(templated.size > 0, '.env.example defines variables');
const undocumented = [...templated.keys()].filter((name) => !documented.has(name));
const missingFromTemplate = [...documented.keys()].filter((name) => !templated.has(name));
check(
  undocumented.length === 0,
  `.env.example has no variables missing from docs${undocumented.length > 0 ? `: ${undocumented.join(', ')}` : ''}`,
);
check(
  missingFromTemplate.length === 0,
  `every documented variable is in .env.example (${templated.size - commented.size} active, ${commented.size} commented)${missingFromTemplate.length > 0 ? `: missing ${missingFromTemplate.join(', ')}` : ''}`,
);

// ── 5. env documentation parity: values ──────────────────────────────────────────────────────────
// Names are not enough: an operator reads one and pastes the other, so a default that changed in a
// single place is a bug even though both files still "know" the variable.
const driftedValues: string[] = [];
for (const [name, cell] of documented) {
  const expected = literalDefault(cell);
  const actual = templated.get(name);
  if (expected === undefined || actual === undefined) continue;
  if (expected === '—' || expected === '') continue;
  const normalised = expected === '(none)' ? '' : expected;
  if (actual !== normalised) {
    driftedValues.push(`${name}: docs "${expected}" vs template "${actual}"`);
  }
}
check(
  driftedValues.length === 0,
  `documented defaults match .env.example${driftedValues.length > 0 ? `: ${driftedValues.join('; ')}` : ''}`,
);

// ── 6. .dockerignore: secrets out, build inputs in ───────────────────────────────────────────────
for (const secret of [
  '.env',
  '.env.local',
  '.git',
  'node_modules/x.js',
  'data/cache/x.pbf',
  'backups/db.dump',
]) {
  check(isExcludedFromBuild(secret, dockerPatterns), `.dockerignore excludes ${secret}`);
}
for (const required of [
  'package.json',
  'bun.lock',
  'tsconfig.base.json',
  'apps/api/index.ts',
  'packages/shared/src/index.ts',
  'scripts/check-hygiene.ts',
  'docker/nginx.conf',
]) {
  check(
    !isExcludedFromBuild(required, dockerPatterns),
    `.dockerignore keeps ${required} in the build context`,
  );
}

// ── 7. no orphan tests ───────────────────────────────────────────────────────────────────────────
const testFiles = walkTestFiles(ROOT);
check(testFiles.length > 0, 'the repository contains test files');
check(
  TEST_PROJECTS.every((project) => existsSync(join(ROOT, project.root))),
  `every vitest project root exists (${TEST_PROJECTS.map((project) => project.name).join(', ')})`,
);
const orphans = testFiles.filter((file) => {
  const owners = TEST_PROJECTS.filter((project) =>
    file.startsWith(`${project.root.replace(/^\.\//, '')}/tests/`),
  );
  return owners.length === 0;
});
check(
  orphans.length === 0,
  `every test file is collected by a vitest project${orphans.length > 0 ? `: ${orphans.join(', ')}` : ``}`,
);

// ── report ──────────────────────────────────────────────────────────────────────────────────────
for (const line of passed) console.log(`  ok   ${line}`);
for (const line of failed) console.error(`  FAIL ${line}`);

if (failed.length > 0) {
  console.error(`\n${failed.length} hygiene check(s) failed.`);
  process.exit(1);
}
console.log(`\n${passed.length} hygiene checks passed.`);
