import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import type { JobView } from '@mapirror/shared';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };
const ME = { admin: PROFILE, expiresAt: '2026-10-26T21:00:00.000Z', lastUsedAt: null };
const JOB_ID = '00000000-0000-4000-8000-000000000101';
const COUNTRY_ID = '00000000-0000-4000-8000-000000000102';
const CREATED_AT = '2026-10-28T10:00:00.000Z';

const JOB: JobView = {
  id: JOB_ID,
  type: 'download',
  status: 'running',
  phase: 'downloading',
  progressBytes: 5_120,
  totalBytes: 20_480,
  speedBps: 512,
  etaSeconds: 30,
  payload: { countryId: COUNTRY_ID, version: '261023', origin: 'geofabrik_snapshot' },
  updateCheckResult: null,
  cancelRequested: false,
  attempts: 1,
  maxAttempts: 3,
  createdAt: CREATED_AT,
  startedAt: CREATED_AT,
  finishedAt: null,
  error: null,
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

async function mountJobs(
  fetchImpl: typeof fetch,
  location = adminPagePaths.jobs(),
): Promise<{ app: VueApp<Element>; container: HTMLElement; router: Router }> {
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_job_test');
  window.history.replaceState({}, '', location);
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
  return { app, container, router };
}

function responseFor(
  fetchCalls: ReturnType<typeof vi.fn<typeof fetch>>,
  jobView: () => JobView = () => JOB,
): typeof fetch {
  let cancellationAccepted = false;
  return vi.fn<typeof fetch>((input, init) =>
    Promise.resolve().then(() => {
      const url = requestUrl(input);
      void fetchCalls(input, init);
      if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
      if (url.pathname.endsWith('/cancel')) {
        cancellationAccepted = true;
        return jsonResponse(
          { jobId: JOB_ID, status: 'running', accepted: true, cancelRequested: true },
          202,
        );
      }
      if (url.pathname === `/_admin/api/jobs/${JOB_ID}`) {
        const current = jobView();
        return jsonResponse(cancellationAccepted ? { ...current, cancelRequested: true } : current);
      }
      if (url.pathname === '/_admin/api/jobs') {
        if (url.searchParams.get('status') === 'queued') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
        }
        if (url.searchParams.get('status') === 'running') {
          return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 1, totalPages: 1 } });
        }
        return jsonResponse({ data: [JOB], meta: { page: 1, limit: 25, total: 1, totalPages: 1 } });
      }
      return jsonResponse({ data: [], meta: { page: 1, limit: 25, total: 0, totalPages: 0 } });
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

describe('admin job queue and persistent progress drawer', () => {
  it('shows layout-matched table and mobile skeletons while the initial list is pending', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
      if (url.pathname === '/_admin/api/jobs') return new Promise<Response>(() => undefined);
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    const { container } = await mountJobs(fetchImpl);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll('.mm-jobs-skeleton-row')).toHaveLength(5);
    expect(container.querySelectorAll('.mm-jobs-skeleton-card')).toHaveLength(3);
    expect(container.textContent).toContain('Loading jobs…');
    expect(container.querySelector('.mm-jobs-loading .v-progress-linear')).toBeNull();
  });

  it('loads URL-backed filters and shows the job list', async () => {
    const calls = vi.fn<typeof fetch>();
    const { container } = await mountJobs(
      responseFor(calls),
      `${adminPagePaths.jobs()}?status=failed`,
    );

    expect(container.querySelector('h1')?.textContent).toBe('Jobs');
    expect(container.textContent).toContain('Download');
    expect(container.textContent).toContain('Running');
    expect(container.textContent).not.toContain('running');
    expect(document.body.textContent).toContain('512 B/s');
    expect(
      container
        .querySelector('[aria-controls="mm-job-progress-drawer"]')
        ?.getAttribute('aria-label'),
    ).toBe('1 active job. Open job progress');
    expect(container.querySelectorAll('.mm-job-active-dot').length).toBeGreaterThan(0);
    expect(
      calls.mock.calls.some(
        ([input]) =>
          requestUrl(input).pathname === '/_admin/api/jobs' &&
          requestUrl(input).searchParams.get('limit') === '25' &&
          requestUrl(input).searchParams.get('page') === '1',
      ),
    ).toBe(true);

    const statusFilter = container.querySelector<HTMLSelectElement>('#mm-job-status');
    expect(statusFilter?.value).toBe('failed');
    expect(
      calls.mock.calls.some(([input]) => requestUrl(input).searchParams.get('status') === 'failed'),
    ).toBe(true);
  });

  it('tracks progress in the shell, polls detail and keeps the drawer mounted across route navigation', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const calls = vi.fn<typeof fetch>();
    const { container, router } = await mountJobs(responseFor(calls));

    const openProgress = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('View progress'),
    );
    expect(openProgress).toBeDefined();
    openProgress!.click();
    await flushPromises();

    expect(document.querySelector('#mm-job-progress-drawer')).not.toBeNull();
    expect(document.body.textContent).toContain('20 KB');
    expect(document.body.textContent).toContain('512 B/s');
    expect(document.body.textContent).toContain('30 sec');
    expect(
      calls.mock.calls.some(
        ([input]) => requestUrl(input).pathname === `/_admin/api/jobs/${JOB_ID}`,
      ),
    ).toBe(true);
    expect(
      intervalSpy.mock.calls.filter(([, delay]) => delay === 2_000).length,
    ).toBeGreaterThanOrEqual(2);

    await router.push(adminPagePaths.intervals());
    await flushPromises();
    expect(document.querySelector('#mm-job-progress-drawer')).not.toBeNull();
    expect(
      container
        .querySelector('[aria-controls="mm-job-progress-drawer"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(document.body.textContent).toContain('Job progress');
    expect(document.body.textContent).toContain('512 B/s');

    const detailPath = `/_admin/api/jobs/${JOB_ID}`;
    const requestsBeforePoll = calls.mock.calls.filter(
      ([input]) => requestUrl(input).pathname === detailPath,
    ).length;
    const drawerPoll = intervalSpy.mock.calls
      .map(([callback, delay]) => ({ callback, delay }))
      .find(
        ({ callback, delay }) =>
          delay === 2_000 && typeof callback === 'function' && callback.name === 'poll',
      )?.callback;
    expect(drawerPoll).toBeDefined();
    Reflect.apply(drawerPoll as (...args: unknown[]) => unknown, undefined, []);
    await flushPromises();
    expect(
      calls.mock.calls.filter(([input]) => requestUrl(input).pathname === detailPath).length,
    ).toBeGreaterThan(requestsBeforePoll);
  });

  it('shows a retryable error when the first tracked-job projection cannot be loaded', async () => {
    const calls = vi.fn<typeof fetch>();
    let detailRequests = 0;
    const fallback = responseFor(calls);
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === `/_admin/api/jobs/${JOB_ID}` && detailRequests++ === 0) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'DB_UNAVAILABLE',
                message: 'The job projection could not be loaded.',
                requestId: 'req-job-detail-001',
              },
            },
            503,
          ),
        );
      }
      return fallback(input, init);
    });
    const { container } = await mountJobs(fetchImpl);
    container.querySelector<HTMLButtonElement>('.mm-jobs-table button')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('req-job-detail-001'));
    expect(document.body.querySelector('.mm-job-progress-card')?.textContent).toContain(
      'Job details unavailable',
    );

    document.body.querySelector<HTMLButtonElement>('.mm-job-progress-card button')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('20 KB'));
    expect(detailRequests).toBe(2);
  });

  it('treats cancellation as a request and leaves the running job pollable until terminal cleanup', async () => {
    const calls = vi.fn<typeof fetch>();
    const { container } = await mountJobs(responseFor(calls));
    const openProgress = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('View progress'),
    );
    openProgress?.click();
    await flushPromises();

    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Cancel job'),
    );
    expect(cancel).toBeDefined();
    cancel!.click();
    await flushPromises();

    expect(
      calls.mock.calls.some(
        ([input, init]) =>
          requestUrl(input).pathname === `/_admin/api/jobs/${JOB_ID}/cancel` &&
          init?.method === 'POST',
      ),
    ).toBe(true);
    expect(document.body.textContent).toContain(
      'Cancellation requested. Waiting for the job to finish cleanup…',
    );
    expect(document.body.querySelector('.mm-job-progress-card')?.textContent).toContain('Running');
    expect(document.body.querySelector('.mm-job-progress-card')?.textContent).not.toContain(
      'canceled',
    );
  });

  it('maps a safe job error code to human copy without exposing raw details', async () => {
    const failed: JobView = {
      ...JOB,
      status: 'failed',
      phase: null,
      speedBps: null,
      etaSeconds: null,
      finishedAt: CREATED_AT,
      error: {
        code: 'JOB_HANDLER_FAILED',
        message: 'The job could not be completed. It may be retried.',
      },
    };
    const { container } = await mountJobs(responseFor(vi.fn<typeof fetch>(), () => failed));
    const openProgress = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('View progress'),
    );
    openProgress?.click();
    await flushPromises();

    expect(document.body.textContent).not.toContain('JOB_HANDLER_FAILED');
    expect(document.body.textContent).toContain('The job could not be completed.');
    expect(document.body.textContent).toContain(
      'We will retry automatically while attempts remain. If the job still fails, start the work again.',
    );
    expect(document.body.textContent).not.toContain('It may be retried.');
    expect(document.body.textContent).not.toContain('Cancel job');
  });
});
