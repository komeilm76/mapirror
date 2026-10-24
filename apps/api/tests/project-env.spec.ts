import { describe, expect, it } from 'vitest';

/**
 * Verifies the `api` Vitest project: module resolution and runtime environment.
 *
 * These two assertions catch configuration mistakes that are invisible until much later — a test
 * project silently running in `jsdom` makes browser assumptions look safe on the server, and a
 * workspace package resolving from the registry instead of `packages/` breaks local development in a
 * way that type-checking alone cannot detect.
 *
 * The environment is probed through `globalThis` deliberately: this package compiles without the DOM
 * lib, so writing `window` here would need DOM types that the server must not have.
 */
describe('api test project', () => {
  it('resolves @mapirror/shared from the workspace', async () => {
    const shared = await import('@mapirror/shared');

    expect(shared).toBeTypeOf('object');
  });

  it('runs in a Node environment (no DOM globals)', () => {
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);
  });
});
