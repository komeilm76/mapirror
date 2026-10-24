#!/usr/bin/env bun
/**
 * Verifies the Bun workspace skeleton (tasks `P1-REPO-01`, `P1-REPO-02`).
 *
 * Checks, in order:
 * 1. the root manifest declares `dir/*` workspaces and every workspace is private and named;
 * 2. names are unique, the three expected packages exist, and each directory follows the
 *    `@<root-name>/<dir>` convention (`apps/api` → `@mapirror/api`);
 * 3. both apps depend on `@mapirror/shared` through the `workspace:` protocol;
 * 4. every workspace has a `typecheck` script, so the root chain actually covers it;
 * 5. `@mapirror/shared` resolves from `apps/api` into the local package, not a registry copy.
 *
 * Failures are reported one line each and exit non-zero; an unexpected error (unreadable manifest,
 * unsupported workspace pattern) is also reported as a failure line, never as a stack trace — this
 * script gates CI, so its own diagnostics have to be trustworthy.
 *
 * @module scripts/check-workspaces
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SCOPE = '@mapirror';
const EXPECTED = ['@mapirror/api', '@mapirror/web', '@mapirror/shared'];

/** The subset of `package.json` this script reasons about. */
interface Manifest {
  name?: string;
  private?: boolean;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const passed: string[] = [];
const failed: string[] = [];

/**
 * Records one assertion.
 *
 * @param condition - Whether it holds.
 * @param message - Description shown as `ok` or `FAIL` in both cases.
 */
function check(condition: boolean, message: string): void {
  (condition ? passed : failed).push(message);
}

/**
 * Reads and parses a `package.json`, surfacing malformed JSON as a failure rather than a throw.
 *
 * @param path - Absolute path to the manifest.
 * @returns The parsed manifest, or `null` when it could not be read.
 */
function readManifest(path: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch (error) {
    failed.push(`cannot read ${path.slice(ROOT.length + 1)}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Expands the one-level `dir/*` workspace globs used by this repository.
 *
 * @param globs - Workspace patterns from the root manifest.
 * @returns Absolute paths of package directories, sorted.
 */
function expandWorkspaces(globs: string[]): string[] {
  const dirs: string[] = [];
  for (const glob of globs) {
    if (!glob.endsWith('/*')) {
      failed.push(`unsupported workspace pattern "${glob}" — only one-level "dir/*" is supported`);
      continue;
    }
    const parent = join(ROOT, glob.slice(0, -2));
    if (!existsSync(parent)) {
      failed.push(`workspace pattern "${glob}" points at a missing directory`);
      continue;
    }
    for (const entry of readdirSync(parent)) {
      const dir = join(parent, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, 'package.json'))) {
        failed.push(`${glob.slice(0, -2)}/${entry} has no package.json`);
        continue;
      }
      dirs.push(dir);
    }
  }
  return dirs.sort();
}

/**
 * Runs every workspace assertion.
 *
 * @throws Never — all expected problems are recorded as failures.
 */
async function main(): Promise<void> {
  const root = readManifest(join(ROOT, 'package.json'));
  if (!root) return;

  check(Array.isArray(root.workspaces) && root.workspaces.length > 0, 'root package.json declares workspaces');
  check(root.private === true, 'root package.json is private');

  const dirs = expandWorkspaces(root.workspaces ?? []);
  const entries = dirs
    .map((dir) => ({ dir, manifest: readManifest(join(dir, 'package.json')) }))
    .filter((entry): entry is { dir: string; manifest: Manifest } => entry.manifest !== null);

  check(entries.length > 0, 'at least one workspace was found');
  check(
    entries.every(({ manifest }) => manifest.private === true),
    'every workspace is private',
  );

  const byName = new Map<string, string>();
  for (const { dir, manifest } of entries) {
    const rel = dir.slice(ROOT.length + 1);
    const name = manifest.name;
    check(typeof name === 'string' && name.length > 0, `${rel} declares a package name`);
    if (typeof name !== 'string' || name.length === 0) continue;

    if (byName.has(name)) failed.push(`duplicate workspace name "${name}" (${rel})`);
    byName.set(name, dir);

    check(name === `${SCOPE}/${basename(dir)}`, `${rel} is named ${SCOPE}/${basename(dir)} (found "${name}")`);
    check(
      typeof manifest.scripts?.typecheck === 'string',
      `${name} declares a typecheck script (so the root chain covers it)`,
    );
  }

  for (const expected of EXPECTED) check(byName.has(expected), `workspace ${expected} exists`);

  for (const app of ['@mapirror/api', '@mapirror/web']) {
    const dir = byName.get(app);
    if (!dir) continue;
    const manifest = readManifest(join(dir, 'package.json'));
    const dependency = manifest?.dependencies?.['@mapirror/shared'];
    check(
      dependency === 'workspace:*',
      `${app} depends on @mapirror/shared through the workspace protocol (found: ${dependency ?? 'nothing'})`,
    );
  }

  // Resolution is proved from a *consumer* (apps/api): the root has no dependency on the package, so
  // importing it there would test nothing but Node's directory walk.
  const apiDir = byName.get('@mapirror/api');
  if (apiDir) {
    try {
      const requireFromApi = createRequire(join(apiDir, 'package.json'));
      const resolved = requireFromApi.resolve('@mapirror/shared');
      check(
        resolve(resolved).startsWith(resolve(ROOT, 'packages/shared')),
        '@mapirror/shared resolves from apps/api into packages/shared (not a registry copy)',
      );
      const shared = (await import(resolved)) as Record<string, unknown>;
      check(typeof shared === 'object' && shared !== null, '@mapirror/shared imports cleanly');
    } catch (error) {
      failed.push(`@mapirror/shared does not resolve from apps/api: ${(error as Error).message}`);
    }
  }
}

try {
  await main();
} catch (error) {
  failed.push(`unexpected error: ${(error as Error).message}`);
}

for (const line of passed) console.log(`  ok   ${line}`);
for (const line of failed) console.error(`  FAIL ${line}`);

if (failed.length > 0) {
  console.error(`\n${failed.length} workspace check(s) failed.`);
  process.exit(1);
}
console.log(`\n${passed.length} workspace checks passed.`);
