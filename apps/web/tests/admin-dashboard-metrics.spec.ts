import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import type { SystemMetricsResponse } from '@mapirror/shared';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const ME = {
  admin: { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' },
  expiresAt: '2026-10-31T13:00:00.000Z',
  lastUsedAt: null,
};
const mounted: VueApp<Element>[] = [];
const SYSTEM_STATUS = {
  version: '0.2.0-dev',
  uptimeSeconds: 600,
  worker: { enabled: true, concurrency: 4, running: 1 },
  storage: {
    cacheDir: '/data/cache',
    usedBytes: 5 * 1_073_741_824,
    freeBytes: 10 * 1_073_741_824,
    reserveBytes: 2 * 1_073_741_824,
    state: 'ok',
    orphans: null,
  },
  counts: {
    countries: 38,
    cachedCountries: 2,
    publicCountries: 1,
    versions: 3,
    updatesAvailable: 2,
    jobsRunning: 1,
    jobsQueued: 4,
  },
  source: { id: 'geofabrik', lastSyncAt: '2026-10-31T12:00:00.000Z', reachable: true },
  branding: { displayName: 'MapMirror' },
};
const INTERVALS = {
  data: [
    {
      id: 'a7c1df52-3620-4b6f-a86a-2f2d44115830',
      name: 'Nightly Finland refresh',
      frequency: 'daily',
      timeOfDay: '03:00',
      weekday: null,
      dayOfMonth: null,
      countries: [],
      keepVersions: 3,
      onlyIfChanged: true,
      enabled: true,
      nextRunAt: '2026-10-31T12:35:00.000Z',
      lastRun: null,
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:00:00.000Z',
    },
  ],
};

const metrics: SystemMetricsResponse = {
  window: '1h',
  stepSeconds: 30,
  scope: 'container',
  samples: [
    {
      t: '2026-10-31T12:34:00.000Z',
      cpuPercent: 12.5,
      load1: 0.4,
      load5: 0.3,
      load15: 0.2,
      memUsedBytes: 1_073_741_824,
      memTotalBytes: 4_294_967_296,
      diskUsedBytes: 5_368_709_120,
      diskTotalBytes: 10_737_418_240,
      cacheSizeBytes: 1_073_741_824,
    },
    {
      t: '2026-10-31T12:34:30.000Z',
      cpuPercent: 25.25,
      load1: 0.8,
      load5: 0.5,
      load15: 0.3,
      memUsedBytes: '2147483648',
      memTotalBytes: '4294967296',
      diskUsedBytes: '6442450944',
      diskTotalBytes: '10737418240',
      cacheSizeBytes: '2147483648',
    },
  ],
};

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

async function mountDashboard(
  fetchImpl: typeof fetch,
): Promise<{ app: VueApp<Element>; container: HTMLElement }> {
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_dashboard_test');
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
  return { app, container };
}

function responseFor(
  requests: URL[],
  metricsResponse: (window: string, call: number) => Response | Promise<Response>,
): typeof fetch {
  let metricsCalls = 0;
  return vi.fn<typeof fetch>((input) =>
    Promise.resolve().then(async () => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
      if (url.pathname === '/_admin/api/system/status') return jsonResponse(SYSTEM_STATUS);
      if (url.pathname === '/_admin/api/jobs') {
        return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 3, totalPages: 3 } });
      }
      if (url.pathname === '/_admin/api/intervals') return jsonResponse(INTERVALS);
      if (url.pathname === '/_admin/api/system/metrics') {
        metricsCalls += 1;
        return metricsResponse(url.searchParams.get('window') ?? '', metricsCalls);
      }
      return jsonResponse({});
    }),
  );
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin dashboard resource charts', () => {
  it('renders accessible charts, exact data alternatives, and requests the selected window', async () => {
    const requests: URL[] = [];
    const fetchImpl = responseFor(requests, (window) =>
      jsonResponse(window === '24h' ? { ...metrics, window: '24h', stepSeconds: 300 } : metrics),
    );
    const { container } = await mountDashboard(fetchImpl);

    expect(container.querySelector('h1')?.textContent).toBe('Dashboard');
    for (const title of [
      'CPU utilization',
      'Memory',
      'Cache-volume disk',
      'Cache growth',
      'Load average',
    ]) {
      expect(container.textContent).toContain(title);
    }
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(5);
    expect(container.querySelector('svg[aria-labelledby*="summary"]')).not.toBeNull();
    expect(container.textContent).toContain('2 GiB');
    expect(container.textContent).toContain('2 cached · 1 public · 3 ready versions');
    expect(container.textContent).toContain('1 running · 4 queued');
    expect(container.textContent).toContain('3 failed jobs');
    expect(container.textContent).toContain('8 GiB');
    expect(container.textContent).toContain('Nightly Finland refresh');
    expect(container.textContent).toContain('Last completed sync succeeded');

    const widgetLinks = [...container.querySelectorAll<HTMLAnchorElement>('.mm-dashboard-grid a')];
    expect(widgetLinks).toHaveLength(7);
    const widgetLink = (title: string): string | null =>
      widgetLinks.find((link) => link.textContent?.includes(title))?.getAttribute('href') ?? null;
    expect(widgetLink('Cached data (sampled)')).toBe(adminPagePaths.cache());
    expect(widgetLink('Catalog regions')).toBe(adminPagePaths.catalog());
    expect(widgetLink('Updates available')).toBe(`${adminPagePaths.cache()}?update=available`);
    expect(widgetLink('Jobs')).toBe(adminPagePaths.jobs());
    expect(widgetLink('Storage headroom')).toBe(adminPagePaths.system());
    expect(widgetLink('Next scheduled interval')).toBe(adminPagePaths.intervals());
    expect(widgetLink('Source sync freshness')).toBe(adminPagePaths.catalog());

    const dataDisclosure = container.querySelectorAll('details')[1];
    expect(dataDisclosure).not.toBeUndefined();
    if (dataDisclosure === undefined) return;
    dataDisclosure.open = true;
    dataDisclosure.dispatchEvent(new Event('toggle'));
    await flushPromises();
    expect(dataDisclosure.querySelector('table')?.textContent).toContain('2147483648');
    expect(dataDisclosure.querySelector('table')?.textContent).toContain(
      '2026-10-31T12:34:30.000Z',
    );

    const dayButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '24h',
    );
    expect(dayButton).not.toBeUndefined();
    dayButton?.click();
    await flushPromises();
    await flushPromises();
    expect(dayButton?.getAttribute('aria-pressed')).toBe('true');
    expect(
      requests.some(
        (url) =>
          url.pathname === '/_admin/api/system/metrics' && url.searchParams.get('window') === '24h',
      ),
    ).toBe(true);
  });

  it('shows the explicit sampling state when a window has no samples', async () => {
    const requests: URL[] = [];
    const fetchImpl = responseFor(requests, () =>
      jsonResponse({ window: '1h', stepSeconds: 30, scope: 'container', samples: [] }),
    );
    const { container } = await mountDashboard(fetchImpl);

    expect(container.querySelectorAll('.mm-metric-chart-empty')).toHaveLength(5);
    expect(container.textContent).toContain('No data yet — sampling…');
  });

  it('reports a retryable initial error and recovers on request', async () => {
    const requests: URL[] = [];
    const fetchImpl = responseFor(requests, (_window, call) =>
      call === 1 ? Promise.reject(new TypeError('network unavailable')) : jsonResponse(metrics),
    );
    const { container } = await mountDashboard(fetchImpl);

    expect(container.textContent).toContain('The server could not be reached.');
    const retryButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Retry',
    );
    expect(retryButton).not.toBeUndefined();
    retryButton?.click();
    await flushPromises();
    await flushPromises();
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(5);
    expect(container.textContent).not.toContain('Metrics could not be loaded.');
  });
});
