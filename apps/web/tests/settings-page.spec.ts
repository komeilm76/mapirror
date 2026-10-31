import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };
const ME = { admin: PROFILE, expiresAt: '2099-12-31T23:59:59.999Z', lastUsedAt: null };
const SETTINGS = {
  branding: { displayName: 'MapMirror' },
  cache: { keepVersions: 3, diskReserveBytes: 2_147_483_648 },
  public: { downloadsPerMinute: 10 },
  source: { catalogTtlMinutes: 360 },
};
const SETTINGS_RESPONSE = { settings: SETTINGS };
const mounted: VueApp<Element>[] = [];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return new URL(input.href, window.location.origin);
  if (typeof input === 'string') return new URL(input, window.location.origin);
  return new URL(input.url, window.location.origin);
}

function routerOf(app: VueApp<Element>): Router {
  return (app.config.globalProperties as unknown as { $router: Router }).$router;
}

async function mountSettings(
  fetchImpl: typeof fetch,
): Promise<{ app: VueApp<Element>; container: HTMLElement }> {
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_settings_test');
  window.history.replaceState({}, '', adminPagePaths.settings());
  vi.stubGlobal('fetch', fetchImpl);
  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  await routerOf(app).isReady();
  await flushPromises();
  await flushPromises();
  return { app, container };
}

function submit(container: HTMLElement): void {
  const form = container.querySelector<HTMLFormElement>('form.mm-settings-form');
  if (form === null) throw new Error('settings form was not rendered');
  form.requestSubmit();
}

