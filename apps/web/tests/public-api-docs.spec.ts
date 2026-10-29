import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import {
  PublicCountriesResponseSchema,
  PublicCountryDetailResponseSchema,
  PublicCountryVersionsResponseSchema,
  PublicStatsResponseSchema,
} from '@mapirror/shared';

import { createWebApp } from '../src/bootstrap';

const mounted: VueApp<Element>[] = [];
const clipboardRestorers: Array<() => void> = [];

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  clipboardRestorers.push(() => {
    if (previousDescriptor) Object.defineProperty(navigator, 'clipboard', previousDescriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });
}

async function mountApiDocs(): Promise<{ container: HTMLElement; app: VueApp<Element> }> {
  window.history.replaceState({}, '', '/_site/api-docs');
  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  const router = (app.config.globalProperties as unknown as { $router: Router }).$router;
  await router.isReady();
  await flushPromises();
  return { container, app };
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const restore of clipboardRestorers.splice(0)) restore();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('public API documentation', () => {
  it('replaces the placeholder with public endpoints, response guidance and errors', async () => {
    const { container } = await mountApiDocs();

    expect(container.querySelector('h1')?.textContent).toBe('API documentation');
    expect(container.querySelector('.mm-placeholder-page')).toBeNull();
    expect(container.textContent).not.toContain('This screen is not built yet.');
    expect(container.querySelectorAll('.mm-public-api-endpoint')).toHaveLength(5);
    expect(container.textContent).toContain('without a token');
    expect(container.textContent).toContain('60 per IP per minute');
    expect(container.textContent).toContain('10 per IP per minute');
    expect(container.textContent).toContain('/_public/api/countries/:slug/versions');
    expect(container.textContent).toContain(
      '/_public/api/countries/:slug/download?version=latest|<label>',
    );
    expect(container.textContent).toContain('VERSION_FILE_MISSING');
    expect(container.textContent).toContain('RATE_LIMITED');
    expect(container.textContent).toContain('Retry-After');
    expect(container.querySelectorAll('.mm-public-api-copy')).toHaveLength(5);

    const examples = [
      ['countries', '/_public/api/countries?page=1&limit=25'],
      ['country', '/_public/api/countries/finland'],
      ['versions', '/_public/api/countries/finland/versions?page=1&limit=25'],
      ['download', '/_public/api/countries/finland/download?version=latest'],
      ['stats', '/_public/api/stats'],
    ] as const;
    for (const [id, path] of examples) {
      const command =
        container.querySelector(`#public-api-${id} .mm-public-api-code code`)?.textContent ?? '';
      expect(command).toContain(`'${new URL(path, window.location.origin).href}'`);
      expect(command).toMatch(/^curl --fail --show-error --location/u);
      expect(command).not.toContain('Authorization');
      expect(command).not.toContain('<');
    }
  });

  it('keeps JSON response examples valid against the shared public contracts', async () => {
    const { container } = await mountApiDocs();
    const responseFor = (id: string): unknown => {
      const examples = container.querySelectorAll(`#public-api-${id} pre.mm-public-api-code code`);
      expect(examples).toHaveLength(2);
      return JSON.parse(examples[1]?.textContent ?? 'null') as unknown;
    };

    expect(PublicCountriesResponseSchema.safeParse(responseFor('countries')).success).toBe(true);
    expect(PublicCountryDetailResponseSchema.safeParse(responseFor('country')).success).toBe(true);
    expect(PublicCountryVersionsResponseSchema.safeParse(responseFor('versions')).success).toBe(
      true,
    );
    expect(PublicStatsResponseSchema.safeParse(responseFor('stats')).success).toBe(true);
  });

  it('copies cURL examples with the current origin and reports success', async () => {
    const writeText = vi.fn((_text: string): Promise<void> => Promise.resolve());
    stubClipboard(writeText);
    const { container } = await mountApiDocs();
    const expected = `curl --fail --show-error --location '${window.location.origin}/_public/api/countries?page=1&limit=25'`;

    expect(
      container.querySelector('#public-api-countries .mm-public-api-code code')?.textContent,
    ).toBe(expected);
    container
      .querySelector<HTMLButtonElement>('#public-api-countries .mm-public-api-copy')
      ?.click();
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith(expected);
    expect(
      container.querySelector('#public-api-countries .mm-public-api-copy-status')?.textContent,
    ).toContain('Command copied.');
  });

  it('does not claim a command copied when clipboard access fails', async () => {
    const writeText = vi.fn((_text: string): Promise<void> =>
      Promise.reject(new Error('permission denied')),
    );
    stubClipboard(writeText);
    const { container } = await mountApiDocs();

    container.querySelector<HTMLButtonElement>('#public-api-stats .mm-public-api-copy')?.click();
    await flushPromises();

    expect(writeText).toHaveBeenCalledOnce();
    expect(
      container.querySelector('#public-api-stats .mm-public-api-copy-status')?.textContent,
    ).toContain('Clipboard access failed. Select the command above and copy it manually.');
  });
});
