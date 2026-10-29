import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import type { PublicCountryDetailResponse, PublicCountryVersionsResponse } from '@mapirror/shared';

import { createWebApp } from '../src/bootstrap';

const mounted: VueApp<Element>[] = [];
const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
type PublicCountryVersion = PublicCountryDetailResponse['versions'][number];

function version(overrides: Partial<PublicCountryVersion> = {}): PublicCountryVersion {
  return {
    version: '261023',
    dataTimestamp: '2026-10-22T20:19:04.000Z',
    sizeBytes: 773_465_008,
    checksumMd5: MD5,
    downloadUrl: '/_public/api/countries/finland/download?version=261023',
    isLatest: true,
    ...overrides,
  };
}

function detailResponse(
  overrides: Partial<PublicCountryDetailResponse> = {},
): PublicCountryDetailResponse {
  return {
    slug: 'finland',
    name: 'Finland',
    iso: ['FI'],
    versions: [version()],
    latest: '261023',
    updatedAt: '2026-10-22T20:19:04.000Z',
    license: {
      name: 'ODbL 1.0',
      attribution: '© OpenStreetMap contributors',
      url: 'https://www.openstreetmap.org/copyright',
      source: 'Geofabrik GmbH',
      sourceUrl: 'https://download.geofabrik.de',
    },
    ...overrides,
  };
}

function versionsResponse(
  data: PublicCountryVersion[] = [version()],
  total = data.length,
  page = 1,
): PublicCountryVersionsResponse {
  return {
    data,
    meta: { page, limit: 25, total, totalPages: Math.ceil(total / 25) },
    license: {
      name: 'ODbL 1.0',
      attribution: '© OpenStreetMap contributors',
      url: 'https://www.openstreetmap.org/copyright',
      source: 'Geofabrik GmbH',
      sourceUrl: 'https://download.geofabrik.de',
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

async function mountDetail(
  respond: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
  path = '/_site/countries/finland',
): Promise<{
  app: VueApp<Element>;
  container: HTMLElement;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  window.history.replaceState({}, '', path);
  const fetchMock = vi.fn<typeof fetch>((input, init) =>
    Promise.resolve(respond(new URL(requestUrl(input), 'http://mapirror.test'), init)),
  );
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

describe('public country detail', () => {
  it('shows country identity, latest metadata, version history and both required attributions', async () => {
    const checksumless = version({
      version: '261001',
      dataTimestamp: null,
      sizeBytes: '9007199254740993',
      checksumMd5: null,
      downloadUrl: '/_public/api/countries/finland/download?version=261001',
      isLatest: false,
    });
    const { container, fetchMock } = await mountDetail((url) =>
      url.pathname.endsWith('/versions')
        ? jsonResponse(versionsResponse([version(), checksumless], 2))
        : jsonResponse(detailResponse()),
    );

    expect(container.querySelector('h1')?.textContent).toBe('Finland');
    expect(container.querySelector('.mm-public-flag')?.textContent).toBe('🇫🇮');
    expect(container.querySelector('.mm-public-iso-list')?.getAttribute('role')).toBe('group');
    expect(container.querySelector('.mm-public-iso-list')?.getAttribute('aria-label')).toBe(
      'ISO country codes',
    );
    expect(container.querySelector('caption.mm-sr-only')?.textContent).toContain('Finland');
    expect(container.textContent).toContain('261023');
    expect(container.textContent).toContain('773.5 MB');
    expect(container.textContent).toContain(MD5);
    expect(container.textContent).toContain('9.0 PB');
    expect(
      container.querySelector('tbody tr:last-child td[data-label="Size"]')?.getAttribute('title'),
    ).toBe('9007199254740993 bytes');
    expect(container.textContent).toContain('Date unavailable');
    expect(container.textContent).toContain('Latest');
    expect(container.textContent).toContain('© OpenStreetMap contributors');
    expect(container.textContent).toContain('Geofabrik GmbH');
    expect(
      container.querySelector<HTMLAnchorElement>('.mm-public-download-link')?.getAttribute('href'),
    ).toBe('/_public/api/countries/finland/download?version=261023');
    expect(
      [...container.querySelectorAll<HTMLAnchorElement>('.mm-public-license a')].map((link) =>
        link.getAttribute('href'),
      ),
    ).toEqual(['https://www.openstreetmap.org/copyright', 'https://download.geofabrik.de']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  });

  it('restores and updates the shareable version-history page', async () => {
    const { app, container, fetchMock } = await mountDetail((url) => {
      if (!url.pathname.endsWith('/versions')) return jsonResponse(detailResponse());
      const page = Number(url.searchParams.get('page') ?? 1);
      return jsonResponse(
        versionsResponse(
          [version({ version: page === 1 ? '261023' : '260101', isLatest: page === 1 })],
          26,
          page,
        ),
      );
    }, '/_site/countries/finland?page=2');
    const router = (app.config.globalProperties as unknown as { $router: Router }).$router;

    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.textContent).toContain('260101');
    container.querySelector<HTMLButtonElement>('.mm-public-pagination-button')?.click();
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.query.page).toBeUndefined();
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.textContent).toContain('261023');
    const requests = fetchMock.mock.calls.map(
      ([request]) => new URL(requestUrl(request), 'http://mapirror.test'),
    );
    expect(requests.map((url) => url.pathname)).toEqual([
      '/_public/api/countries/finland',
      '/_public/api/countries/finland/versions',
      '/_public/api/countries/finland/versions',
    ]);
    expect(requests.map((url) => url.searchParams.get('page'))).toEqual([null, '2', '1']);
  });

  it('does not reveal unpublished country existence on the detail route', async () => {
    const { container, fetchMock } = await mountDetail(() =>
      jsonResponse(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'The requested public country does not exist.',
            requestId: 'f51a010a-9f95-4e21-9ea7-67134ed4267f',
          },
        },
        404,
      ),
    );

    expect(container.textContent).toContain('Country unavailable');
    expect(container.textContent).toContain('This country is not available to the public.');
    expect(container.textContent).not.toContain('unpublished');
    expect(container.textContent).toContain('Request ID: f51a010a-9f95-4e21-9ea7-67134ed4267f');
    expect(container.querySelector<HTMLButtonElement>('.mm-public-retry')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a failed version-history request without refetching or losing country details', async () => {
    let versionsCalls = 0;
    const { container, fetchMock } = await mountDetail((url) => {
      if (!url.pathname.endsWith('/versions')) return jsonResponse(detailResponse());
      versionsCalls += 1;
      if (versionsCalls === 1) throw new TypeError('offline');
      return jsonResponse(versionsResponse());
    });

    expect(container.querySelector('h1')?.textContent).toBe('Finland');
    expect(container.textContent).toContain('Version history unavailable');
    container.querySelector<HTMLButtonElement>('.mm-public-retry')?.click();
    await flushPromises();
    await flushPromises();

    expect(container.textContent).toContain('Ready versions');
    expect(container.textContent).toContain('261023');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(versionsCalls).toBe(2);
  });
});
