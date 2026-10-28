import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import type { CatalogListItem, CatalogListResponse } from '@mapirror/shared';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };
const ME = { admin: PROFILE, expiresAt: '2026-10-26T21:00:00.000Z', lastUsedAt: null };
const CATALOG_SYNCED_AT = '2026-10-24T06:00:00.000Z';

/** A mounted app, unmounted after every test. */
const mounted: VueApp<Element>[] = [];

/** One row whose values exercise cache, update, exact bytes and ISO display. */
function catalogItem(index: number): CatalogListItem {
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
        cached: false,
        versionsReady: 0,
        totalSizeBytes: 0,
        isPublic: false,
        updateState: 'update_available',
        availableVersion: '261024',
        availableSizeBytes: 774_000_000,
      },
      lastSyncedAt: CATALOG_SYNCED_AT,
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
      sourceSizeHintBytes: 123_456_789,
      cache: {
        cached: true,
        versionsReady: 2,
        totalSizeBytes: '9007199254740993',
        isPublic: true,
        updateState: 'up_to_date',
        availableVersion: null,
        availableSizeBytes: null,
      },
      lastSyncedAt: CATALOG_SYNCED_AT,
    };
  }
  return {
    ...catalogItem(0),
    countryId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    sourceId: `europe/region-${String(index)}`,
    name: `Region ${String(index)}`,
    slug: `region-${String(index)}`,
  };
}

const TWO_ROWS: CatalogListResponse = {
  data: [catalogItem(0), catalogItem(1)],
  meta: { page: 1, limit: 50, total: 2, totalPages: 1 },
  catalogSyncedAt: CATALOG_SYNCED_AT,
};

