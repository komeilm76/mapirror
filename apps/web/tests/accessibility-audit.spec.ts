import { flushPromises } from '@vue/test-utils';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';

const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };
const ME = { admin: PROFILE, expiresAt: '2099-12-31T23:59:59.999Z', lastUsedAt: null };
const mounted: VueApp<Element>[] = [];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mountAuditRoute(path: string): Promise<HTMLElement> {
  window.history.replaceState({}, '', path);
  if (path.startsWith('/_site/admin/')) sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_a11y_test');
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input) => {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === 'string' ? input : input.url, window.location.origin);
      if (url.pathname === '/_auth/api/me') return Promise.resolve(jsonResponse(ME));
      return Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Service unavailable.',
              requestId: 'req-a11y',
            },
          },
          503,
        ),
      );
    }),
  );

  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  const router = (app.config.globalProperties as unknown as { $router: Router }).$router;
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return container;
}

async function mountPublicCatalog(theme: 'light' | 'dark' = 'light'): Promise<HTMLElement> {
  window.history.replaceState({}, '', '/_site/');
  localStorage.setItem('mapirror.public-theme', theme);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          data: [],
          meta: { page: 1, limit: 25, total: 0, totalPages: 0 },
          license: {
            name: 'ODbL 1.0',
            attribution: '© OpenStreetMap contributors',
            url: 'https://www.openstreetmap.org/copyright',
          },
        }),
      ),
    ),
  );
  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  const router = (app.config.globalProperties as unknown as { $router: Router }).$router;
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return container;
}

async function seriousViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
  });
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(', ')} (${node.failureSummary ?? 'no summary'})`).join('; ')}`,
    );
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  sessionStorage.clear();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('accessibility audit', () => {
  it('has no serious WCAG violations on the loaded light-theme public catalog', async () => {
    const container = await mountPublicCatalog();
    expect(container.querySelector('.v-application')?.className).toContain('v-theme--light');
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('has no serious WCAG violations on the dark-theme public catalog', async () => {
    const container = await mountPublicCatalog('dark');
    expect(container.querySelector('.v-application')?.className).toContain('v-theme--dark');
    expect(await seriousViolations(container)).toEqual([]);
  });

  it.each([
    ['login', '/_auth/login'],
    ['public API documentation', '/_site/api-docs'],
    ['public country detail', '/_site/countries/finland'],
    ['admin dashboard', '/_site/admin/'],
    ['admin cached country', '/_site/admin/cache/00000000-0000-4000-8000-000000000001'],
    ['admin catalog', '/_site/admin/catalog'],
    ['admin cache', '/_site/admin/cache'],
    ['admin intervals', '/_site/admin/intervals'],
    ['admin import', '/_site/admin/import'],
    ['admin jobs', '/_site/admin/jobs'],
    ['admin settings placeholder', '/_site/admin/settings'],
    ['admin audit placeholder', '/_site/admin/audit'],
    ['admin system placeholder', '/_site/admin/system'],
    ['not found', '/_site/not-a-route'],
  ])('has no serious WCAG violations on %s', async (_name, path) => {
    expect(await seriousViolations(await mountAuditRoute(path))).toEqual([]);
  });
});
