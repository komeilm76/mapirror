/**
 * The Vitest project table (task `P1-REPO-04`).
 *
 * This module exists because the project list is asserted from two places: `vitest.config.ts` builds
 * the config from it, and `scripts/check-hygiene.ts` proves that **every** test file in the repository
 * is collected by one of these roots. Keeping the list here means the two can never disagree — and a
 * test file that no project would collect is exactly the bug this prevents: a failing `*.test.ts` in
 * `apps/api/tests` was silently skipped for as long as only `*.spec.ts` was configured.
 *
 * Suffixes: both `*.spec.ts` and `*.test.ts` are collected. The specification names the route-law
 * tests `law-routes.test.ts` / `law-router.test.ts` (see `docs/10-laws.md`), while the first tests
 * written were `*.spec.ts`; accepting both means neither document nor code has to be "wrong", and no
 * test can be skipped because of its file name.
 *
 * @module vitest.projects
 */

/** Test-file globs, relative to a project root. Both suffixes, on purpose. */
export const TEST_INCLUDE = ['tests/**/*.{spec,test}.ts'] as const;

/** Environment a project's tests run in. */
export type TestEnvironment = 'node' | 'jsdom';

/** One Vitest project. */
export interface TestProject {
  /** Project name, used by `--project` and in the reporter. */
  readonly name: string;
  /** Project root, relative to the repository root and always `./`-prefixed. */
  readonly root: string;
  /** Execution environment. */
  readonly environment: TestEnvironment;
}

/**
 * Every project, in run order.
 *
 * `shared` and `api` run in Node because a DOM would hide accidental browser assumptions; `web` needs
 * jsdom for `document`, `sessionStorage` and mounted components; `scripts` covers the operator CLI.
 */
export const TEST_PROJECTS: readonly TestProject[] = [
  { name: 'shared', root: './packages/shared', environment: 'node' },
  { name: 'api', root: './apps/api', environment: 'node' },
  { name: 'web', root: './apps/web', environment: 'jsdom' },
  { name: 'scripts', root: './scripts', environment: 'node' },
];
