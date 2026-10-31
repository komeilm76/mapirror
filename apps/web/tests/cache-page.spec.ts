import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import type { CacheListItem, CacheListResponse } from '@mapirror/shared';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };
const ME = { admin: PROFILE, expiresAt: '2026-10-26T21:00:00.000Z', lastUsedAt: null };
const SYNCED_AT = '2026-10-24T06:00:00.000Z';
const DOWNLOAD_AT = '2026-10-23T20:20:51.000Z';
const mounted: VueApp<Element>[] = [];

/** Cache rows with contrasting cache/source sizes and public/update states. */
function cacheItem(index: number): CacheListItem {
  if (index === 0) {
    return {
      countryId: '00000000-0000-4000-8000-000000000001',
      sourceId: 'europe/finland',
      name: 'Finland',
      slug: 'finland',
      continent: 'europe',
      iso: ['FI'],
      sourceSizeHintBytes: 773_465_008,
      cache: {
        cached: true,
        versionsReady: 3,
        totalSizeBytes: '9007199254740993',
        isPublic: true,
        updateState: 'update_available',
        availableVersion: '261024',
        availableSizeBytes: 774_000_000,
      },
      lastSyncedAt: SYNCED_AT,
      lastCheckedAt: SYNCED_AT,
      createdAt: '2026-10-21T12:00:00.000Z',
      mostRecentDownloadAt: DOWNLOAD_AT,
    };
  }
  if (index === 1) {
    return {
      countryId: '00000000-0000-4000-8000-000000000002',
      sourceId: 'europe/sweden',
      name: 'Sweden',
      slug: 'sweden',
      continent: 'europe',
      iso: ['SE'],
      sourceSizeHintBytes: 10_000_000_000,
      cache: {
        cached: true,
        versionsReady: 1,
        totalSizeBytes: 1_234_567,
        isPublic: false,
        updateState: 'up_to_date',
        availableVersion: null,
        availableSizeBytes: null,
      },
      lastSyncedAt: SYNCED_AT,
      lastCheckedAt: null,
      createdAt: '2026-10-22T12:00:00.000Z',
      mostRecentDownloadAt: null,
    };
  }
  return {
    ...cacheItem(1),
    countryId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    sourceId: `europe/region-${String(index)}`,
    name: `Region ${String(index)}`,
    slug: `region-${String(index)}`,
  };
}

const TWO_ROWS: CacheListResponse = {
  data: [cacheItem(0), cacheItem(1)],
  meta: { page: 1, limit: 50, total: 2, totalPages: 1 },
};

