import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const PROFILE = {
  id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607',
  username: 'admin',
};
const STATUS = {
  version: '0.2.0-dev',
  uptimeSeconds: 300,
  worker: { enabled: true, concurrency: 2, running: 0 },
  storage: {
    cacheDir: '/data/cache',
    usedBytes: 50_000,
    freeBytes: 100_000,
    reserveBytes: 20_000,
    state: 'ok',
    orphans: null,
  },
  counts: {
    countries: 24,
    cachedCountries: 4,
    publicCountries: 2,
    versions: 6,
    updatesAvailable: 5,
    jobsRunning: 0,
    jobsQueued: 0,
  },
  source: { id: 'geofabrik', lastSyncAt: '2026-10-31T09:00:00.000Z', reachable: true },
  branding: { displayName: 'MapMirror' },
};
const INTERVALS = { data: [] };
const mounted: VueApp<Element>[] = [];

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function requestPath(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.pathname;
  if (typeof input === 'string') return new URL(input, window.location.origin).pathname;
  return new URL(input.url, window.location.origin).pathname;
}

function routerOf(app: VueApp<Element>): Router {
  return (app.config.globalProperties as unknown as { $router: Router }).$router;
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('admin dashboard overview states', () => {
  it('keeps the successful widgets visible when one endpoint fails, then recovers on refresh', async () => {
    let statusCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      Promise.resolve().then(() => {
        const path = requestPath(input);
        if (path === '/_auth/api/me') {
          return jsonResponse({
            admin: PROFILE,
            expiresAt: '2026-10-31T13:00:00.000Z',
            lastUsedAt: null,
          });
        }
        if (path === '/_admin/api/system/status') {
          statusCalls += 1;
          return statusCalls === 1
            ? Promise.reject(new TypeError('network unavailable'))
            : jsonResponse(STATUS);
        }
        if (path === '/_admin/api/jobs') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 2, totalPages: 2 } });
        }
        if (path === '/_admin/api/intervals') return jsonResponse(INTERVALS);
        if (path === '/_admin/api/system/metrics') {
          return jsonResponse({ window: '1h', stepSeconds: 30, scope: 'container', samples: [] });
        }
        return jsonResponse({});
      }),
    );

    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_dashboard_status_test');
    window.history.replaceState({}, '', adminPagePaths.dashboard());
    vi.stubGlobal('fetch', fetchImpl);
    const app = createWebApp();
    mounted.push(app);
    const container = document.createElement('div');
    document.body.append(container);
    app.mount(container);
    await routerOf(app).isReady();
    await flushPromises();
    await flushPromises();

    expect(container.textContent).toContain('2 failed jobs');
    expect(container.textContent).toContain('Some dashboard data could not be refreshed');
    expect(container.textContent).toContain('System status: The server could not be reached.');
    expect(container.textContent).not.toMatch(/Screen S5|13-ui-ux\.md §4/u);
    const refreshButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Refresh overview'),
    );
    expect(refreshButton).toBeDefined();
    refreshButton?.click();
    await flushPromises();
    await flushPromises();

    expect(container.textContent).toContain('5');
    expect(container.textContent).toContain('4 cached · 2 public · 6 ready versions');
    expect(container.textContent).not.toContain('System status: The server could not be reached.');
    expect(statusCalls).toBe(2);
  });
});
