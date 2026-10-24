import { describe, expect, it } from 'vitest';

/**
 * Verifies the `web` Vitest project runs in a browser-like environment.
 *
 * The SPA depends on `sessionStorage` for the bearer token (D-13) and on `document` for mounting, so a
 * `web` project that quietly fell back to `node` would fail only when a component test is written. These
 * assertions fail immediately instead, at the point where the config is wrong.
 */
describe('web test project', () => {
  it('provides a DOM', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
    expect(document.createElement('div').tagName).toBe('DIV');
  });

  it('provides sessionStorage, which the auth store relies on', () => {
    expect(typeof sessionStorage).toBe('object');

    sessionStorage.setItem('mapirror:probe', 'ok');
    expect(sessionStorage.getItem('mapirror:probe')).toBe('ok');
    sessionStorage.removeItem('mapirror:probe');
    expect(sessionStorage.getItem('mapirror:probe')).toBeNull();
  });

  it('resolves @mapirror/shared from the workspace in a browser build context', async () => {
    const shared = await import('@mapirror/shared');

    expect(shared).toBeTypeOf('object');
  });
});
