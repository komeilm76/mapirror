import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };
const ME = { admin: PROFILE, expiresAt: '2026-10-26T21:00:00.000Z', lastUsedAt: null };
const COUNTRY_ID = '00000000-0000-4000-8000-000000000102';
const INTERVAL_ID = '00000000-0000-4000-8000-000000000103';
const NOW = '2026-10-28T10:00:00.000Z';

const COUNTRY = {
  countryId: COUNTRY_ID,
  sourceId: 'finland',
  name: 'Finland',
  slug: 'finland',
  continent: 'Europe',
  iso: ['FI'],
  sourceSizeHintBytes: null,
  cache: {
    cached: false,
    versionsReady: 0,
    totalSizeBytes: 0,
    isPublic: false,
    updateState: 'unknown',
    availableVersion: null,
    availableSizeBytes: null,
  },
  lastSyncedAt: NOW,
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

async function mountIntervals(
  fetchImpl: typeof fetch,
): Promise<{ app: VueApp<Element>; container: HTMLElement }> {
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_intervals_test');
  window.history.replaceState({}, '', adminPagePaths.intervals());
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

function intervalFromBody(body: Record<string, unknown>) {
  return {
    id: INTERVAL_ID,
    name: String(body.name),
    frequency: body.frequency,
    timeOfDay: body.timeOfDay,
    weekday: body.weekday ?? null,
    dayOfMonth: body.dayOfMonth ?? null,
    countries: [{ countryId: COUNTRY_ID, name: COUNTRY.name, slug: COUNTRY.slug }],
    keepVersions: body.keepVersions,
    onlyIfChanged: body.onlyIfChanged,
    enabled: body.enabled,
    nextRunAt: '2026-10-29T03:00:00.000Z',
    lastRun: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin intervals screen', () => {
  it('creates a multi-country schedule and shows five UTC preview entries', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    let saved: ReturnType<typeof intervalFromBody> | null = null;
    const fetchImpl = vi.fn<typeof fetch>((input, init) =>
      Promise.resolve().then(() => {
        const url = requestUrl(input);
        const method = init?.method ?? 'GET';
        if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
        if (url.pathname === '/_admin/api/catalog') {
          const data = url.searchParams.has('q') ? [] : [COUNTRY];
          return jsonResponse({
            data,
            meta: {
              page: 1,
              limit: 100,
              total: data.length,
              totalPages: data.length === 0 ? 0 : 1,
            },
            catalogSyncedAt: NOW,
          });
        }
        if (url.pathname === '/_admin/api/intervals' && method === 'GET') {
          return jsonResponse({ data: saved === null ? [] : [saved] });
        }
        if (url.pathname === '/_admin/api/intervals' && method === 'POST') {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
            string,
            unknown
          >;
          calls.push({ method, path: url.pathname, body });
          saved = intervalFromBody(body);
          return jsonResponse({ interval: saved }, 201);
        }
        calls.push({ method, path: url.pathname });
        if (url.pathname === '/_admin/api/jobs') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
        }
        return jsonResponse({ data: [], meta: { page: 1, limit: 25, total: 0, totalPages: 0 } });
      }),
    );

    const { container } = await mountIntervals(fetchImpl);
    expect(container.textContent).toContain('No intervals yet');
    const firstCreate = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Create your first interval'),
    );
    firstCreate?.click();
    await flushPromises();

    expect(container.querySelector('#mm-interval-preview-title')?.textContent).toContain(
      'Next five runs',
    );
    expect(container.querySelectorAll('.mm-interval-preview li')).toHaveLength(5);

    const frequency = container.querySelector<HTMLSelectElement>('.mm-interval-form select');
    expect(frequency).not.toBeNull();
    frequency!.value = 'weekly';
    frequency!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    const weekday = container.querySelectorAll<HTMLSelectElement>('.mm-interval-form select')[1];
    expect(weekday).toBeDefined();
    weekday!.value = '5';
    weekday!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(container.querySelectorAll('.mm-interval-preview li')).toHaveLength(5);

    const name = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Weekly Europe refresh"]',
    );
    expect(name).not.toBeNull();
    name!.value = 'Finland morning refresh';
    name!.dispatchEvent(new Event('input', { bubbles: true }));

    const country = container.querySelector<HTMLInputElement>(
      `input[type="checkbox"][value="${COUNTRY_ID}"]`,
    );
    expect(country).not.toBeNull();
    country!.checked = true;
    country!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    const countrySearch = container.querySelector<HTMLInputElement>('#mm-interval-country-search');
    expect(countrySearch).not.toBeNull();
    countrySearch!.value = 'Atlantis';
    countrySearch!.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(container.querySelector(`input[type="checkbox"][value="${COUNTRY_ID}"]`)).not.toBeNull();

    const submit = [
      ...container.querySelectorAll<HTMLButtonElement>('form button[type="submit"]'),
    ].find((button) => button.textContent?.includes('Create interval'));
    submit?.click();
    await flushPromises();
    await flushPromises();

    const createCall = calls.find(
      (call) => call.method === 'POST' && call.path === '/_admin/api/intervals',
    );
    expect(createCall?.body).toMatchObject({
      name: 'Finland morning refresh',
      frequency: 'weekly',
      timeOfDay: '03:00',
      weekday: 5,
      countryIds: [COUNTRY_ID],
      keepVersions: 3,
      onlyIfChanged: true,
      enabled: true,
    });
    expect(container.querySelector('.mm-interval-card h2')?.textContent).toBe(
      'Finland morning refresh',
    );
    expect(container.textContent).toContain('Last status');
    expect(container.textContent).toContain('No runs yet');
  });
});
