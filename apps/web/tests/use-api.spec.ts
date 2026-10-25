import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, inject } from 'vue';

import { API_CLIENT_KEY, provideApiClient } from '../src/api';
import type { ApiClient } from '../src/api/client';
import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { MISSING_CLIENT_MESSAGE, useApi } from '../src/composables/useApi';

/**
 * `useApi()` and the provider (`P1-WEB-04`).
 *
 * The composable is one `inject`, so what there is to prove is the wiring around it: a component inside the app gets
 * the app's client, a component outside one gets a sentence it can act on, and `bootstrap.ts` really does provide the
 * **policy** client — the assertion that fails if that one line is ever dropped, which no other file would notice.
 */

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('a component inside an app', () => {
  it('gets the exact object the app provided, not a copy', () => {
    // A copy would still answer `get()`, and would silently drop the session-expiry callback that lives in the
    // original's closure — the reader would sit on an admin page that can only answer `401`.
    const provided = { marker: 'the one client' } as unknown as ApiClient;
    const app = createApp(defineComponent({ render: () => null }));
    provideApiClient(app, provided);

    expect(app.runWithContext(() => useApi())).toBe(provided);
  });

  it('provides under a symbol, so two copies of the module cannot collide', () => {
    expect(API_CLIENT_KEY.description).toBe('mapirror.api-client');
    expect(typeof API_CLIENT_KEY).toBe('symbol');
  });
});

describe('a component outside an app', () => {
  it('fails with a sentence that names the fix', () => {
    // The alternative is a screen whose every request goes to `undefined`, and whose failure starts with "Cannot read
    // properties of null (reading 'get')" in a file its author was not editing.
    expect(() => useApi()).toThrow(MISSING_CLIENT_MESSAGE);
    expect(MISSING_CLIENT_MESSAGE).toContain('provideApiClient()');
  });

  it('fails the same way in an app that forgot to provide one', () => {
    // The wiring mistake this actually happens through: an app assembled by hand (a component test, a future
    // micro-frontend) that installs Vuetify and Pinia but not the client. There is no fallback client to fall back to,
    // because a default would make the omission invisible until the first request needed a token.
    const app = createApp(defineComponent({ render: () => null }));

    expect(app.runWithContext(() => inject(API_CLIENT_KEY))).toBeUndefined();
    expect(() => app.runWithContext(() => useApi())).toThrow(MISSING_CLIENT_MESSAGE);
  });
});

describe('the app the browser gets', () => {
  it('provides a working client with no test wiring at all', () => {
    // `createWebApp()` is what `main.ts` mounts; `runWithContext` asks it what a component in its tree would inject.
    const client = createWebApp().runWithContext(() => useApi());

    for (const method of ['request', 'get', 'post', 'patch', 'put', 'delete'] as const) {
      expect(typeof client[method], method).toBe('function');
    }
  });

  it('provides the policy client, so a dead token signs the reader out', async () => {
    // `api/index.ts` (`createAppApiClient`) wraps `api/client.ts` and adds the sign-out policy. Both return the same
    // shape, so the only honest proof is behaviour: a `401 TOKEN_EXPIRED` through the client the app provides must
    // clear the stored token. With the plain factory it would not, and the reader would stay on an empty admin page.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED', message: 'No.' } }), {
          status: 401,
        }),
      ),
    );
    const app = createWebApp();
    const client = app.runWithContext(() => useApi());
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_stale');

    await client.get('/_admin/api/system/status').catch(() => undefined);

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});
