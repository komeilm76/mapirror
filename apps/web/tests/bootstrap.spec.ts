import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { flushPromises } from '@vue/test-utils';
import { defineStore } from 'pinia';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue';
import { usePreferredDark } from '@vueuse/core';

import { SRC_ALIAS } from '../alias';
import { createWebApp, MOUNT_SELECTOR } from '../src/bootstrap';
import { createAppPinia } from '../src/plugins/pinia';
import { createAppVuetify } from '../src/plugins/vuetify';
import { createAppRouter } from '../src/router';
import { LOGIN_PAGE, SITE_ROOT } from '../src/router/paths';

/**
 * The SPA boots (`P1-WEB-01`).
 *
 * What "boots" means, as assertions rather than adjectives:
 *
 * 1. **The entry point mounts into the element the HTML provides.** `main.ts` mounts to `MOUNT_SELECTOR`; `index.html`
 *    provides it. A mismatch is a blank page that returns `200`, and nothing else in the repository would notice.
 * 2. **The chain renders.** The SFC compiles, Vuetify resolves its components and styles, the router matches, and the
 *    page's text reaches the DOM — read off a real mount, not off a component's props.
 * 3. **Each plugin is installed and does its job**: a Pinia store is usable from a component's setup, the router owns
 *    the location and honours the `/` → `/_site/` redirect, VueUse's media composable has a live value, and Vuetify's
 *    `v-app` wrapper exists (without it every layout in `13-ui-ux.md` §3 collapses).
 * 4. **Nothing leaks between cases.** The plugin factories exist so each mount gets its own Pinia, router and Vuetify.
 */

/** Mounted apps, unmounted after each case so a leaked router listener cannot reach the next one. */
const mounted: VueApp<Element>[] = [];

/**
 * Mounts an app into a fresh container and returns it.
 *
 * @param app - The app to mount; `createWebApp()` unless a case is testing a factory directly.
 * @returns The container element the app rendered into.
 */
async function mountInto(app: VueApp<Element>): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  mounted.push(app);
  app.mount(container);
  // Two flushes, on purpose: `nextTick` renders the shell, then the router's initial navigation resolves and *that*
  // render puts the page inside `v-main`. One flush leaves the text empty, which is exactly how "the app boots but
  // shows nothing" hides in a test.
  await nextTick();
  await flushPromises();
  return container;
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
});

describe('the entry point and the HTML agree', () => {
  it('mounts to the selector index.html actually provides', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');
    // Parsed rather than searched as text: `id="app"` appears in a comment of a draft of this file, and a substring
    // match would happily pass on a document with no mount point at all.
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const target = parsed.querySelector(MOUNT_SELECTOR);

    expect(MOUNT_SELECTOR).toBe('#app');
    expect(target, `index.html must provide ${MOUNT_SELECTOR}`).not.toBeNull();
    // ...and the bundle is the one Vite builds from `src/main.ts`, not a stale path.
    expect(parsed.querySelector('script[type="module"]')?.getAttribute('src')).toBe('/src/main.ts');
  });

  it('really mounts when imported, with a mount point present', async () => {
    // The strongest available statement about `main.ts`: import it, then look at the document. A test that read the
    // file's text would pass on a file whose only failing line was the one that matters.
    document.body.innerHTML = '<div id="app"></div>';
    await import('../src/main');
    await nextTick();
    await flushPromises();

    const root = document.querySelector(MOUNT_SELECTOR);
    expect(root?.querySelector('.v-application')).not.toBeNull();
    expect(root?.textContent).toContain('OpenStreetMap');
  });
});

describe('the build and the typechecker agree about imports', () => {
  it('resolves @ to src, in the bundle and in the tests', async () => {
    // The alias has three consumers and only two can be compared by machine: `tsconfig.json` is JSONC and keeps its
    // own copy of the pattern (its half is proven by `bun run typecheck` — `src/router/index.ts` imports through `@`,
    // so a wrong `paths` entry fails `vue-tsc`). Here the other two are compared, and then used.
    expect(SRC_ALIAS['@']).toBe(resolve(import.meta.dirname, '../src'));

    // The same module, reached two ways: if Vite's alias pointed anywhere else, one of these would be a different
    // module instance and the selector comparison below would still pass while the app was built from two copies.
    const viaAlias = await import('@/bootstrap');
    const viaPath = await import('../src/bootstrap');
    expect(viaAlias).toBe(viaPath);
    expect(viaAlias.MOUNT_SELECTOR).toBe(MOUNT_SELECTOR);
  });
});

