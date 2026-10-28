import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { createAppVuetify } from '../src/plugins/vuetify';
import { APP_ROUTES } from '../src/router/routes';
import { areaForPath, installThemeSync, themeForPath } from '../src/theme/policy';
import {
  DARK_PALETTE,
  DARK_THEME_NAME,
  LIGHT_PALETTE,
  LIGHT_THEME_NAME,
} from '../src/styles/tokens';

/**
 * The theme wiring (`P1-WEB-02`).
 *
 * Two questions, both easy to answer wrongly and both invisible in a screenshot of one page:
 *
 * 1. **Which theme does a path get?** The mapping is `13-ui-ux.md` §1's: admin is dark, public is light, auth follows
 *    the operating system. The interesting cases are the boundaries — `/_site/administrators` is a *public* page whose
 *    slug starts with "admin", and a naive `startsWith` would paint it dark.
 * 2. **Does the running app actually switch?** `installThemeSync` is the only thing that changes the theme, so these
 *    cases mount a router with the real route table and a real Vuetify instance and watch `theme.global.name` move.
 *
 * The system preference is injected as a plain `ref` — no jsdom media-query stub, and a system change can be simulated
 * by writing to it, which is the only way to test the auth area's "follows the system" rule.
 */

/**
 * A router that has finished its first navigation.
 *
 * Built from the real route table but **without the auth guard**, because the theme is a function of the path and this
 * file is about the mapping. Since `P1-WEB-03` an unsigned visitor never reaches an admin path at all, so a router with
 * the guard on would answer every admin case here with the login page — a light page about which this file has nothing
 * to say. The guard is `tests/auth-guard.spec.ts`'s subject, and the mounted-app section below pairs the two by signing
 * in and then reading the theme off the DOM.
 */
async function readyRouter(path = '/') {
  const router = createRouter({ history: createMemoryHistory(), routes: [...APP_ROUTES] });
  await router.push(path);
  await router.isReady();
  return router;
}

describe('areaForPath', () => {
  it('puts every documented page in its area', () => {
    expect(areaForPath('/_site/')).toBe('public');
    expect(areaForPath('/_site/countries')).toBe('public');
    expect(areaForPath('/_site/countries/finland')).toBe('public');
    expect(areaForPath('/_site/api-docs')).toBe('public');
    expect(areaForPath('/_site/admin')).toBe('admin');
    expect(areaForPath('/_site/admin/')).toBe('admin');
    expect(areaForPath('/_site/admin/cache/finland')).toBe('admin');
    expect(areaForPath('/_auth/login')).toBe('auth');
  });

  it('does not mistake a public slug for the admin area', () => {
    // The segment-boundary bug, as a case. `/_site/administrators` and `/_site/admin-logs` are public pages that a
    // `startsWith('/_site/admin')` test would paint as the dark control room.
    expect(areaForPath('/_site/administrators')).toBe('public');
    expect(areaForPath('/_site/admin-logs')).toBe('public');
    // ...and the same for the auth prefix: only the login page itself is the auth area.
    expect(areaForPath('/_auth/login-help')).toBe('public');
  });

  it('ignores a query string and a fragment', () => {
    // The router's `path` has neither, but `afterEach` handlers and tests pass hrefs.
    expect(areaForPath('/_site/admin/catalog?sort=size')).toBe('admin');
    expect(areaForPath('/_auth/login#form')).toBe('auth');
    expect(areaForPath('/_site/countries?q=fin#top')).toBe('public');
  });
});

describe('themeForPath', () => {
  it('is dark for the admin area, whatever the system prefers', () => {
    // §1: "Admin — dark (default)". A control room at 02:00 is not a place for a white page, and an OS preference is
    // not an argument for one.
    for (const path of ['/_site/admin', '/_site/admin/jobs', '/_site/admin/settings']) {
      expect(themeForPath(path, { prefersDark: false }), path).toBe(DARK_THEME_NAME);
      expect(themeForPath(path, { prefersDark: true }), path).toBe(DARK_THEME_NAME);
    }
  });

  it('is light for the public area, whatever the system prefers', () => {
    // §1: "Public — light (default)". The per-visitor toggle that overrides this is `P3-WEB-01`'s, and it will be
    // explicit; the system preference on its own must not repaint the catalog.
    for (const path of ['/_site/', '/_site/countries/finland']) {
      expect(themeForPath(path, { prefersDark: true }), path).toBe(LIGHT_THEME_NAME);
      expect(themeForPath(path, { prefersDark: false }), path).toBe(LIGHT_THEME_NAME);
    }
  });

  it('follows the system on the login page', () => {
    // §1: "Auth — follows system theme."
    expect(themeForPath('/_auth/login', { prefersDark: true })).toBe(DARK_THEME_NAME);
    expect(themeForPath('/_auth/login', { prefersDark: false })).toBe(LIGHT_THEME_NAME);
  });
});

