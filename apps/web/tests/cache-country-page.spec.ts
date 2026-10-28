import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import type {
  CacheDetailResponse,
  CacheVersionListItem,
  CacheVersionListResponse,
} from '@mapirror/shared';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_COUNTRY_ID = '00000000-0000-4000-8000-000000000005';
const READY_ID = '00000000-0000-4000-8000-000000000002';
const FAILED_ID = '00000000-0000-4000-8000-000000000003';
const JOB_ID = '00000000-0000-4000-8000-000000000004';
const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };
const ME = { admin: PROFILE, expiresAt: '2026-10-26T21:00:00.000Z', lastUsedAt: null };
const mounted: VueApp<Element>[] = [];
let previousSavePicker: PropertyDescriptor | undefined;

function detail(
  overrides: Partial<CacheDetailResponse['cache']> = {},
  activeJobs: CacheDetailResponse['activeJobs'] = [
    {
      id: JOB_ID,
      type: 'download',
      status: 'running',
      progressBytes: '1048576',
      totalBytes: '3145728',
    },
  ],
): CacheDetailResponse {
  return {
    country: {
      countryId: COUNTRY_ID,
      name: 'Finland',
      slug: 'finland',
      sourceId: 'europe/finland',
      iso: ['FI'],
    },
    cache: {
      isPublic: true,
      publicSince: '2026-10-20T12:00:00.000Z',
      totalSizeBytes: '3145728',
      versionsReady: 1,
      updateState: 'update_available',
      availableVersion: '261026',
      availableSizeBytes: '4000000',
      updateCheckedAt: '2026-10-26T12:00:00.000Z',
      ...overrides,
    },
    versions: [],
    activeJobs,
  };
}

function version(
  id: string,
  label: string,
  status: CacheVersionListItem['status'],
): CacheVersionListItem {
  return {
    id,
    version: label,
    origin: 'geofabrik_snapshot',
    dataTimestamp: '2026-10-25T21:00:00.000Z',
    sizeBytes: '3145728',
    checksumMd5: '0123456789abcdef0123456789abcdef',
    status,
    createdAt: '2026-10-26T12:00:00.000Z',
  };
}

const READY = version(READY_ID, '261025', 'ready');
const FAILED = version(FAILED_ID, '261024', 'failed');

function versionPage(
  rows: CacheVersionListItem[] = [READY, FAILED],
  page = 1,
  total = rows.length,
  limit = 25,
): CacheVersionListResponse {
  return {
    data: rows,
    meta: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
  };
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (input === undefined) return '';
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

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function routerOf(app: VueApp<Element>): Router {
  return (app.config.globalProperties as unknown as { $router: Router }).$router;
}

function makeFetch(
  respond: (url: URL, init: RequestInit | undefined) => Promise<Response> | Response,
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, 'http://mapirror.test');
    if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
    return respond(url, init);
  });
}

async function mountCountry(
  fetchImpl: typeof fetch,
  query = '',
): Promise<{
  container: HTMLElement;
  router: Router;
}> {
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_country_test');
  window.history.replaceState({}, '', `${adminPagePaths.cacheCountry(COUNTRY_ID)}${query}`);
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
  return { container, router };
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  if (previousSavePicker === undefined)
    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  else Object.defineProperty(window, 'showSaveFilePicker', previousSavePicker);
  previousSavePicker = undefined;
});

