import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import type { PublicCountriesResponse } from '@mapirror/shared';

import { createWebApp } from '../src/bootstrap';

const mounted: VueApp<Element>[] = [];

function country(overrides: Partial<PublicCountriesResponse['data'][number]> = {}) {
  return {
    slug: 'finland',
    name: 'Finland',
    continent: 'europe',
    iso: ['FI'],
    newestVersion: '261023',
    sizeBytes: 773_465_008,
    updatedAt: '2026-10-22T20:19:04.000Z',
    downloadUrl: '/_public/api/countries/finland/download?version=latest',
    ...overrides,
  };
}

function catalogResponse(
  data: PublicCountriesResponse['data'] = [country()],
  total = data.length,
  page = 1,
): PublicCountriesResponse {
  return {
    data,
    meta: { page, limit: 25, total, totalPages: Math.ceil(total / 25) },
    license: {
      name: 'ODbL 1.0',
      attribution: '© OpenStreetMap contributors',
      url: 'https://www.openstreetmap.org/copyright',
    },
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mountHome(
  respond: (url: URL, init: RequestInit | undefined) => Response | Promise<Response> = () =>
    jsonResponse(catalogResponse()),
  path = '/_site/',
): Promise<{
  app: VueApp<Element>;
  container: HTMLElement;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  window.history.replaceState({}, '', path);
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    return respond(new URL(requestUrl(input), 'http://mapirror.test'), init);
  });
  vi.stubGlobal('fetch', fetchMock);

  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  const router = (app.config.globalProperties as unknown as { $router: Router }).$router;
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return { app, container, fetchMock };
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('public home catalog', () => {
  it('loads public-safe cards, search controls and attribution from the public API', async () => {
    const second = country({
      slug: 'norway',
      name: 'Norway',
      continent: 'europe',
      iso: ['NO'],
      newestVersion: '261024',
      sizeBytes: '9007199254740993',
      updatedAt: null,
      downloadUrl: '/_public/api/countries/norway/download?version=latest',
    });
    const { container, fetchMock } = await mountHome(() =>
      jsonResponse(catalogResponse([country(), second])),
    );

    expect(container.querySelector('h1')?.textContent).toContain('Browse published maps');
    expect(container.querySelectorAll('.mm-public-country-card')).toHaveLength(2);
    expect(container.textContent).toContain('Finland');
    expect(container.textContent).toContain('Norway');
    expect(container.textContent).toContain('773.5 MB');
    expect(
      container.querySelector('[href="/_site/countries/norway"] dd[title]')?.getAttribute('title'),
    ).toBe('9007199254740993 bytes');
    expect(container.textContent).toContain('© OpenStreetMap contributors');
    expect(container.querySelector('.mm-public-country-card')?.getAttribute('href')).toBe(
      '/_site/countries/finland',
    );

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(requestUrl(input as RequestInfo | URL), 'http://mapirror.test');
    expect(url.pathname).toBe('/_public/api/countries');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('sort')).toBe('name');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(container.querySelector('.mdi')).toBeNull();
    const fontPreload = document.head.querySelector<HTMLLinkElement>('link[rel="preload"]');
    expect(fontPreload?.as).toBe('font');
    expect(fontPreload?.href).toContain('space-grotesk-latin-wght.woff2');
  });

  it('debounces search into the shareable URL and applies a continent chip filter', async () => {
    vi.useFakeTimers();
    const { container, fetchMock, app } = await mountHome();
    const router = (app.config.globalProperties as unknown as { $router: Router }).$router;
    const input = container.querySelector<HTMLInputElement>('#public-country-search');
    expect(input).not.toBeNull();

    input!.value = 'Finland';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.query.q).toBe('Finland');
    const searchCall = fetchMock.mock.calls
      .map(([request]) => new URL(requestUrl(request), 'http://mapirror.test'))
      .find((url) => url.searchParams.has('q'));
    expect(searchCall?.searchParams.get('q')).toBe('Finland');

    const europe = [
      ...container.querySelectorAll<HTMLButtonElement>('.mm-public-filter-chip'),
    ].find((button) => button.textContent?.trim() === 'Europe');
    expect(europe).toBeDefined();
    europe!.click();
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.query.continent).toBe('europe');
    const filteredCall = fetchMock.mock.calls
      .map(([request]) => new URL(requestUrl(request), 'http://mapirror.test'))
      .find((url) => url.searchParams.get('continent') === 'europe');
    expect(filteredCall?.searchParams.get('q')).toBe('Finland');
    expect(europe?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows an actionable empty state and retries the catalog', async () => {
    let calls = 0;
    const { container, fetchMock } = await mountHome(() => {
      calls += 1;
      return jsonResponse(catalogResponse([], 0));
    });

    expect(container.textContent).toContain('No maps published yet');
    const refresh = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Refresh catalog',
    );
    expect(refresh).toBeDefined();
    refresh!.click();
    await flushPromises();
    await flushPromises();
    expect(calls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an empty filtered search from an unpublished catalog', async () => {
    const { container, app } = await mountHome(
      () => jsonResponse(catalogResponse([], 0)),
      '/_site/?q=Atlantis&page=3',
    );
    const router = (app.config.globalProperties as unknown as { $router: Router }).$router;

    expect(container.textContent).toContain('No countries match these filters');
    expect(container.querySelector<HTMLInputElement>('#public-country-search')?.value).toBe(
      'Atlantis',
    );
    container.querySelector<HTMLButtonElement>('.mm-public-empty-action')?.click();
    await flushPromises();
    await flushPromises();
    expect(router.currentRoute.value.query.q).toBeUndefined();
    expect(router.currentRoute.value.query.page).toBeUndefined();
  });

  it('restores and changes the page from the shareable URL', async () => {
    const { container, app, fetchMock } = await mountHome((url) => {
      const page = Number(url.searchParams.get('page') ?? 1);
      return jsonResponse(catalogResponse([country()], 26, page));
    }, '/_site/?page=2');
    const router = (app.config.globalProperties as unknown as { $router: Router }).$router;

    expect(container.textContent).toContain('Page 2 of 2');
    const previous = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Previous',
    );
    previous?.click();
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.query.page).toBeUndefined();
    expect(container.textContent).toContain('Page 1 of 2');
    const requestedPages = fetchMock.mock.calls.map(([request]) =>
      new URL(requestUrl(request), 'http://mapirror.test').searchParams.get('page'),
    );
    expect(requestedPages).toEqual(['2', '1']);
  });

  it('retries a failed public request without losing the current URL state', async () => {
    let fail = true;
    const { container, fetchMock } = await mountHome((url) => {
      if (fail) throw new TypeError('offline');
      return jsonResponse(
        catalogResponse([country()], 1, Number(url.searchParams.get('page') ?? 1)),
      );
    }, '/_site/?q=Finland');

    expect(container.textContent).toContain('Catalog unavailable');
    expect(container.textContent).toContain('Retry');
    fail = false;
    container.querySelector<HTMLButtonElement>('.mm-public-retry')?.click();
    await flushPromises();
    await flushPromises();

    expect(container.textContent).toContain('Finland');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.location.search).toContain('q=Finland');
  });

  it('switches and remembers the public color theme without changing the admin policy', async () => {
    const { container } = await mountHome();
    const toggle = container.querySelector<HTMLButtonElement>('.mm-public-theme-toggle');
    expect(toggle?.textContent).toContain('Dark theme');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    toggle?.click();
    await flushPromises();
    expect(localStorage.getItem('mapirror.public-theme')).toBe('dark');
    expect(container.querySelector('.v-application')?.className).toContain('v-theme--dark');
    expect(toggle?.textContent).toContain('Light theme');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
  });
});