describe('the two themes', () => {
  it('registers both, defaulting to light', () => {
    const vuetify = createAppVuetify();
    expect(vuetify.theme.global.name.value).toBe(LIGHT_THEME_NAME);
    expect(Object.keys(vuetify.theme.themes.value).sort()).toEqual([
      DARK_THEME_NAME,
      LIGHT_THEME_NAME,
    ]);
    expect(vuetify.theme.themes.value[LIGHT_THEME_NAME]?.dark).toBe(false);
    expect(vuetify.theme.themes.value[DARK_THEME_NAME]?.dark).toBe(true);
  });

  it("maps the document's surfaces to Vuetify's keys", () => {
    // The table at the top of `styles/tokens.ts`, asserted: `v-app` paints `background`, `v-card`/`v-menu` paint
    // `surface`, and a menu the colour of the page is invisible.
    for (const [name, palette] of [
      [LIGHT_THEME_NAME, LIGHT_PALETTE],
      [DARK_THEME_NAME, DARK_PALETTE],
    ] as const) {
      const colors = (createAppVuetify().theme.themes.value[name]?.colors ?? {}) as Record<
        string,
        string
      >;
      expect(colors.background, `${name} background`).toBe(palette.surface);
      expect(colors.surface, `${name} surface`).toBe(palette['surface-variant']);
      expect(colors['surface-variant'], `${name} surface-variant`).toBe(palette['surface-variant']);
      // Ink defaults, so an unstyled paragraph is body text rather than Vuetify's black/white.
      expect(colors['on-background'], `${name} on-background`).toBe(palette['text-primary']);
      expect(colors['on-surface'], `${name} on-surface`).toBe(palette['text-primary']);
      // Every documented colour is reachable as a theme key, by the name the document uses.
      for (const key of [
        'primary',
        'secondary',
        'accent',
        'success',
        'warning',
        'error',
        'border',
        'border-strong',
        'text-secondary',
      ] as const) {
        expect(colors[key], `${name} ${key}`).toBe(palette[key]);
      }
    }
  });

  it('lets Vuetify derive no label colour it would get wrong', () => {
    // `genOnColors` fills in any missing `on-<key>`. `themeFrom` provides all six fills, computed by WCAG; this asserts
    // the dark pastels did not end up with white labels (white on `#5EEAD4` is 1.48:1 — the exact failure the APCA
    // heuristic can produce and WCAG forbids).
    // Vuetify's `ThemeDefinition['colors']` is already `Record<string, string>`, so the index below is checked by the
    // compiler rather than asserted to it.
    const colors = (name: string): Record<string, string> =>
      createAppVuetify().theme.themes.value[name]?.colors ?? {};

    expect(colors(DARK_THEME_NAME)['on-primary']).toBe('#000000');
    expect(colors(DARK_THEME_NAME)['on-error']).toBe('#000000');
    expect(colors(LIGHT_THEME_NAME)['on-primary']).toBe('#FFFFFF');
  });
});