describe('admin cached-country detail', () => {
  it('shows summary, active work, version states, and the API country name in the breadcrumb', async () => {
    const fetchMock = makeFetch((url) => {
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}`) return jsonResponse(detail());
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`)
        return jsonResponse(versionPage());
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container } = await mountCountry(fetchMock);

    await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Finland'));
    expect(container.textContent).toContain('europe/finland');
    expect(container.textContent).toContain('Ready versions');
    expect(container.textContent).toContain('3.0 MiB');
    expect(container.textContent).toContain('Public');
    expect(container.textContent).toContain('Update available · 261026');
    expect(container.textContent).toContain('Active work');
    expect(container.textContent).toContain('download · running');
    expect(container.textContent).toContain('1.0 MiB of 3.0 MiB');
    expect(container.textContent).toContain('261025');
    expect(container.textContent).toContain('261024');
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toContain(
      'Finland',
    );
    expect(container.querySelectorAll('.mm-cache-version-table tbody tr')).toHaveLength(2);
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Download 261024"]')?.disabled,
    ).toBe(true);

    const adminRequests = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).includes('/_admin/api/cache/'),
    );
    expect(adminRequests).toHaveLength(2);
    for (const [, init] of adminRequests) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mm_country_test');
    }
  });

  it('keeps version pagination in the URL and requests the selected page', async () => {
    const requestedPages: string[] = [];
    const fetchMock = makeFetch((url) => {
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}`) return jsonResponse(detail());
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`) {
        const page = url.searchParams.get('page') ?? '1';
        requestedPages.push(page);
        return jsonResponse(versionPage([READY], Number(page), 26));
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container, router } = await mountCountry(fetchMock);

    await vi.waitFor(() => expect(container.textContent).toContain('Page 1 of 2'));
    const next = [
      ...container.querySelectorAll<HTMLButtonElement>('.mm-cache-pagination button'),
    ].find((button) => button.textContent?.includes('Next'));
    next?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query.page).toBe('2'));
    await vi.waitFor(() => expect(container.textContent).toContain('Page 2 of 2'));
    expect(requestedPages).toEqual(['1', '2']);
  });

  it('streams ready files to the native file picker with authenticated requests', async () => {
    const saved: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        saved.push(chunk);
      },
    });
    const picker = vi.fn(() =>
      Promise.resolve({ createWritable: () => Promise.resolve(writable) }),
    );
    previousSavePicker = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker');
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
    const fileBytes = new Uint8Array([0, 1, 2, 255]);
    const fetchMock = makeFetch((url) => {
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}`) return jsonResponse(detail());
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`)
        return jsonResponse(versionPage([READY]));
      if (url.pathname.endsWith('/download')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(fileBytes);
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/octet-stream' } },
        );
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container } = await mountCountry(fetchMock);

    await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Finland'));
    container.querySelector<HTMLButtonElement>('button[aria-label="Download 261025"]')?.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Downloaded 261025.'));

    expect(picker).toHaveBeenCalledWith({ suggestedName: 'finland-261025.osm.pbf' });
    expect([...saved[0]!]).toEqual([...fileBytes]);
    const downloadCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith('/download'),
    );
    expect(downloadCall).toBeDefined();
    expect(new Headers(downloadCall?.[1]?.headers).get('authorization')).toBe(
      'Bearer mm_country_test',
    );
    expect(downloadCall?.[1]?.credentials).toBe('omit');
    expect(downloadCall?.[1]?.method).toBe('GET');
  });

  it('explains when the browser cannot stream a large authenticated file to disk', async () => {
    const fetchMock = makeFetch((url) => {
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}`) return jsonResponse(detail());
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`)
        return jsonResponse(versionPage([READY]));
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container } = await mountCountry(fetchMock);

    await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Finland'));
    container.querySelector<HTMLButtonElement>('button[aria-label="Download 261025"]')?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('cannot save a large authenticated download'),
    );
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/download'))).toBe(
      false,
    );
  });

  it('requires explicit confirmation and optimistically removes a version before authoritative refresh', async () => {
    let deleteStarted!: () => void;
    let finishDelete!: (response: Response) => void;
    const started = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    let deleted = false;
    const fetchMock = makeFetch((url, init) => {
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}`) {
        return jsonResponse({
          ...detail(
            deleted
              ? {
                  isPublic: false,
                  publicSince: null,
                  totalSizeBytes: '0',
                  versionsReady: 0,
                }
              : {},
          ),
          activeJobs: [],
        });
      }
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`) {
        return jsonResponse(versionPage(deleted ? [FAILED] : [READY, FAILED]));
      }
      if (
        url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions/${READY_ID}` &&
        init?.method === 'DELETE'
      ) {
        expect(new URLSearchParams(url.search).get('confirm')).toBe('true');
        deleteStarted();
        return new Promise<Response>((resolve) => {
          finishDelete = resolve;
        });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container } = await mountCountry(fetchMock);

    await vi.waitFor(() =>
      expect(container.querySelectorAll('.mm-cache-version-table tbody tr')).toHaveLength(2),
    );
    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete 261025"]',
    );
    deleteButton?.click();
    await flushPromises();
    expect(container.textContent).toContain(
      'This is the last ready version. Deleting it will close public access to this country.',
    );
    const checkbox = container.querySelector<HTMLInputElement>('.mm-cache-confirm-check input');
    const confirmButton = [
      ...container.querySelectorAll<HTMLButtonElement>('.mm-cache-delete-dialog button'),
    ].find((button) => button.textContent?.includes('Delete version'));
    expect(confirmButton?.disabled).toBe(true);
    checkbox?.click();
    await flushPromises();
    expect(confirmButton?.disabled).toBe(false);
    confirmButton?.click();
    await started;
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.mm-cache-version-table tbody tr')).toHaveLength(1),
    );
    expect(container.textContent).toContain('Delete version 261025?');
    expect(container.textContent).toContain('0 B');

    deleted = true;
    finishDelete?.(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(container.textContent).toContain('Version 261025 deleted.'));
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.mm-cache-version-table tbody tr')).toHaveLength(1),
    );
    const versionsCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = new URL(requestUrl(input), 'http://mapirror.test');
      return (
        url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions` &&
        url.searchParams.get('page') === '1'
      );
    });
    expect(versionsCalls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain('0 B');
    expect(container.textContent).toContain('Private');
  });

  it('rolls back the optimistic delete and keeps the dialog open when active work conflicts', async () => {
    const fetchMock = makeFetch((url, init) => {
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}`) return jsonResponse(detail());
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`)
        return jsonResponse(versionPage());
      if (
        url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions/${READY_ID}` &&
        init?.method === 'DELETE'
      ) {
        return jsonResponse(
          {
            error: {
              code: 'JOB_ALREADY_RUNNING',
              message: 'A country job is still active.',
              requestId: 'req-busy',
            },
          },
          409,
        );
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container } = await mountCountry(fetchMock);

    await vi.waitFor(() =>
      expect(container.querySelectorAll('.mm-cache-version-table tbody tr')).toHaveLength(2),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete 261025"]')?.click();
    await flushPromises();
    container.querySelector<HTMLInputElement>('.mm-cache-confirm-check input')?.click();
    await flushPromises();
    [...container.querySelectorAll<HTMLButtonElement>('.mm-cache-delete-dialog button')]
      .find((button) => button.textContent?.includes('Delete version'))
      ?.click();

    await vi.waitFor(() =>
      expect(container.querySelector('.mm-cache-delete-error')?.textContent).toContain(
        'A country job is still active.',
      ),
    );
    expect(container.querySelectorAll('.mm-cache-version-table tbody tr')).toHaveLength(2);
    expect(container.textContent).toContain('Request id: req-busy');
    expect(container.textContent).toContain('Delete version 261025?');
  });

  it('requires an exact country slug, sends the authenticated delete, then returns to the cache list', async () => {
    const deleteRequest: { url?: URL; init?: RequestInit } = {};
    const fetchMock = makeFetch((url, init) => {
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}` && init?.method === 'DELETE') {
        deleteRequest.url = url;
        deleteRequest.init = init;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}`) return jsonResponse(detail({}, []));
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`)
        return jsonResponse(versionPage());
      if (url.pathname === '/_admin/api/cache')
        return jsonResponse({ data: [], meta: { page: 1, limit: 50, total: 0, totalPages: 0 } });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container, router } = await mountCountry(fetchMock);

    await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Finland'));
    const deleteAction = container.querySelector<HTMLButtonElement>(
      '.mm-cache-country-actions button',
    );
    deleteAction?.click();
    await flushPromises();
    let dialog = container.querySelector<HTMLElement>(
      '[aria-labelledby="cache-country-delete-title"]',
    );
    expect(dialog?.getAttribute('role')).toBe('alertdialog');
    expect(dialog?.textContent).toContain('public access will close');
    dialog?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await flushPromises();
    expect(container.querySelector('[aria-labelledby="cache-country-delete-title"]')).toBeNull();
    expect(document.activeElement).toBe(deleteAction);
    deleteAction?.click();
    await flushPromises();
    dialog = container.querySelector<HTMLElement>('[aria-labelledby="cache-country-delete-title"]');
    const input = dialog?.querySelector<HTMLInputElement>('input[type="text"]');
    const submit = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.includes('Delete country'),
    );
    expect(submit?.disabled).toBe(true);
    typeInto(input!, 'Finland');
    await flushPromises();
    expect(submit?.disabled).toBe(true);
    typeInto(input!, 'finland');
    await flushPromises();
    expect(submit?.disabled).toBe(false);
    submit?.click();

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('admin-cache'));
    expect(deleteRequest.url?.searchParams.get('confirm')).toBe('finland');
    expect(deleteRequest.url?.searchParams.has('cancelJobs')).toBe(false);
    expect(deleteRequest.init?.method).toBe('DELETE');
    expect(new Headers(deleteRequest.init?.headers).get('authorization')).toBe(
      'Bearer mm_country_test',
    );
    expect(deleteRequest.init?.credentials).toBe('omit');
  });

  it('requires explicit active-job cancellation and keeps the dialog open on a conflict', async () => {
    const deleteRequest: { url?: URL } = {};
    const fetchMock = makeFetch((url, init) => {
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}` && init?.method === 'DELETE') {
        deleteRequest.url = url;
        return jsonResponse(
          {
            error: {
              code: 'JOB_ALREADY_RUNNING',
              message: 'Active work has not finished cleanup yet.',
              requestId: 'req-delete-busy',
            },
          },
          409,
        );
      }
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}`) return jsonResponse(detail());
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`)
        return jsonResponse(versionPage());
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container } = await mountCountry(fetchMock);

    await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Finland'));
    container.querySelector<HTMLButtonElement>('.mm-cache-country-actions button')?.click();
    await flushPromises();
    const dialog = container.querySelector<HTMLElement>(
      '[aria-labelledby="cache-country-delete-title"]',
    );
    const input = dialog?.querySelector<HTMLInputElement>('input[type="text"]');
    const cancellation = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const submit = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.includes('Delete country'),
    );
    typeInto(input!, 'finland');
    await flushPromises();
    expect(submit?.disabled).toBe(true);
    cancellation?.click();
    await flushPromises();
    expect(submit?.disabled).toBe(false);
    submit?.click();

    await vi.waitFor(() =>
      expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain(
        'Active work has not finished cleanup yet.',
      ),
    );
    expect(deleteRequest.url?.searchParams.get('confirm')).toBe('finland');
    expect(deleteRequest.url?.searchParams.get('cancelJobs')).toBe('true');
    expect(container.textContent).toContain('Request id: req-delete-busy');
    expect(container.textContent).toContain('Delete cached country Finland?');
  });

  it('offers explicit cancellation when a country job appears after the detail was loaded', async () => {
    const deleteUrls: URL[] = [];
    const fetchMock = makeFetch((url, init) => {
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}` && init?.method === 'DELETE') {
        deleteUrls.push(url);
        if (deleteUrls.length === 1)
          return jsonResponse(
            {
              error: {
                code: 'JOB_ALREADY_RUNNING',
                message: 'This country has queued or running jobs.',
                requestId: 'req-new-job',
              },
            },
            409,
          );
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}`) return jsonResponse(detail({}, []));
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`)
        return jsonResponse(versionPage());
      if (url.pathname === '/_admin/api/cache')
        return jsonResponse({ data: [], meta: { page: 1, limit: 50, total: 0, totalPages: 0 } });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container, router } = await mountCountry(fetchMock);

    await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Finland'));
    container.querySelector<HTMLButtonElement>('.mm-cache-country-actions button')?.click();
    await flushPromises();
    const dialog = container.querySelector<HTMLElement>(
      '[aria-labelledby="cache-country-delete-title"]',
    );
    typeInto(dialog!.querySelector<HTMLInputElement>('input[type="text"]')!, 'finland');
    await flushPromises();
    [...dialog!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Delete country'))
      ?.click();

    await vi.waitFor(() => expect(dialog?.querySelector('[role="alert"]')).not.toBeNull());
    const cancelJobs = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const submit = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.includes('Delete country'),
    );
    expect(deleteUrls[0]?.searchParams.has('cancelJobs')).toBe(false);
    expect(submit?.disabled).toBe(true);
    cancelJobs?.click();
    await flushPromises();
    expect(submit?.disabled).toBe(false);
    submit?.click();

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('admin-cache'));
    expect(deleteUrls).toHaveLength(2);
    expect(deleteUrls[1]?.searchParams.get('cancelJobs')).toBe('true');
  });

  it('does not navigate away when a country delete completes after the reader changed countries', async () => {
    let deleteStarted!: () => void;
    let finishDelete!: (response: Response) => void;
    const started = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    const fetchMock = makeFetch((url, init) => {
      const countryId = url.pathname.match(/^\/_admin\/api\/cache\/([^/]+)$/u)?.[1];
      if (countryId === COUNTRY_ID && init?.method === 'DELETE') {
        deleteStarted();
        return new Promise<Response>((resolve) => {
          finishDelete = resolve;
        });
      }
      if (countryId === COUNTRY_ID) return jsonResponse(detail({}, []));
      if (countryId === OTHER_COUNTRY_ID) {
        const sweden = detail({}, []);
        sweden.country = {
          ...sweden.country,
          countryId: OTHER_COUNTRY_ID,
          name: 'Sweden',
          slug: 'sweden',
          sourceId: 'europe/sweden',
          iso: ['SE'],
        };
        return jsonResponse(sweden);
      }
      if (url.pathname.endsWith('/versions')) return jsonResponse(versionPage());
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const { container, router } = await mountCountry(fetchMock);

    await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Finland'));
    container.querySelector<HTMLButtonElement>('.mm-cache-country-actions button')?.click();
    await flushPromises();
    const dialog = container.querySelector<HTMLElement>(
      '[aria-labelledby="cache-country-delete-title"]',
    );
    typeInto(dialog!.querySelector<HTMLInputElement>('input[type="text"]')!, 'finland');
    await flushPromises();
    [...dialog!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Delete country'))
      ?.click();
    await started;

    await router.push(adminPagePaths.cacheCountry(OTHER_COUNTRY_ID));
    await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Sweden'));
    finishDelete?.(new Response(null, { status: 204 }));
    await flushPromises();

    expect(router.currentRoute.value.params.countryId).toBe(OTHER_COUNTRY_ID);
    expect(router.currentRoute.value.name).toBe('admin-cache-country');
    expect(container.querySelector('h1')?.textContent).toBe('Sweden');
  });

  it('refuses malformed UUID links without calling the cache API', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_country_test');
    window.history.replaceState({}, '', adminPagePaths.cacheCountry('not-a-uuid'));
    const fetchMock = makeFetch(() => {
      throw new Error('The cache endpoint must not be called for a malformed country id.');
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createWebApp();
    mounted.push(app);
    const container = document.createElement('div');
    document.body.append(container);
    app.mount(container);
    await routerOf(app).isReady();
    await flushPromises();

    expect(container.textContent).toContain('This cached-country link is invalid');
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('/_admin/api/cache/')),
    ).toBe(false);
  });
});
