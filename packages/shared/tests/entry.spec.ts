import { describe, expect, it } from 'vitest';

/**
 * Verifies that `@mapirror/shared` resolves and loads **under Vitest**, not only under `tsc`.
 *
 * This is intentionally a tooling test rather than a behaviour test: it pins the contract that
 * `scripts/check-workspaces.ts` cannot see — that the test runner resolves workspace packages through
 * the package `exports` map. When real schemas land (`P1-REPO-07`), their behaviour tests join this
 * file's folder and this one keeps guarding the wiring.
 */
describe('@mapirror/shared entry point', () => {
  it('is importable through the package name', async () => {
    const shared = await import('@mapirror/shared');

    expect(shared).toBeTypeOf('object');
    expect(shared).not.toBeNull();
  });

  it('runs without a DOM, because it is also bundled for the browser', async () => {
    // A module in `shared` that touches `window` at import time would crash the SPA before Vue mounts,
    // yet pass a Node-only test suite. This asserts the module graph stays environment-agnostic.
    expect(typeof globalThis).toBe('object');
    const shared = await import('@mapirror/shared');
    expect(shared).toBeDefined();
  });
});
