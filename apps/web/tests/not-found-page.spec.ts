import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import { createWebApp } from '../src/bootstrap';

const mounted: VueApp<Element>[] = [];

async function mountNotFound(path: string): Promise<{
  app: VueApp<Element>;
  container: HTMLElement;
  router: Router;
}> {
  window.history.replaceState({}, '', path);
  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  const router = (app.config.globalProperties as unknown as { $router: Router }).$router;
  await router.isReady();
  await flushPromises();
  return { app, container, router };
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('public not-found page', () => {
  it('keeps and displays the attempted address with a clear catalog action', async () => {
    const attempted = '/_site/no-such-map/with-a-long-segment?from=bookmark';
    const { container, router } = await mountNotFound(attempted);

    expect(router.currentRoute.value.fullPath).toBe(attempted);
    expect(container.querySelector('h1')?.textContent).toBe('Page not found');
    expect(container.querySelector('.mm-public-not-found-code')?.textContent).toBe('404');
    expect(container.querySelector('.mm-public-not-found-address code')?.textContent).toBe(
      attempted,
    );
    expect(container.querySelector('.mm-public-not-found-art')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('.mm-public-not-found-action')?.getAttribute('href')).toBe(
      '/_site/',
    );
    expect(container.textContent).toContain('Browse published maps');
  });

  it('takes the visitor back to the public catalog without replacing the app', async () => {
    const response = {
      data: [],
      meta: { page: 1, limit: 25, total: 0, totalPages: 0 },
      license: {
        name: 'ODbL 1.0',
        attribution: '© OpenStreetMap contributors',
        url: 'https://www.openstreetmap.org/copyright',
      },
    };
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container, router } = await mountNotFound('/_site/not-a-route');

    container.querySelector<HTMLAnchorElement>('.mm-public-not-found-action')?.click();
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('home');
    expect(router.currentRoute.value.fullPath).toBe('/_site/');
    expect(container.textContent).toContain('Browse published maps');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