const PAGE_ONE: CacheListResponse = {
  data: Array.from({ length: 50 }, (_, index) => cacheItem(index)),
  meta: { page: 1, limit: 50, total: 120, totalPages: 3 },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function routerOf(app: VueApp<Element>): Router {
  return (app.config.globalProperties as unknown as { $router: Router }).$router;
}

async function mountCache(
  fetchImpl: typeof fetch,
  query = '',
): Promise<{
  container: HTMLElement;
  router: Router;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_cache_test');
  window.history.replaceState({}, '', `${adminPagePaths.cache()}${query}`);
  vi.stubGlobal('fetch', fetchImpl);
  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  const router = routerOf(app);
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return { container, router, fetchMock: fetchImpl as ReturnType<typeof vi.fn<typeof fetch>> };
}

function makeFetch(
  respond: (url: URL, init: RequestInit | undefined, call: number) => Promise<Response> | Response,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, 'http://mapirror.test');
    calls.push({ url, init });
    if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
    return respond(
      url,
      init,
      calls.filter((call) => call.url.pathname === '/_admin/api/cache').length,
    );
  });
  Object.defineProperty(fetchMock, 'cacheCalls', { value: calls });
  return fetchMock;
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('admin cache page', () => {
  it('renders exact cached size, version count, visibility and update/download timestamps', async () => {
    const fetchMock = makeFetch((url) => {
      expect(url.pathname).toBe('/_admin/api/cache');
      return jsonResponse(TWO_ROWS);
    });
    const { container } = await mountCache(fetchMock, '?q=finland&update=available');

    await vi.waitFor(() => expect(container.textContent).toContain('Finland'));
    expect(container.querySelector('h1')?.textContent).toBe('Cached countries');
    expect(container.querySelectorAll('.mm-cache-table tbody tr')).toHaveLength(2);
    expect(container.querySelectorAll('.mm-cache-card')).toHaveLength(2);
    expect(
      [...container.querySelectorAll<HTMLAnchorElement>('a.mm-cache-name')].some(
        (link) => link.getAttribute('href') === adminPagePaths.cacheCountry(cacheItem(0).countryId),
      ),
    ).toBe(true);
    expect(container.textContent).toContain('8.0 PiB');
    expect(container.textContent).toContain('1.2 MiB');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('Public');
    expect(container.textContent).toContain('Private');
    expect(container.textContent).toContain('Update available · 261024');
    expect(container.textContent).toContain('23 Oct 2026');
    expect(container.textContent).toContain('Not available');
    expect(container.querySelectorAll('input[type="checkbox"], .v-switch')).toHaveLength(0);

    const calls = (
      fetchMock as typeof fetchMock & { cacheCalls: { url: URL; init?: RequestInit }[] }
    ).cacheCalls;
    const request = calls.find((call) => call.url.pathname === '/_admin/api/cache');
    expect(request?.url.searchParams.get('q')).toBe('finland');
    expect(request?.url.searchParams.get('update')).toBe('available');
    expect(request?.url.searchParams.get('limit')).toBe('50');
    expect(new Headers(request?.init?.headers).get('authorization')).toBe('Bearer mm_cache_test');
  });

  it('checks a cached country, reloads its persisted badge, and confirms a pinned update download', async () => {
    const countryId = cacheItem(1).countryId;
    const jobId = '00000000-0000-4000-8000-000000000099';
    const checkedAt = '2026-10-31T08:00:00.000Z';
    const updatedRow: CacheListItem = {
      ...cacheItem(1),
      lastCheckedAt: checkedAt,
      cache: {
        ...cacheItem(1).cache,
        updateState: 'update_available',
        availableVersion: '261031',
        availableSizeBytes: 2_097_152,
      },
    };
    let serverRows = TWO_ROWS;
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    const fetchMock = vi.fn<typeof fetch>((input, init) =>
      Promise.resolve().then(() => {
        const rawUrl =
          typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
        const url = new URL(rawUrl, 'http://mapirror.test');
        calls.push({ url, init });
        if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
        if (url.pathname === '/_admin/api/cache' && init?.method !== 'POST')
          return jsonResponse(serverRows);
        if (url.pathname === `/_admin/api/cache/${countryId}/check-update`) {
          serverRows = { ...TWO_ROWS, data: [cacheItem(0), updatedRow] };
          return jsonResponse({
            state: 'update_available',
            cached: {
              version: '261030',
              dataTimestamp: '2026-10-30T00:00:00.000Z',
              sizeBytes: 1_234_567,
            },
            source: {
              version: '261031',
              dataTimestamp: checkedAt,
              sizeBytes: 2_097_152,
            },
            checkedAt,
            reason: null,
          });
        }
        if (url.pathname === '/_admin/api/cache/downloads') {
          return jsonResponse({ jobId, resolvedVersion: '261031' }, 202);
        }
        if (url.pathname === `/_admin/api/jobs/${jobId}`) {
          return jsonResponse({
            id: jobId,
            type: 'download',
            status: 'queued',
            phase: null,
            progressBytes: 0,
            totalBytes: null,
            speedBps: null,
            etaSeconds: null,
            payload: { countryId, version: '261031' },
            updateCheckResult: null,
            cancelRequested: false,
            attempts: 0,
            maxAttempts: 3,
            createdAt: checkedAt,
            startedAt: null,
            finishedAt: null,
            error: null,
          });
        }
        if (url.pathname === '/_admin/api/jobs') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
        }
        return jsonResponse({});
      }),
    );

    const { container, router } = await mountCache(fetchMock);
    await vi.waitFor(() => expect(container.textContent).toContain('Sweden'));
    container
      .querySelector<HTMLButtonElement>(`button[aria-label="Check for update for Sweden"]`)
      ?.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Update available · 261031'));
    expect(
      container
        .querySelectorAll('.mm-cache-cards .mm-cache-card')[1]
        ?.querySelector('.mm-cache-pill-update')?.textContent,
    ).toContain('Update available · 261031');
    expect(
      calls.some((call) => call.url.pathname === `/_admin/api/cache/${countryId}/check-update`),
    ).toBe(true);

    await router.replace(adminPagePaths.jobs());
    await router.replace(adminPagePaths.cache());
    await vi.waitFor(() => expect(container.textContent).toContain('Update available · 261031'));
    expect(container.textContent).toContain('31 Oct 2026');

    container.querySelector<HTMLButtonElement>('button[aria-label="Update Sweden"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Version retention'));
    expect(document.body.textContent).toContain('About 2.0 MiB');
    expect(document.body.textContent).toContain('About 3.2 MiB');
    expect(document.body.textContent).toContain('Existing ready versions are kept');
    [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Queue update'))
      ?.click();
    await vi.waitFor(() => expect(container.textContent).toContain(`Update queued. Job ${jobId}`));
    const downloadCall = calls.find((call) => call.url.pathname === '/_admin/api/cache/downloads');
    expect(downloadCall?.init?.method).toBe('POST');
    expect(downloadCall?.init?.body).toBe(JSON.stringify({ countryId, version: '261031' }));
  });

  it('queues a bulk update check and tracks the returned job in the shell drawer', async () => {
    const jobId = '00000000-0000-4000-8000-000000000088';
    const createdAt = '2026-10-31T08:00:00.000Z';
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    const fetchMock = vi.fn<typeof fetch>((input, init) =>
      Promise.resolve().then(() => {
        const rawUrl =
          typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
        const url = new URL(rawUrl, 'http://mapirror.test');
        calls.push({ url, init });
        if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
        if (url.pathname === '/_admin/api/cache' && init?.method !== 'POST')
          return jsonResponse(TWO_ROWS);
        if (url.pathname === '/_admin/api/cache/check-updates') return jsonResponse({ jobId }, 202);
        if (url.pathname === `/_admin/api/jobs/${jobId}`) {
          return jsonResponse({
            id: jobId,
            type: 'update_check',
            status: 'queued',
            phase: null,
            progressBytes: 0,
            totalBytes: null,
            speedBps: null,
            etaSeconds: null,
            payload: {},
            updateCheckResult: null,
            cancelRequested: false,
            attempts: 0,
            maxAttempts: 3,
            createdAt,
            startedAt: null,
            finishedAt: null,
            error: null,
          });
        }
        if (url.pathname === '/_admin/api/jobs') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
        }
        return jsonResponse({});
      }),
    );
    const { container } = await mountCache(fetchMock);

    await vi.waitFor(() => expect(container.textContent).toContain('Sweden'));
    container.querySelector<HTMLButtonElement>('.mm-cache-page-actions button')?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain(`Bulk update check submitted. Job ${jobId}`),
    );

    const request = calls.find((call) => call.url.pathname === '/_admin/api/cache/check-updates');
    expect(request?.init?.method).toBe('POST');
    expect(request?.init?.body).toBe('{}');
    expect(
      container
        .querySelector<HTMLButtonElement>('button[aria-controls="mm-job-progress-drawer"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('keeps search, update filter, supported sorting and pagination bookmarkable', async () => {
    const requested: URL[] = [];
    const fetchMock = makeFetch((url) => {
      requested.push(url);
      return jsonResponse(PAGE_ONE);
    });
    const { container, router } = await mountCache(fetchMock);

    await vi.waitFor(() => expect(container.textContent).toContain('Page 1 of 3'));
    const sizeSort = [...container.querySelectorAll<HTMLButtonElement>('.mm-cache-sort')].find(
      (button) => button.textContent?.includes('Cache size'),
    );
    sizeSort?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query.sort).toBe('size'));
    await vi.waitFor(() =>
      expect(requested.some((url) => url.searchParams.get('sort') === 'size')).toBe(true),
    );
    sizeSort?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query.order).toBe('desc'));

    const updateFilter = container.querySelector<HTMLSelectElement>('#cache-update-filter');
    expect(updateFilter).not.toBeNull();
    if (updateFilter === null) return;
    updateFilter.value = 'available';
    updateFilter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(router.currentRoute.value.query.update).toBe('available'));
    await vi.waitFor(() =>
      expect(requested.some((url) => url.searchParams.get('update') === 'available')).toBe(true),
    );

    const search = container.querySelector<HTMLInputElement>('#cache-search');
    expect(search).not.toBeNull();
    if (search === null) return;
    search.value = 'europe';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(router.currentRoute.value.query.q).toBe('europe'));
    await vi.waitFor(() =>
      expect(requested.some((url) => url.searchParams.get('q') === 'europe')).toBe(true),
    );

    container.querySelector<HTMLButtonElement>('.mm-cache-pagination button:last-child')?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query.page).toBe('2'));
    expect(router.currentRoute.value.query.sort).toBe('size');
    expect(router.currentRoute.value.query.order).toBe('desc');
    expect(router.currentRoute.value.query.update).toBe('available');
    expect(router.currentRoute.value.query.q).toBe('europe');
  });

  it('rejects a malformed cache response instead of rendering unchecked data', async () => {
    const fetchMock = makeFetch(() => jsonResponse({ data: 'not-an-array', meta: {} }));
    const { container } = await mountCache(fetchMock);

    await vi.waitFor(() =>
      expect(container.textContent).toContain('The cached-country response could not be read.'),
    );
    expect(container.querySelector('.mm-cache-error')).not.toBeNull();
    expect(container.textContent).not.toContain('not-an-array');
  });

  it('offers the catalog as the next step when the cache is empty and clears query filters otherwise', async () => {
    const empty: CacheListResponse = {
      data: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
    };
    const fetchMock = makeFetch(() => jsonResponse(empty));
    const { container, router } = await mountCache(fetchMock);

    await vi.waitFor(() => expect(container.textContent).toContain('Nothing cached yet'));
    const browse = container.querySelector<HTMLAnchorElement>('.mm-cache-empty a');
    expect(browse?.getAttribute('href')).toBe(adminPagePaths.catalog());

    await router.replace({ query: { q: 'moon' } });
    await vi.waitFor(() => expect(container.textContent).toContain('No cached country matches'));
    container.querySelector<HTMLButtonElement>('.mm-cache-empty button')?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({}));
  });

  it('shows a loading skeleton and a retryable error with its request id', async () => {
    let settle: ((response: Response) => void) | undefined;
    let requests = 0;
    const fetchMock = makeFetch((url) => {
      if (url.pathname !== '/_admin/api/cache') return jsonResponse(ME);
      requests += 1;
      if (requests === 1) return new Promise<Response>((resolve) => (settle = resolve));
      if (requests === 2)
        return jsonResponse(
          {
            error: {
              code: 'DB_UNAVAILABLE',
              message: 'The cache service is temporarily unavailable.',
              requestId: 'req-cache-001',
            },
          },
          503,
        );
      return jsonResponse(TWO_ROWS);
    });
    const { container, router } = await mountCache(fetchMock);

    expect(container.querySelector('.mm-cache-skeleton')).not.toBeNull();
    expect(container.querySelectorAll('.mm-cache-skeleton-row')).toHaveLength(5);
    settle?.(jsonResponse(TWO_ROWS));
    await vi.waitFor(() => expect(container.textContent).toContain('Finland'));
    await router.replace({ query: { q: 'retry' } });
    await vi.waitFor(() => expect(requests).toBe(2));
    await vi.waitFor(() => expect(container.textContent).toContain('req-cache-001'));
    expect(container.textContent).toContain('The cache service is temporarily unavailable.');
    container.querySelector<HTMLButtonElement>('.mm-cache-error button')?.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Finland'));
    expect(requests).toBe(3);
  });

  it('uses mobile cards below 768 px and honors reduced motion', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/cache.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 767px\)[\s\S]*?\.mm-cache-table-wrap,[\s\S]*?display: none/u,
    );
    expect(css).toMatch(/\.mm-cache-cards,[\s\S]*?display: flex/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
    expect(css).toMatch(/rgb\(var\(--v-theme-border-strong\)\)/u);
    expect(css).not.toMatch(/#[\da-f]{3,8}\b/iu);
  });
});
