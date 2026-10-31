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

const RUN_IDS = {
  running: '00000000-0000-4000-8000-000000000201',
  succeeded: '00000000-0000-4000-8000-000000000202',
  partial: '00000000-0000-4000-8000-000000000203',
  failed: '00000000-0000-4000-8000-000000000204',
} as const;

function runView(
  id: string,
  status: 'running' | 'succeeded' | 'partial' | 'failed',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    intervalId: INTERVAL_ID,
    intervalName: 'Paused Finland refresh',
    triggeredBy: id === RUN_IDS.running ? 'manual' : 'schedule',
    status,
    countriesTotal: status === 'partial' ? 2 : 1,
    countriesOk: status === 'succeeded' || status === 'partial' ? 1 : 0,
    countriesFailed: status === 'failed' || status === 'partial' ? 1 : 0,
    countriesSkipped: 0,
    bytesDownloaded: '1234',
    startedAt: NOW,
    finishedAt: status === 'running' ? null : '2026-10-28T10:01:00.000Z',
    durationMs: 60_000,
    errorMessage: status === 'partial' ? 'One country could not be refreshed safely.' : null,
    ...overrides,
  };
}

const RUN_ITEMS = [
  {
    id: '00000000-0000-4000-8000-000000000301',
    countryId: COUNTRY_ID,
    countrySlug: 'finland',
    countryName: 'Finland',
    jobId: '00000000-0000-4000-8000-000000000401',
    status: 'downloaded',
    version: '20261028',
    bytes: '1234',
    errorCode: null,
    errorMessage: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000302',
    countryId: '00000000-0000-4000-8000-000000000104',
    countrySlug: 'sweden',
    countryName: 'Sweden',
    jobId: '00000000-0000-4000-8000-000000000402',
    status: 'failed',
    version: null,
    bytes: '0',
    errorCode: 'SOURCE_UNAVAILABLE',
    errorMessage: 'The source did not return a usable snapshot.',
  },
];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin intervals screen', () => {
  it('shows initial loading, a retryable load error, and the empty state after recovery', async () => {
    let rejectInitial!: (cause: unknown) => void;
    const initialRequest = new Promise<Response>((_resolve, reject) => {
      rejectInitial = reject;
    });
    let intervalCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
      if (url.pathname === '/_admin/api/intervals') {
        intervalCalls += 1;
        return intervalCalls === 1 ? initialRequest : Promise.resolve(jsonResponse({ data: [] }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    const { container } = await mountIntervals(fetchImpl);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll('.mm-interval-skeleton-card')).toHaveLength(2);
    expect(container.textContent).toContain('Loading schedules…');
    expect(container.textContent).not.toContain('Reading the current interval list');

    rejectInitial(new TypeError('network unavailable'));
    await flushPromises();
    expect(container.textContent).toContain('The server could not be reached.');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Retry');

    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Retry')
      ?.click();
    await flushPromises();
    await flushPromises();

    expect(container.textContent).toContain('No intervals yet');
    expect(container.textContent).not.toContain('Schedules could not be loaded');
    expect(intervalCalls).toBe(2);
  });

  it('starts a paused interval manually and renders all run statuses with safe country failure details', async () => {
    const interval = intervalFromBody({
      name: 'Paused Finland refresh',
      frequency: 'daily',
      timeOfDay: '03:00',
      keepVersions: 3,
      onlyIfChanged: true,
      enabled: false,
    });
    const summaries = [
      runView(RUN_IDS.running, 'running'),
      runView(RUN_IDS.succeeded, 'succeeded'),
      runView(RUN_IDS.partial, 'partial'),
      runView(RUN_IDS.failed, 'failed'),
    ];
    const calls: Array<{ method: string; path: string; body?: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) =>
      Promise.resolve().then(() => {
        const url = requestUrl(input);
        const method = init?.method ?? 'GET';
        calls.push({
          method,
          path: url.pathname,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
        if (url.pathname === '/_admin/api/catalog') {
          return jsonResponse({
            data: [],
            meta: { page: 1, limit: 100, total: 0, totalPages: 0 },
            catalogSyncedAt: NOW,
          });
        }
        if (url.pathname === '/_admin/api/intervals' && method === 'GET') {
          return jsonResponse({ data: [interval] });
        }
        if (url.pathname === `/_admin/api/intervals/${INTERVAL_ID}/run` && method === 'POST') {
          return jsonResponse(
            { runId: RUN_IDS.running, jobIds: ['00000000-0000-4000-8000-000000000401'] },
            202,
          );
        }
        if (url.pathname === `/_admin/api/intervals/${INTERVAL_ID}/runs`) {
          return jsonResponse({
            data: summaries,
            meta: { page: 1, limit: 10, total: summaries.length, totalPages: 1 },
          });
        }
        if (url.pathname === `/_admin/api/interval-runs/${RUN_IDS.partial}`) {
          return jsonResponse({ run: runView(RUN_IDS.partial, 'partial'), items: RUN_ITEMS });
        }
        if (url.pathname === `/_admin/api/interval-runs/${RUN_IDS.running}`) {
          return jsonResponse({
            run: runView(RUN_IDS.running, 'running'),
            items: [{ ...RUN_ITEMS[0], status: 'queued', version: null, bytes: '0' }],
          });
        }
        if (url.pathname === '/_admin/api/jobs') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
        }
        return jsonResponse({ data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } });
      }),
    );

    const { container } = await mountIntervals(fetchImpl);
    expect(container.textContent).toContain('Paused');
    const runNow = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Run Paused Finland refresh now"]',
    );
    expect(runNow?.disabled).toBe(false);
    runNow?.click();
    await flushPromises();
    expect(container.textContent).toContain('A paused schedule can still be run manually.');
    expect(container.textContent).toContain('1 countries');

    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Start run'))
      ?.click();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(calls).toContainEqual({
      method: 'POST',
      path: `/_admin/api/intervals/${INTERVAL_ID}/run`,
      body: '{}',
    });
    expect(container.textContent).toContain('Running');
    expect(container.textContent).toContain('Succeeded');
    expect(container.textContent).toContain('Partially completed');
    expect(container.textContent).toContain('Failed');

    [...container.querySelectorAll<HTMLButtonElement>('.mm-run-list-item')]
      .find((button) => button.textContent?.includes('Partially completed'))
      ?.click();
    await flushPromises();
    await flushPromises();
    expect(container.textContent).toContain('One country could not be refreshed safely.');
    expect(container.textContent).toContain('Sweden');
    expect(container.textContent).toContain('SOURCE_UNAVAILABLE');
    expect(container.textContent).toContain('The source did not return a usable snapshot.');
  });

  it('polls an active run until it reaches a terminal status', async () => {
    vi.useFakeTimers();
    const interval = intervalFromBody({
      name: 'Paused Finland refresh',
      frequency: 'daily',
      timeOfDay: '03:00',
      keepVersions: 3,
      onlyIfChanged: true,
      enabled: false,
    });
    let detailRequests = 0;
    let completed = false;
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      Promise.resolve().then(() => {
        const url = requestUrl(input);
        if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
        if (url.pathname === '/_admin/api/catalog') {
          return jsonResponse({
            data: [],
            meta: { page: 1, limit: 100, total: 0, totalPages: 0 },
            catalogSyncedAt: NOW,
          });
        }
        if (url.pathname === '/_admin/api/intervals') return jsonResponse({ data: [interval] });
        if (url.pathname === `/_admin/api/intervals/${INTERVAL_ID}/runs`) {
          const summary = completed
            ? runView(RUN_IDS.running, 'succeeded')
            : runView(RUN_IDS.running, 'running');
          return jsonResponse({
            data: [summary],
            meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
          });
        }
        if (url.pathname === `/_admin/api/interval-runs/${RUN_IDS.running}`) {
          detailRequests += 1;
          if (detailRequests > 1) completed = true;
          return jsonResponse({
            run: completed
              ? runView(RUN_IDS.running, 'succeeded')
              : runView(RUN_IDS.running, 'running'),
            items: [{ ...RUN_ITEMS[0], status: completed ? 'downloaded' : 'queued' }],
          });
        }
        if (url.pathname === '/_admin/api/jobs') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
        }
        return jsonResponse({ data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } });
      }),
    );

    const { container } = await mountIntervals(fetchImpl);
    container
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Show run history for Paused Finland refresh"]',
      )
      ?.click();
    await flushPromises();
    await flushPromises();
    expect(detailRequests).toBe(1);
    expect(container.textContent).toContain('Running');

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    await flushPromises();
    expect(detailRequests).toBe(2);
    expect(container.textContent).toContain('Succeeded');
  });

  it('paginates run history and requests the selected page', async () => {
    const interval = intervalFromBody({
      name: 'Paused Finland refresh',
      frequency: 'daily',
      timeOfDay: '03:00',
      keepVersions: 3,
      onlyIfChanged: true,
      enabled: false,
    });
    const pageCalls: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) =>
      Promise.resolve().then(() => {
        const url = requestUrl(input);
        if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
        if (url.pathname === '/_admin/api/catalog') {
          return jsonResponse({
            data: [],
            meta: { page: 1, limit: 100, total: 0, totalPages: 0 },
            catalogSyncedAt: NOW,
          });
        }
        if (url.pathname === '/_admin/api/intervals' && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse({ data: [interval] });
        }
        if (url.pathname === `/_admin/api/intervals/${INTERVAL_ID}/runs`) {
          const currentPage = Number(url.searchParams.get('page'));
          pageCalls.push(currentPage);
          const summary =
            currentPage === 1
              ? runView(RUN_IDS.running, 'running')
              : runView(RUN_IDS.failed, 'failed');
          return jsonResponse({
            data: [summary],
            meta: { page: currentPage, limit: 10, total: 11, totalPages: 2 },
          });
        }
        if (url.pathname.startsWith('/_admin/api/interval-runs/')) {
          const id = url.pathname.split('/').at(-1)!;
          const summary =
            id === RUN_IDS.failed
              ? runView(RUN_IDS.failed, 'failed')
              : runView(RUN_IDS.running, 'running');
          return jsonResponse({ run: summary, items: [] });
        }
        if (url.pathname === '/_admin/api/jobs') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
        }
        return jsonResponse({ data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } });
      }),
    );

    const { container } = await mountIntervals(fetchImpl);
    container
      .querySelector<HTMLButtonElement>(
        `button[aria-label="Show run history for Paused Finland refresh"]`,
      )
      ?.click();
    await flushPromises();
    await flushPromises();
    expect(container.textContent).toContain('Page 1 of 2');
    [...container.querySelectorAll<HTMLButtonElement>('.mm-run-pagination button')]
      .find((button) => button.textContent?.includes('Next'))
      ?.click();
    await flushPromises();
    await flushPromises();
    expect(pageCalls).toEqual([1, 2]);
    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.textContent).toContain('Failed');
  });

  it.each([
    ['This interval already has a run in progress.', '00000000-0000-4000-8000-000000000501'],
    [
      'A download for one or more countries is already queued or running.',
      '00000000-0000-4000-8000-000000000502',
    ],
  ])('explains manual-run conflict: %s', async (message, requestId) => {
    const interval = intervalFromBody({
      name: 'Paused Finland refresh',
      frequency: 'daily',
      timeOfDay: '03:00',
      keepVersions: 3,
      onlyIfChanged: true,
      enabled: false,
    });
    const fetchImpl = vi.fn<typeof fetch>((input, init) =>
      Promise.resolve().then(() => {
        const url = requestUrl(input);
        if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
        if (url.pathname === '/_admin/api/catalog') {
          return jsonResponse({
            data: [],
            meta: { page: 1, limit: 100, total: 0, totalPages: 0 },
            catalogSyncedAt: NOW,
          });
        }
        if (url.pathname === '/_admin/api/intervals' && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse({ data: [interval] });
        }
        if (
          url.pathname === `/_admin/api/intervals/${INTERVAL_ID}/run` &&
          init?.method === 'POST'
        ) {
          return jsonResponse(
            {
              error: { code: 'JOB_ALREADY_RUNNING', message, requestId },
            },
            409,
          );
        }
        if (url.pathname === '/_admin/api/jobs') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
        }
        return jsonResponse({ data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } });
      }),
    );

    const { container } = await mountIntervals(fetchImpl);
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Run Paused Finland refresh now"]')
      ?.click();
    await flushPromises();
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Start run'))
      ?.click();
    await flushPromises();
    await flushPromises();
    expect(container.textContent).toContain(message);
    expect(container.textContent).toContain(`Request ${requestId}`);
  });

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
