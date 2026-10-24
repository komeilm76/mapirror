#!/usr/bin/env bun
/**
 * Repository hygiene checks (task `P1-REPO-06`).
 *
 * Three classes of mistake are cheap to make and expensive to notice, so they are asserted here
 * instead of relying on review:
 *
 * 1. **Ignore matrix** — secrets (`*.env`), runtime data (`data/`, `backups/`), dependencies and build
 *    output must be ignored; source, docs and `.env.example` must not be.
 * 2. **Nothing ignored is already tracked** — `.gitignore` does not untrack a file, so a path added
 *    before its pattern existed would stay in the repository forever.
 * 3. **Config parity** — every variable in `docs/09-development.md` §5 must appear in `.env.example`
 *    and vice versa (L12), and `.dockerignore` must exclude secrets while keeping the files the images
 *    need to build.
 *
 * Run with `bun run check:hygiene`; part of `bun run check`.
 *
 * @module scripts/check-hygiene
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
 * Lists tracked files.
 *
 * @returns Repository-relative paths, or an empty array when git fails.
 */
function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return [];
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
 * Extracts variable names from the environment table in `docs/09-development.md`.
 *
 * @returns Variable names in table order.
 */
function docsEnvVars(): string[] {
  const section = read('docs/09-development.md');
  const start = section.indexOf('## 5. Environment variables');
  const end = section.indexOf('## 6.', start);
  if (start === -1 || end === -1) return [];
  const rows = section.slice(start, end).matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm);
  return [...rows].map((match) => match[1] as string);
}

/**
 * Extracts variable names from `.env.example`.
 *
 * Both active (`NAME=value`) and commented (`# NAME=value`) forms count: alternatives such as
 * `ADMIN_PASSWORD_FILE` are documented but deliberately left commented out, because setting both a
 * value and its `_FILE` sibling is a configuration error.
 *
 * @returns Variable names in file order.
 */
function exampleEnvVars(): string[] {
  return read('.env.example')
    .split('\n')
    .map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * Lists the variables that are present in `.env.example` but commented out.
 *
 * @returns Commented variable names.
 */
function commentedEnvVars(): string[] {
  return read('.env.example')
    .split('\n')
    .map((line) => /^#\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * Extracts the patterns from `.dockerignore`, ignoring comments and blanks.
 *
 * @returns Patterns in file order.
 */
function dockerIgnorePatterns(): string[] {
  return read('.dockerignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Decides whether a `.dockerignore` pattern would exclude a given path, covering the pattern forms
 * actually used in this repository (exact, `dir`, `dir/`, and `**／name`).
 *
 * @param pattern - A single `.dockerignore` line.
 * @param path - Repository-relative path to test.
 * @returns `true` when the pattern excludes the path.
 */
function patternExcludes(pattern: string, path: string): boolean {
  const cleaned = pattern.replace(/^!/, '').replace(/\/+$/, '');
  if (cleaned.length === 0) return false;
  const segments = path.split('/');
  if (cleaned.startsWith('**/')) {
    const name = cleaned.slice(3);
    return segments.includes(name) || path === name || path.startsWith(`${name}/`);
  }
  return path === cleaned || path.startsWith(`${cleaned}/`);
}

// ── 1. ignore matrix ──────────────────────────────────────────────────────────────────────────────
for (const path of MUST_BE_IGNORED) check(isIgnored(path), `gitignored: ${path}`);
for (const path of MUST_NOT_BE_IGNORED) check(!isIgnored(path), `tracked-able: ${path}`);

// ── 2. tracked files respect the patterns ─────────────────────────────────────────────────────────
const tracked = trackedFiles();
check(tracked.length > 0, 'git ls-files returned the repository contents');
const offenders = tracked.filter(
  (path) =>
    path.startsWith('node_modules/') ||
    path === '.env' ||
    path.startsWith('data/') ||
    path.startsWith('backups/') ||
    path.startsWith('coverage/') ||
    /(^|\/)dist\//.test(path) ||
    path.endsWith('.log'),
);
check(
  offenders.length === 0,
  `no ignored artefacts are tracked${offenders.length > 0 ? `: ${offenders.join(', ')}` : ''}`,
);

// ── 3. env documentation parity ───────────────────────────────────────────────────────────────────
const documented = docsEnvVars();
const templated = exampleEnvVars();
check(documented.length > 0, 'docs/09 §5 lists environment variables');
check(templated.length > 0, '.env.example defines variables');
const commented = commentedEnvVars();
check(
  commented.every((name) => templated.includes(name)),
  'commented alternatives in .env.example are also counted as documented',
);
const undocumented = templated.filter((name) => !documented.includes(name));
const missingFromTemplate = documented.filter((name) => !templated.includes(name));
check(
  undocumented.length === 0,
  `.env.example has no variables missing from docs${undocumented.length > 0 ? `: ${undocumented.join(', ')}` : ''}`,
);
check(
  missingFromTemplate.length === 0,
  `every documented variable is in .env.example (${templated.length - commented.length} active, ${commented.length} commented)${missingFromTemplate.length > 0 ? `: missing ${missingFromTemplate.join(', ')}` : ''}`,
);

// ── 4. .dockerignore: keeps secrets out, keeps build inputs in ───────────────────────────────────
const dockerPatterns = dockerIgnorePatterns();
check(dockerPatterns.length > 0, '.dockerignore has patterns');
for (const secret of ['.env', '.git', 'node_modules', 'data', 'backups']) {
  check(
    dockerPatterns.some((pattern) => patternExcludes(pattern, secret)),
    `.dockerignore excludes ${secret}`,
  );
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
    !dockerPatterns.some((pattern) => patternExcludes(pattern, required)),
    `.dockerignore keeps ${required} in the build context`,
  );
}

for (const line of passed) console.log(`  ok   ${line}`);
for (const line of failed) console.error(`  FAIL ${line}`);

if (failed.length > 0) {
  console.error(`\n${failed.length} hygiene check(s) failed.`);
  process.exit(1);
}
console.log(`\n${passed.length} hygiene checks passed.`);