const PAGE_ONE: CatalogListResponse = {
  data: Array.from({ length: 50 }, (_, index) => catalogItem(index)),
  meta: { page: 1, limit: 50, total: 120, totalPages: 3 },
  catalogSyncedAt: CATALOG_SYNCED_AT,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Router belonging to a mounted app. */
function routerOf(app: VueApp<Element>): Router {
  return (app.config.globalProperties as unknown as { $router: Router }).$router;
}

/** Mounts the real app at the catalog page, with an injectable fetch implementation. */
async function mountCatalog(
  fetchImpl: typeof fetch,
  query = '',
): Promise<{
  container: HTMLElement;
  router: Router;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_catalog_test');
  window.history.replaceState({}, '', `${adminPagePaths.catalog()}${query}`);
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

/** Fetch stub that records requests, answers `/me`, and delegates catalog results. */
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
      calls.filter((call) => call.url.pathname === '/_admin/api/catalog').length,
    );
  });
  Object.defineProperty(fetchMock, 'catalogCalls', { value: calls });
  return fetchMock;
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('admin catalog page', () => {
  it('loads the bookmarked search and presents the same data as a semantic table and responsive cards', async () => {
    const fetchMock = makeFetch((url) => {
      expect(url.pathname).toBe('/_admin/api/catalog');
      return jsonResponse(TWO_ROWS);
    });
    const { container } = await mountCatalog(fetchMock, '?q=finland');

    await vi.waitFor(() => expect(container.textContent).toContain('Finland'));
    expect(container.querySelector('h1')?.textContent).toBe('Catalog');
    expect(container.querySelector<HTMLInputElement>('form[role="search"] input')?.value).toBe(
      'finland',
    );
    expect(container.querySelector('table caption')?.textContent?.trim()).toBe(
      'Catalog regions and cache status',
    );
    expect(container.querySelectorAll('.mm-catalog-table tbody tr')).toHaveLength(2);
    expect(container.querySelectorAll('.mm-catalog-card')).toHaveLength(2);
    expect(container.textContent).toContain('Not cached');
    expect(container.textContent).toContain('Update available · 261024');
    expect(container.textContent).toContain('Cached · 2 ready versions');
    expect(container.textContent).toContain('8.0 PiB');
    expect(container.textContent).toContain('737.6 MiB');
    expect(container.textContent).toContain('UTC');

    const calls = (
      fetchMock as typeof fetchMock & { catalogCalls: { url: URL; init?: RequestInit }[] }
    ).catalogCalls;
    const catalogRequest = calls.find((call) => call.url.pathname === '/_admin/api/catalog');
    expect(catalogRequest?.url.searchParams.get('q')).toBe('finland');
    expect(catalogRequest?.url.searchParams.get('limit')).toBe('50');
    expect(new Headers(catalogRequest?.init?.headers).get('authorization')).toBe(
      'Bearer mm_catalog_test',
    );
  });

  it('keeps continent, cache, sort and pagination in the URL and sends only supported filters', async () => {
    const requested: URL[] = [];
    const fetchMock = makeFetch((url) => {
      requested.push(url);
      return jsonResponse(PAGE_ONE);
    });
    const { container, router } = await mountCatalog(fetchMock);

    await vi.waitFor(() => expect(container.textContent).toContain('Page 1 of 3'));
    expect(container.textContent).toContain('Showing 1–50 of 120 regions');

    const parentFilter = container.querySelector<HTMLInputElement>('#catalog-continent');
    expect(parentFilter).not.toBeNull();
    if (parentFilter === null) return;
    parentFilter.value = 'europe';
    parentFilter.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(router.currentRoute.value.query['continent']).toBe('europe'));
    await vi.waitFor(() =>
      expect(requested.some((url) => url.searchParams.get('continent') === 'europe')).toBe(true),
    );

    const cacheFilter = container.querySelector<HTMLSelectElement>('#catalog-cache');
    expect(cacheFilter).not.toBeNull();
    if (cacheFilter === null) return;
    cacheFilter.value = 'cached';
    cacheFilter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(router.currentRoute.value.query['cache']).toBe('cached'));
    await vi.waitFor(() =>
      expect(requested.some((url) => url.searchParams.get('cache') === 'cached')).toBe(true),
    );

    const sizeSort = [...container.querySelectorAll<HTMLButtonElement>('.mm-catalog-sort')].find(
      (button) => button.textContent?.includes('Source size'),
    );
    sizeSort?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query['sort']).toBe('size'));
    await vi.waitFor(() =>
      expect(requested.some((url) => url.searchParams.get('sort') === 'size')).toBe(true),
    );

    container.querySelector<HTMLButtonElement>('.mm-catalog-pagination button:last-child')?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query['page']).toBe('2'));
    await vi.waitFor(() =>
      expect(requested.some((url) => url.searchParams.get('page') === '2')).toBe(true),
    );
    expect(router.currentRoute.value.query['continent']).toBe('europe');
    expect(router.currentRoute.value.query['cache']).toBe('cached');
    expect(router.currentRoute.value.query['sort']).toBe('size');
  });

  it('shows a helpful empty state and clears all URL filters from its next action', async () => {
    const empty: CatalogListResponse = {
      data: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
      catalogSyncedAt: null,
    };
    const fetchMock = makeFetch(() => jsonResponse(empty));
    const { container, router } = await mountCatalog(
      fetchMock,
      '?q=not-a-region&continent=moon&cache=uncached',
    );

    await vi.waitFor(() => expect(container.textContent).toContain('No country matches'));
    expect(container.textContent).toContain('Try a different name or parent id');
    expect(container.querySelector('.mm-catalog-empty button')?.textContent).toContain(
      'Clear filters',
    );
    container.querySelector<HTMLButtonElement>('.mm-catalog-empty button')?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({}));
  });

  it('renders a stable loading skeleton, then a retryable error with request id', async () => {
    let settle: ((response: Response) => void) | undefined;
    let calls = 0;
    const fetchMock = makeFetch((url) => {
      if (url.pathname !== '/_admin/api/catalog') return jsonResponse(ME);
      calls += 1;
      if (calls === 1) return new Promise<Response>((resolve) => (settle = resolve));
      if (calls === 2)
        return jsonResponse(
          {
            error: {
              code: 'SOURCE_UNAVAILABLE',
              message: 'The catalog source could not be reached.',
              requestId: 'req-catalog-001',
            },
          },
          502,
        );
      return jsonResponse(TWO_ROWS);
    });
    const { container, router } = await mountCatalog(fetchMock);

    expect(container.querySelector('.mm-catalog-skeleton')).not.toBeNull();
    expect(container.querySelectorAll('.mm-catalog-skeleton-row')).toHaveLength(6);
    settle?.(jsonResponse(TWO_ROWS));
    await vi.waitFor(() => expect(container.textContent).toContain('Finland'));

    // Trigger a failure with a new route query, then verify the accessible alert and support id.
    await router.replace({ query: { continent: 'not-present' } });
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain('The catalog source could not be reached.');
    expect(container.textContent).toContain('req-catalog-001');

    container.querySelector<HTMLButtonElement>('.mm-catalog-error button')?.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Finland'));
    expect(calls).toBe(3);
  });

  it('uses cards below the documented responsive breakpoint and honors reduced motion', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/catalog.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 767px\)[\s\S]*?\.mm-catalog-table-wrap,[\s\S]*?display: none/u,
    );
    expect(css).toMatch(/\.mm-catalog-cards,[\s\S]*?display: flex/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
    expect(css).toMatch(/rgb\(var\(--v-theme-border-strong\)\)/u);
    expect(css).not.toMatch(/#[\da-f]{3,8}\b/iu);
  });
});
