#!/usr/bin/env bun
/**
 * Verifies the Bun workspace skeleton (task `P1-REPO-01`).
 *
 * Checks, in order:
 * 1. every workspace listed in the root `package.json` exists and is `private`;
 * 2. the three expected workspaces are present, with the expected package names;
 * 3. both apps depend on `@mapirror/shared` through the `workspace:` protocol;
 * 4. `@mapirror/shared` resolves from `apps/api` into the local package (not a registry copy);
 * 5. no workspace name is duplicated.
 *
 * Run with `bun run check:workspaces`. Exits non-zero with a readable message on the first failure,
 * so it can gate CI without extra tooling.
 *
 * @module scripts/check-workspaces
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

/** Minimal shape of a `package.json` we care about here. */
interface Manifest {
  name?: string;
  private?: boolean;
  workspaces?: string[];
  dependencies?: Record<string, string>;
}

const failures: string[] = [];
const checks: string[] = [];

/**
 * Records the outcome of one assertion.
 *
 * @param condition - Whether the assertion holds.
 * @param message - Human-readable description, shown in both the pass and fail case.
 */
function check(condition: boolean, message: string): void {
  if (condition) {
    checks.push(message);
    return;
  }
  failures.push(message);
}

/**
 * Reads and parses a `package.json`.
 *
 * @param path - Absolute path to the file.
 * @returns The parsed manifest.
 * @throws If the file is missing or is not valid JSON.
 */
function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/**
 * Expands the simple `dir/*` workspace globs used by this repository.
 *
 * Deliberately tiny: the project only uses one-level globs (`apps/*`, `packages/*`), and adding a
 * glob dependency for that would violate L4 (stack law).
 *
 * @param globs - Workspace patterns from the root manifest.
 * @returns Absolute paths of directories that contain a `package.json`.
 */
function expandWorkspaces(globs: string[]): string[] {
  const dirs: string[] = [];
  for (const glob of globs) {
    if (!glob.endsWith('/*')) {
      throw new Error(`Unsupported workspace pattern "${glob}" — only one-level "dir/*" is supported.`);
    }
    const parent = join(ROOT, glob.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const dir = join(parent, entry);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs.sort();
}

const root = readManifest(join(ROOT, 'package.json'));
check(Array.isArray(root.workspaces) && root.workspaces.length > 0, 'root package.json declares workspaces');

const dirs = expandWorkspaces(root.workspaces ?? []);
const manifests = dirs.map((dir) => ({ dir, manifest: readManifest(join(dir, 'package.json')) }));

check(manifests.every(({ manifest }) => manifest.private === true), 'every workspace is private');

const byName = new Map<string, string>();
for (const { dir, manifest } of manifests) {
  const name = manifest.name;
  check(typeof name === 'string' && name.length > 0, `workspace ${dir.slice(ROOT.length + 1)} has a name`);
  if (!name) continue;
  if (byName.has(name)) failures.push(`duplicate workspace name "${name}"`);
  byName.set(name, dir);
}

for (const expected of ['@mapirror/api', '@mapirror/web', '@mapirror/shared']) {
  check(byName.has(expected), `workspace ${expected} exists`);
}

for (const app of ['@mapirror/api', '@mapirror/web']) {
  const dir = byName.get(app);
  if (!dir) continue;
  const manifest = readManifest(join(dir, 'package.json'));
  const dep = manifest.dependencies?.['@mapirror/shared'];
  check(
    dep === 'workspace:*',
    `${app} depends on @mapirror/shared through the workspace protocol (found: ${dep ?? 'nothing'})`,
  );
}

// Resolution is proved from a *consumer* (apps/api), not from the root: the root has no dependency on
// the package, so importing it there would test nothing but Node's directory walk.
try {
  const requireFromApi = createRequire(join(ROOT, 'apps/api/package.json'));
  const resolved = requireFromApi.resolve('@mapirror/shared');
  check(
    resolve(resolved).startsWith(resolve(ROOT, 'packages/shared')),
    '@mapirror/shared resolves from apps/api into packages/shared (not a registry copy)',
  );
  const shared = (await import(resolved)) as Record<string, unknown>;
  check(typeof shared === 'object' && shared !== null, '@mapirror/shared imports cleanly');
} catch (error) {
  failures.push(`@mapirror/shared does not resolve from apps/api: ${(error as Error).message}`);
}

for (const line of checks) console.log(`  ok   ${line}`);
for (const line of failures) console.error(`  FAIL ${line}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} workspace check(s) failed.`);
  process.exit(1);
}
console.log(`\n${checks.length} workspace checks passed (${manifests.length} workspaces).`);