function editInput(container: HTMLElement, id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (input === null) throw new Error(`missing input ${id}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin settings screen', () => {
  it('loads validated values into labeled fields and shows the default retention and limits', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      calls.push(url.pathname);
      if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
      if (url.pathname === '/_admin/api/settings')
        return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
      return Promise.resolve(jsonResponse({}));
    });

    const { container } = await mountSettings(fetchImpl);

    expect(container.querySelector('h1')?.textContent).toBe('Settings');
    expect(container.querySelector<HTMLInputElement>('#settings-displayName')?.value).toBe(
      'MapMirror',
    );
    expect(container.querySelector<HTMLInputElement>('#settings-keepVersions')?.value).toBe('3');
    expect(container.querySelector<HTMLInputElement>('#settings-diskReserveBytes')?.value).toBe(
      '2147483648',
    );
    expect(container.querySelector<HTMLInputElement>('#settings-downloadsPerMinute')?.value).toBe(
      '10',
    );
    expect(container.querySelector<HTMLInputElement>('#settings-catalogTtlMinutes')?.value).toBe(
      '360',
    );
    expect(container.querySelector('label[for="settings-displayName"]')).not.toBeNull();
    expect(calls).toContain('/_admin/api/settings');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
  });

  it('normalizes whitespace-only edits back to the saved value without sending an empty PATCH', async () => {
    const settingsCalls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
      if (url.pathname === '/_admin/api/settings') {
        settingsCalls.push('GET');
        return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
      }
      return Promise.resolve(jsonResponse({}));
    });
    const { container } = await mountSettings(fetchImpl);

    editInput(container, 'settings-displayName', '  MapMirror  ');
    submit(container);
    await flushPromises();

    expect(settingsCalls).toEqual(['GET']);
    expect(container.querySelector<HTMLInputElement>('#settings-displayName')?.value).toBe(
      'MapMirror',
    );
    expect(container.textContent).not.toContain('Review the highlighted settings');
  });

  it('validates the whole form before sending a PATCH and focuses the invalid field', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      calls.push({ path: url.pathname, method: init?.method ?? 'GET' });
      if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
      if (url.pathname === '/_admin/api/settings')
        return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
      return Promise.resolve(jsonResponse({}));
    });
    const { container } = await mountSettings(fetchImpl);

    editInput(container, 'settings-keepVersions', '11');
    editInput(container, 'settings-downloadsPerMinute', '0');
    container
      .querySelector<HTMLInputElement>('#settings-keepVersions')
      ?.dispatchEvent(new Event('blur'));
    container
      .querySelector<HTMLInputElement>('#settings-downloadsPerMinute')
      ?.dispatchEvent(new Event('blur'));
    await flushPromises();
    expect(container.textContent).toContain('2 settings need attention.');
    submit(container);
    await flushPromises();

    expect(container.textContent).toContain('Choose a whole number from 1 to 10 versions.');
    expect(
      container
        .querySelector<HTMLInputElement>('#settings-keepVersions')
        ?.getAttribute('aria-invalid'),
    ).toBe('true');
    expect(document.activeElement?.id).toBe('settings-keepVersions');
    expect(
      calls.filter((call) => call.path === '/_admin/api/settings' && call.method === 'PATCH'),
    ).toEqual([]);
  });

  it('saves only changed values and adopts the validated server response', async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    const updated = {
      ...SETTINGS,
      branding: { displayName: 'North Mirror' },
    };
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
      if (url.pathname === '/_admin/api/settings') {
        const method = init?.method ?? 'GET';
        calls.push({
          method,
          ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
        });
        return Promise.resolve(
          jsonResponse(method === 'PATCH' ? { settings: updated } : SETTINGS_RESPONSE),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    const { container } = await mountSettings(fetchImpl);

    editInput(container, 'settings-displayName', ' North Mirror ');
    submit(container);
    await flushPromises();
    await flushPromises();

    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      branding: { displayName: 'North Mirror' },
    });
    expect(container.querySelector<HTMLInputElement>('#settings-displayName')?.value).toBe(
      'North Mirror',
    );
    expect(container.textContent).toContain('Settings saved.');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
  });

  it('rolls back the optimistic snapshot on failure while preserving the draft and request id', async () => {
    let settleFirstPatch!: (response: Response) => void;
    let firstPatch = true;
    const pendingPatch = new Promise<Response>((resolve) => {
      settleFirstPatch = resolve;
    });
    const failureResponse = new Response(
      JSON.stringify({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Settings could not be saved right now.',
          requestId: 'req-settings-save',
        },
      }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-settings-save',
        },
      },
    );
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
      if (url.pathname === '/_admin/api/settings' && init?.method === 'PATCH' && firstPatch) {
        firstPatch = false;
        return pendingPatch;
      }
      if (url.pathname === '/_admin/api/settings')
        return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
      return Promise.resolve(jsonResponse({}));
    });
    const { container } = await mountSettings(fetchImpl);

    editInput(container, 'settings-displayName', 'Uncommitted name');
    submit(container);
    await flushPromises();
    expect(container.textContent).toContain('Saving settings…');
    expect(container.textContent).not.toContain('Unsaved changes');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );

    settleFirstPatch(failureResponse);
    await flushPromises();
    await flushPromises();

    expect(container.querySelector<HTMLInputElement>('#settings-displayName')?.value).toBe(
      'Uncommitted name',
    );
    expect(container.textContent).toContain('Settings could not be saved right now.');
    expect(container.textContent).toContain('Request ID: req-settings-save');
    expect(container.textContent).toContain('Your edits are still in the form.');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      false,
    );

    // Retry uses the retained draft; the server response is authoritative after success.
    submit(container);
    await flushPromises();
    await flushPromises();
    expect(container.textContent).toContain('Settings saved.');
  });

  it('recovers from a failed initial load through the retry action', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
      if (url.pathname === '/_admin/api/settings') {
        attempts += 1;
        return attempts === 1
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  error: {
                    code: 'SERVICE_UNAVAILABLE',
                    message: 'The settings service is unavailable.',
                    requestId: 'req-settings-load',
                  },
                }),
                {
                  status: 503,
                  headers: {
                    'content-type': 'application/json',
                    'x-request-id': 'req-settings-load',
                  },
                },
              ),
            )
          : Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
      }
      return Promise.resolve(jsonResponse({}));
    });
    const { container } = await mountSettings(fetchImpl);

    expect(container.textContent).toContain('Settings could not be loaded');
    expect(container.textContent).toContain('Request ID: req-settings-load');
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry')
      ?.click();
    await flushPromises();
    await flushPromises();

    expect(container.querySelector('form.mm-settings-form')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('#settings-displayName')?.value).toBe(
      'MapMirror',
    );
    expect(attempts).toBe(2);
  });
});
