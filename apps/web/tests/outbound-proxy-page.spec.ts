import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };
const ME = { admin: PROFILE, expiresAt: '2099-12-31T23:59:59.999Z', lastUsedAt: null };
const ENDPOINT = 'http://proxy.example.test:8080';
const HEALTH = {
  checkedAt: '2026-11-07T12:00:00.000Z',
  proxyUsed: true,
  endpoint: ENDPOINT,
  passed: true,
  checks: [
    ['geofabrik-index', 'Geofabrik catalog index', 'GET', 200, 'OK'],
    ['geofabrik-region-page', 'Geofabrik region page', 'GET', 200, 'OK'],
    ['geofabrik-pbf-head', 'Finland latest PBF metadata', 'HEAD', 200, 'OK'],
    ['geofabrik-md5', 'Finland latest MD5 sidecar', 'GET', 200, 'OK'],
    ['geofabrik-pbf-range', 'Finland latest PBF download route', 'GET', 206, 'Partial Content'],
  ].map(([id, label, method, status, statusText]) => ({
    id,
    label,
    method,
    url: `https://download.geofabrik.de/${id}`,
    status,
    statusText,
    expected: 'Expected status and validated source response',
    passed: true,
    reason: `HTTP ${String(status)} ${String(statusText)}; response validated.`,
    durationMs: 8,
  })),
};
const HEALTH_FAILURE = {
  ...HEALTH,
  passed: false,
  checks: HEALTH.checks.map((check, index) =>
    index === 0
      ? {
          ...check,
          status: 503,
          statusText: 'Service Unavailable',
          passed: false,
          reason: 'HTTP 503 Service Unavailable.',
        }
      : check,
  ),
};
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

async function mountProxy(
  fetchImpl: typeof fetch,
): Promise<{ app: VueApp<Element>; container: HTMLElement }> {
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_proxy_page_test');
  window.history.replaceState({}, '', adminPagePaths.proxy());
  vi.stubGlobal('fetch', fetchImpl);
  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  await routerOf(app).isReady();
  await flushPromises();
  await flushPromises();
  await vi.waitFor(() => expect(container.querySelector('#proxy-endpoint')).not.toBeNull());
  return { app, container };
}

async function setEndpoint(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[autocomplete="url"]');
  if (input === null) throw new Error('proxy endpoint field was not rendered');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

function button(container: HTMLElement, label: string): HTMLElement {
  const testId = label.includes('Test')
    ? 'proxy-check-button'
    : label.includes('Apply')
      ? 'proxy-apply-button'
      : 'proxy-remove-button';
  const match = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (match === null) throw new Error(`button not found: ${label}`);
  return match;
}

async function clickAndFlush(container: HTMLElement, label: string): Promise<void> {
  button(container, label).click();
  await flushPromises();
  await flushPromises();
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fetchRouter(
  options: {
    readonly initiallyConfigured?: boolean;
    readonly checkReport?: unknown;
    readonly applyReport?: unknown;
    readonly calls?: Array<{ method: string; path: string; body: string | null }>;
  } = {},
): typeof fetch {
  return vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    options.calls?.push({
      method,
      path: url.pathname,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
    if (url.pathname === '/_admin/api/network/proxy' && method === 'GET') {
      return Promise.resolve(
        jsonResponse({
          configured: options.initiallyConfigured ?? false,
          endpoint: options.initiallyConfigured ? ENDPOINT : null,
        }),
      );
    }
    if (url.pathname.endsWith('/check') && method === 'POST') {
      return Promise.resolve(jsonResponse(options.checkReport ?? HEALTH));
    }
    if (url.pathname === '/_admin/api/network/proxy' && method === 'PUT') {
      const health = options.applyReport ?? HEALTH;
      const applied = true;
      return Promise.resolve(
        jsonResponse({
          applied,
          configuration: applied
            ? { configured: true, endpoint: ENDPOINT }
            : {
                configured: options.initiallyConfigured ?? false,
                endpoint: options.initiallyConfigured ? ENDPOINT : null,
              },
          health,
        }),
      );
    }
    if (url.pathname === '/_admin/api/network/proxy' && method === 'DELETE') {
      return Promise.resolve(jsonResponse({ configured: false, endpoint: null }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe('admin outbound proxy screen', () => {
  it('loads current state, tests a draft, and renders each endpoint status and response reason', async () => {
    const calls: Array<{ method: string; path: string; body: string | null }> = [];
    const { container } = await mountProxy(fetchRouter({ calls }));
    expect(container.textContent).toContain('Outbound proxy');
    expect(container.textContent).toContain('No proxy is configured');
    await setEndpoint(container, ENDPOINT);
    await clickAndFlush(container, 'Test proxy');

    expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/check'))).toBe(true);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(container.textContent).toContain('External request checks');
    expect(container.textContent).toContain('Checks used a proxy endpoint');
    expect(container.textContent).toContain('HTTP status');
    expect(container.textContent).toContain('HTTP 206 Partial Content; response validated.');
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(5);
  });

  it('rejects malformed draft URLs in the UI without sending a health or apply request', async () => {
    const calls: Array<{ method: string; path: string; body: string | null }> = [];
    const { container } = await mountProxy(fetchRouter({ calls }));
    await setEndpoint(container, 'http://admin:secret@proxy.example.test:8080');
    await clickAndFlush(container, 'Test proxy');

    expect(container.textContent).toContain('Do not put credentials in the proxy URL');
    expect(calls.some((call) => call.path.endsWith('/check') || call.method === 'PUT')).toBe(false);
  });

  it('shows failed per-endpoint checks while keeping the explicitly applied proxy active', async () => {
    const calls: Array<{ method: string; path: string; body: string | null }> = [];
    const { container } = await mountProxy(fetchRouter({ applyReport: HEALTH_FAILURE, calls }));
    await setEndpoint(container, ENDPOINT);
    await clickAndFlush(container, 'Apply and check');

    expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    expect(container.textContent).toContain('HTTP 503 Service Unavailable.');
    expect(container.textContent).toContain(
      'Proxy is active, but one or more external checks failed. Review the results or remove the proxy.',
    );
    expect(container.textContent).toContain('A proxy is active');
  });

  it('applies a passing proxy and allows one-click removal back to direct outbound routing', async () => {
    const calls: Array<{ method: string; path: string; body: string | null }> = [];
    const { container } = await mountProxy(fetchRouter({ calls }));
    await setEndpoint(container, ENDPOINT);
    await clickAndFlush(container, 'Apply and check');

    expect(container.textContent).toContain('A proxy is active');
    expect(container.textContent).toContain(
      'Proxy is active and all external request checks passed.',
    );
    await clickAndFlush(container, 'Remove proxy');

    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    expect(container.textContent).toContain(
      'Proxy removed. New external requests will connect directly.',
    );
    expect(container.textContent).toContain('No proxy is configured');
    const removalStatus = [...container.querySelectorAll<HTMLElement>('[role="status"]')].find(
      (alert) => alert.textContent?.includes('Proxy removed') === true,
    );
    expect(removalStatus?.className).toContain('text-success');
  });
});