describe('installThemeSync', () => {
  it('applies the theme of the current route before anything is painted', async () => {
    // A deep link straight to an admin page must not paint light first. `installThemeSync` runs on the route that is
    // already current, which is why the app is built with the router already pushed.
    const router = await readyRouter('/_site/admin/catalog');
    const vuetify = createAppVuetify();
    installThemeSync(router, vuetify, { prefersDark: ref(false) });

    expect(vuetify.theme.global.name.value).toBe(DARK_THEME_NAME);
  });

  it('switches on navigation, in both directions', async () => {
    const router = await readyRouter('/_site/');
    const vuetify = createAppVuetify();
    installThemeSync(router, vuetify, { prefersDark: ref(false) });
    expect(vuetify.theme.global.name.value).toBe(LIGHT_THEME_NAME);

    await router.push('/_site/admin/jobs');
    expect(vuetify.theme.global.name.value, 'admin').toBe(DARK_THEME_NAME);

    await router.push('/_site/countries');
    expect(vuetify.theme.global.name.value, 'back to public').toBe(LIGHT_THEME_NAME);

    await router.push('/_auth/login');
    expect(vuetify.theme.global.name.value, 'auth, system light').toBe(LIGHT_THEME_NAME);
  });

  it('repaints the login page when the system preference changes, and nothing else', async () => {
    const prefersDark = ref(false);
    const router = await readyRouter('/_auth/login');
    const vuetify = createAppVuetify();
    installThemeSync(router, vuetify, { prefersDark });
    expect(vuetify.theme.global.name.value).toBe(LIGHT_THEME_NAME);

    // The OS switches to dark with the login page open: the page follows it.
    prefersDark.value = true;
    await Promise.resolve();
    expect(vuetify.theme.global.name.value, 'auth follows the system').toBe(DARK_THEME_NAME);

    // The same OS change while a public page is open must change nothing — the catalog is light by default and the
    // per-visitor override is an explicit choice, not a system preference.
    await router.push('/_site/');
    expectsLight(vuetify);
    prefersDark.value = false;
    await Promise.resolve();
    expectsLight(vuetify);

    function expectsLight(instance: ReturnType<typeof createAppVuetify>): void {
      expect(instance.theme.global.name.value).toBe(LIGHT_THEME_NAME);
    }
  });

  it('stops when asked to', async () => {
    // The teardown exists for the app's own shutdown and for a test that unmounts; a hook that outlives its app keeps
    // a whole router alive.
    const router = await readyRouter('/_site/');
    const vuetify = createAppVuetify();
    const stop = installThemeSync(router, vuetify, { prefersDark: ref(false) });

    stop();
    await router.push('/_site/admin/catalog');
    expect(vuetify.theme.global.name.value, 'no longer following the route').toBe(LIGHT_THEME_NAME);
  });
});

describe('the mounted app', () => {
  /** Apps mounted by this file, unmounted after each case. */
  const mounted: ReturnType<typeof createWebApp>[] = [];

  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount();
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('wears the light theme on the public page', async () => {
    // The last mile: the palette in `tokens.ts` reaching a class in the DOM. Vuetify writes `v-theme--<name>` on the
    // application wrapper, and every `--v-theme-*` variable hangs off it, so a missing class means no colour resolves.
    const container = document.createElement('div');
    document.body.append(container);
    const app = createWebApp();
    mounted.push(app);
    app.mount(container);
    await nextTick();
    await flushPromises();

    const application = container.querySelector('.v-application');
    expect(application).not.toBeNull();
    expect(application?.className).toContain('v-theme--light');
  });

  it('paints the dark palette inside a dark-scoped subtree', async () => {
    // The home page previews both palettes; the dark one is scoped with `.v-theme--dark`, which redeclares the theme
    // variables for that subtree. This is what makes the preview a real dark render rather than a screenshot.
    const container = document.createElement('div');
    document.body.append(container);
    const app = createWebApp();
    mounted.push(app);
    app.mount(container);
    await nextTick();
    await flushPromises();

    const dark = container.querySelector('.v-theme--dark');
    expect(dark, 'the dark preview subtree must render').not.toBeNull();
    // ...and it is inside the light application, not a second mount.
    expect(container.querySelectorAll('.v-application')).toHaveLength(1);
  });

  it('wears the dark theme on an admin page, once there is a session', async () => {
    // The pairing with `tests/auth-guard.spec.ts`: the guard is what gets an admin page rendered at all, and this is
    // what it looks like when it does. A deep link is the case that matters — a reload on `/_site/admin/catalog` must
    // not paint light and then flip.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'token-from-a-login');
    window.history.replaceState({}, '', '/_site/admin/catalog');

    const container = document.createElement('div');
    document.body.append(container);
    const app = createWebApp();
    mounted.push(app);
    app.mount(container);
    await nextTick();
    await flushPromises();

    expect(container.querySelector('.v-application')?.className).toContain('v-theme--dark');
    // S6 is now the real catalog screen rather than a placeholder.
    expect(container.textContent).toContain('Catalog');
    expect(container.textContent).toContain('The catalog could not be loaded');
  });

  it('follows the system with no options injected, which is how the app installs it', async () => {
    // `installThemeSync(router, vuetify)` with nothing else is the production call, so the default (`usePreferredDark`)
    // must work outside a component. `tests/setup.ts` stubs the media query as "light", so the answer is deterministic.
    const router = await readyRouter('/_auth/login');
    const vuetify = createAppVuetify();
    installThemeSync(router, vuetify);

    expect(vuetify.theme.global.name.value).toBe(LIGHT_THEME_NAME);
  });
});