describe('the plugins are installed, and each one works', () => {
  it('renders the shell through Vue, Vuetify and the router', async () => {
    const container = await mountInto(createWebApp());

    // Vuetify's root wrapper, without which `v-main` has no height and the page is a blank strip.
    expect(container.querySelector('.v-application')).not.toBeNull();
    // The route's own content, which only renders if the router matched and the SFC compiled.
    expect(container.textContent).toContain('self-hosted mirror');
    // The stack the page claims, read off the rendered chips rather than off the source.
    for (const label of ['Vue ', 'Vuetify ', 'Pinia ', 'Vue Router ', 'VueUse ']) {
      expect(container.textContent, label).toContain(label);
    }
  });

  it('gives a store a working Pinia, from a component setup', async () => {
    const useCounter = defineStore('probe-counter', {
      state: () => ({ count: 0 }),
      actions: {
        increment() {
          this.count += 1;
        },
      },
    });

    const Probe = defineComponent({
      setup() {
        const counter = useCounter();
        counter.increment();
        return () => h('p', { id: 'count' }, String(counter.count));
      },
    });

    const app = createApp(Probe);
    app.use(createAppPinia());
    const container = await mountInto(app);

    // `1`, not `0`: the store worked inside a component's setup, which is the only place "no active Pinia" appears.
    expect(container.querySelector('#count')?.textContent).toBe('1');
  });

  it('gives VueUse a live media value inside a component', async () => {
    // VueUse is in the stack by requirement, so it is asserted where it will be used — a component reading the OS
    // colour preference, which `P1-WEB-02` turns into the public theme toggle. The stub in `tests/setup.ts` reports a
    // light preference, so the rendered text is deterministic.
    const Probe = defineComponent({
      setup() {
        const dark = usePreferredDark();
        return () => h('p', { id: 'theme' }, dark.value ? 'dark' : 'light');
      },
    });

    const app = createApp(Probe);
    app.use(createAppPinia());
    const container = await mountInto(app);

    expect(container.querySelector('#theme')?.textContent).toBe('light');
  });
});

describe('the router', () => {
  it('redirects / to the one URL the site lives at', async () => {
    const router = createAppRouter();
    await router.push('/');
    await router.isReady();

    expect(SITE_ROOT).toBe('/_site/');
    expect(router.currentRoute.value.path).toBe(SITE_ROOT);
    expect(router.currentRoute.value.name).toBe('home');
  });

  it('answers an unknown path with the not-found page, at the URL that was asked for', async () => {
    // `P1-WEB-03` added the catch-all (`P3-WEB-05` owns its copy). Before it, an unmatched path left `matched` empty
    // and rendered a blank frame — a `200` with nothing in it, which is the failure mode this case exists to prevent
    // from coming back. The URL is *not* rewritten to `/not-found`: the visitor's typo is the thing they need to see.
    const router = createAppRouter();
    await router.push(`${SITE_ROOT}no-such-page`);

    expect(router.currentRoute.value.name).toBe('not-found');
    expect(router.currentRoute.value.path).toBe(`${SITE_ROOT}no-such-page`);
  });

  it('moves a path outside the site into the site, rather than rendering it', async () => {
    // L1 has no page outside `/_site/` but `/_auth/login`, so `/somewhere-else` cannot be rendered where it stands; it
    // is redirected to the not-found page, which is the only honest answer.
    const router = createAppRouter();
    await router.push('/somewhere-else');

    expect(router.currentRoute.value.name).toBe('not-found');
    expect(router.currentRoute.value.path).toBe(`${SITE_ROOT}not-found`);
  });

  it('keeps every route inside the site prefix, or at the login page', () => {
    // The L1 half of the router-law test (`tests/law-router.test.ts`, `10-laws.md`): a page outside `/_site/` is legal
    // only at the login path. Stated here as well because this file mounts the app, and a route table could be edited
    // without that file ever running.
    for (const route of createAppRouter().getRoutes()) {
      if (route.path.startsWith(SITE_ROOT) || route.path === LOGIN_PAGE) continue;
      // The two records outside the namespace are `/` and the global catch-all, and both exist for the same reason: a
      // URL the law does not allow must *land* inside the site rather than render at an illegal address. They are
      // redirects, and each one redirects to a page.
      // A redirect is a string, an object or a function; both of these are strings, which the type has to be told so
      // the comparison below does not fall back to `[object Object]`.
      const redirect = route.redirect as string | undefined;
      expect(typeof redirect, `${route.path} is outside the site and does not redirect`).toBe(
        'string',
      );
      expect(redirect, route.path).toMatch(new RegExp(`^${SITE_ROOT}`, 'u'));
    }
  });
});

describe('the factories isolate state', () => {
  it('gives two mounts their own Pinia', () => {
    const useCounter = defineStore('isolation-probe', { state: () => ({ count: 0 }) });

    const first = createAppPinia();
    const second = createAppPinia();
    useCounter(first).count = 3;

    expect(useCounter(second).count).toBe(0);
  });

  it('gives two mounts their own Vuetify and router', () => {
    expect(createAppVuetify()).not.toBe(createAppVuetify());
    expect(createAppRouter()).not.toBe(createAppRouter());
  });
});
