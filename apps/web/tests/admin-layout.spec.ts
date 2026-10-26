import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { ADMIN_NAV, isNavItemActive, navItemFor } from '../src/router/nav';
import { breadcrumbsFor } from '../src/router/breadcrumbs';
import { ADMIN_ROOT, LOGIN_PAGE, adminPagePaths } from '../src/router/paths';
import { APP_ROUTES } from '../src/router/routes';
import { useAuth } from '../src/stores/auth';
import { MOBILE_BREAKPOINT, SIDEBAR_WIDTH, TOPBAR_HEIGHT } from '../src/layouts/adminShell';

/**
 * The admin shell (`P1-WEB-07`).
 *
 * Mounted as `createWebApp()` — the app the browser gets, at an admin URL, with only `fetch` stubbed — because the shell
 * is the one component whose job is the *assembly*: the drawer toggles the region the page renders into, the trail comes
 * from the route, and the branch that chooses between this shell and a bare `v-main` lives in `App.vue`. A test that
 * mounted `AdminLayout` on its own would prove the markup and not the wiring.
 *
 * Three things are proved here that a screenshot cannot:
 *
 * 1. **It is responsive at the size §3 names.** `window.innerWidth` is set *before* the app is built, because Vuetify's
 *    display reads it when it is created — so 360 px is a real phone-width mount, not a class name asserted on a
 *    desktop.
 * 2. **The navigation is the router's.** Every entry navigates, the active entry follows the path (a country lights up
 *    Cache), and the trail is the same list plus the URL's tail.
 * 3. **The way out works.** Signing out from the menu clears the session, says so, and lands on the login page carrying
 *    the page the reader was on.
 */

/** A profile that satisfies the shared schema. */
const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };

/** What `GET /_auth/api/me` answers. */
const ME = { admin: PROFILE, expiresAt: '2026-10-26T21:00:00.000Z', lastUsedAt: null };

/** Mounted apps, unmounted after each case. */
const mounted: VueApp<Element>[] = [];

/** Sets the viewport width Vuetify will read when the app is built. */
function atWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

/** Router of a mounted app. */
function routerOf(app: VueApp<Element>): Router {
  return (app.config.globalProperties as unknown as { $router: Router }).$router;
}

/**
 * Mounts the app at an admin path, signed in.
 *
 * @param options - `at` (path), `width` (viewport, before the app is built) and `respond` (the `fetch`).
 * @returns The container, the router, the auth store and the `fetch` spy.
 */
async function mountAdmin(
  options: { at?: string; width?: number; respond?: typeof fetch; signedIn?: boolean } = {},
): Promise<{
  container: HTMLElement;
  router: Router;
  auth: ReturnType<typeof useAuth>;
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const signedIn = options.signedIn ?? true;
  if (signedIn) sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_live');
  atWidth(options.width ?? 1280);
  window.history.replaceState({}, '', options.at ?? adminPagePaths.cache());

  const fetchImpl = vi.fn<typeof fetch>(
    options.respond ?? (() => Promise.resolve(new Response(JSON.stringify(ME)))),
  );
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

  const auth = (app.config.globalProperties as unknown as { $pinia: unknown }).$pinia;
  return { container, router, auth: useAuth(auth as never), fetchImpl };
}

/** The sidebar's links, which are the shell's navigation (`v-list` renders a list, not a `<nav>`). */
function navLinks(container: HTMLElement): HTMLAnchorElement[] {
  return [...container.querySelectorAll<HTMLAnchorElement>('[aria-label="Administration"] a')];
}

/** The drawer element — present whether or not it is showing. */
function drawer(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('.v-navigation-drawer');
}

/** Whether the drawer is on screen (Vuetify marks the open state with `--active`). */
function drawerIsOpen(container: HTMLElement): boolean {
  return drawer(container)?.classList.contains('v-navigation-drawer--active') ?? false;
}

/** The breadcrumb labels, in order. */
function crumbLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('nav[aria-label="Breadcrumb"] li')].map((item) =>
    (item.textContent ?? '').replace('›', '').trim(),
  );
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  atWidth(1024);
});

describe('the navigation is the router', () => {
  it('renders one entry per admin screen, in the order the document draws them', async () => {
    const { container } = await mountAdmin({ at: adminPagePaths.dashboard() });

    expect(navLinks(container).map((link) => link.textContent?.trim())).toEqual(
      ADMIN_NAV.map((item) => item.label),
    );
    expect(navLinks(container)).toHaveLength(9);
    // The list is the document's order: Dashboard first, Audit last, Jobs before System (§3's diagram).
    expect(ADMIN_NAV[0]?.label).toBe('Dashboard');
    expect(ADMIN_NAV.at(-1)?.label).toBe('Audit');
    expect(ADMIN_NAV.findIndex((item) => item.label === 'Jobs')).toBeLessThan(
      ADMIN_NAV.findIndex((item) => item.label === 'System'),
    );
  });

  it('marks the entry the reader is on, and only that one', async () => {
    const { container } = await mountAdmin({ at: adminPagePaths.intervals() });

    const current = navLinks(container).filter(
      (link) => link.getAttribute('aria-current') === 'page',
    );
    expect(current.map((link) => link.textContent?.trim())).toEqual(['Intervals']);
  });

  it('keeps a parent entry marked for a child screen', async () => {
    // S8 (a cached country) is under S7, not an entry of its own: the reader must not lose the sidebar's answer to
    // "where am I?" one click in.
    const { container } = await mountAdmin({ at: adminPagePaths.cacheCountry('finland') });

    const current = navLinks(container).filter(
      (link) => link.getAttribute('aria-current') === 'page',
    );
    expect(current.map((link) => link.textContent?.trim())).toEqual(['Cache']);
    expect(crumbLabels(container)).toEqual(['Dashboard', 'Cache', 'finland']);
  });

  it('navigates when an entry is clicked', async () => {
    const { container, router } = await mountAdmin({ at: adminPagePaths.dashboard() });

    const audit = navLinks(container).find((link) => link.textContent?.trim() === 'Audit');
    audit?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // A router navigation resolves over several ticks (guards, then the scroll behaviour), so the assertion waits for the
    // commit rather than guessing a number of flushes.
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe(adminPagePaths.audit());
    });
    await flushPromises();
    expect(container.textContent).toContain('Screen S14');
  });
});

describe('the topbar', () => {
  it('carries the trail, with the last step marked as the page', async () => {
    const { container } = await mountAdmin({ at: adminPagePaths.cache() });

    expect(crumbLabels(container)).toEqual(['Dashboard', 'Cache']);
    expect(container.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('Cache');
    // §7: a landmark, not a div soup — the trail is a `<nav>` with a name.
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull();
  });

  it('links every step but the last', async () => {
    const { container } = await mountAdmin({ at: adminPagePaths.jobs() });

    const links = [...container.querySelectorAll('nav[aria-label="Breadcrumb"] a')];
    expect(links.map((link) => link.textContent?.trim())).toEqual(['Dashboard']);
    expect(links[0]?.getAttribute('href')).toBe(`${ADMIN_ROOT}/`);
  });

  it('names the signed-in admin once /me answers', async () => {
    // The boot check of `04-api.md` §1: the profile is not persisted, so the bar shows "Signed in" until the API says who.
    const { container, fetchImpl } = await mountAdmin({ at: adminPagePaths.dashboard() });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toContain('/_auth/api/me');
    expect(container.textContent).toContain('admin');
    expect(container.textContent).not.toContain('Signed in');
  });

  it('keeps the session and says so plainly when /me cannot be reached', async () => {
    // `restore()` answers `unverified` for an outage (`stores/auth.ts`): no sign-out, and a label that does not claim a
    // name nobody told it.
    const { container, auth } = await mountAdmin({
      at: adminPagePaths.dashboard(),
      respond: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    expect(auth.isAuthenticated).toBe(true);
    expect(container.textContent).toContain('Signed in');
  });

  it('asks nobody when the profile is already known', async () => {
    // A second navigation into the admin area must not re-ask for a name the store already holds.
    const { fetchImpl, router } = await mountAdmin({ at: adminPagePaths.dashboard() });
    const calls = fetchImpl.mock.calls.length;

    await router.push(adminPagePaths.cache());
    await flushPromises();

    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it('sends a catalog search to the catalog screen, in the URL', async () => {
    // §3 lists global search in the topbar. It navigates: `P2-WEB-01` owns the query, and the term belongs in the URL so
    // the view can be bookmarked.
    const { container, router } = await mountAdmin({ at: adminPagePaths.dashboard() });

    const field = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(field, 'the topbar must carry a search field').not.toBeNull();
    if (field === null) return;
    field.value = 'finland';
    field.dispatchEvent(new Event('input'));
    await flushPromises();
    container.querySelector<HTMLFormElement>('form[role="search"]')?.requestSubmit();

    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('admin-catalog');
    });
    expect(router.currentRoute.value.query['q']).toBe('finland');
  });
});

describe('the way out', () => {
  it('signs out from the user menu, and returns to the login page with the destination', async () => {
    const { container, router, auth } = await mountAdmin({ at: adminPagePaths.jobs() });

    // The menu's activator says who is signed in; the item is in the overlay, which Vuetify teleports to `document.body`.
    const activator = [...container.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes('admin'),
    );
    activator?.click();
    await flushPromises();

    const signOut = document.querySelector<HTMLElement>('[data-test="sign-out"]');
    expect(signOut, 'the menu must offer a way out').not.toBeNull();
    signOut?.click();
    await flushPromises();
    await flushPromises();

    expect(auth.isAuthenticated).toBe(false);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
    // The page they were on, so signing back in puts them there: the same `loginRedirectFor` the guard uses.
    expect(router.currentRoute.value.query['redirect']).toBe(adminPagePaths.jobs());
  });

  it('says the session ended, and does not say it twice', async () => {
    const { container } = await mountAdmin({ at: adminPagePaths.jobs() });

    [...container.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '').includes('admin'))
      ?.click();
    await flushPromises();
    document.querySelector<HTMLElement>('[data-test="sign-out"]')?.click();
    await flushPromises();

    // The toast is in the overlay, teleported like the menu.
    const text = document.body.textContent ?? '';
    expect(text).toContain('You have signed out.');
    expect(text.match(/You have signed out\./gu)).toHaveLength(1);
  });
});

describe('at 360 px', () => {
  it('starts with the drawer closed, so the page is not covered by it', async () => {
    // §3's criterion is "responsive to 360 px (drawer)". At that width the sidebar must not be sitting on top of the
    // content; Vuetify's display is read when the app is built, so this is a real phone-width mount.
    const { container } = await mountAdmin({ at: adminPagePaths.dashboard(), width: 360 });

    expect(drawerIsOpen(container)).toBe(false);
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="mm-admin-drawer"]',
    );
    expect(button?.textContent?.trim()).toBe('Menu');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens it as a temporary overlay, and closes it after a navigation', async () => {
    const { container, router } = await mountAdmin({
      at: adminPagePaths.dashboard(),
      width: 360,
    });

    container.querySelector<HTMLButtonElement>('button[aria-controls="mm-admin-drawer"]')?.click();
    await flushPromises();

    expect(drawerIsOpen(container)).toBe(true);
    // Temporary, not permanent: the drawer is above the page, and Vuetify says so with a class.
    expect(drawer(container)?.className).toContain('v-navigation-drawer--temporary');

    await router.push(adminPagePaths.system());
    await flushPromises();

    // The page the reader asked for must not be behind a panel they have already used.
    expect(drawerIsOpen(container)).toBe(false);
  });

  it('is a desktop drawer again above the boundary', async () => {
    const { container } = await mountAdmin({
      at: adminPagePaths.dashboard(),
      width: MOBILE_BREAKPOINT + 1,
    });

    expect(drawerIsOpen(container)).toBe(true);
    expect(
      container
        .querySelector<HTMLButtonElement>('button[aria-controls="mm-admin-drawer"]')
        ?.textContent?.trim(),
    ).toBe('Hide menu');
  });
});

describe('the shell is reachable and honest', () => {
  it('puts a skip link first, pointing at the main region', async () => {
    // §7 asks for one in the admin. It has to be the first focusable element in the document, or it skips nothing.
    const { container } = await mountAdmin({ at: adminPagePaths.dashboard() });

    const focusable = container.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex]');
    const first = focusable[0];
    expect(first?.classList.contains('mm-skip-link')).toBe(true);
    expect(first?.getAttribute('href')).toBe('#mm-main');

    const main = container.querySelector('main#mm-main');
    expect(main, 'the skip link needs a target that exists').not.toBeNull();
    // `-1` so the anchor moves focus, not only the scroll position — otherwise the next Tab lands back in the topbar.
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  it('styles the skip link: hidden until focused, and it says so in the stylesheet', () => {
    // A class with no rule is an unstyled anchor sitting at the top of every admin page, and jsdom has no CSS to notice.
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/shell.css'), 'utf8');
    expect(css).toMatch(/\.mm-skip-link\s*\{[^}]*clip-path:\s*inset\(50%\)/u);
    expect(css).toMatch(/\.mm-skip-link:focus-visible\s*\{[^}]*clip-path:\s*none/u);
  });

  it('styles only classes the shell actually renders', async () => {
    // A rule whose selector matches nothing is a fix that is not there — and neither the typecheck nor a DOM assertion
    // notices, because the CSS is loaded by `main.ts` and jsdom computes none of it. Measured in pass 36: the 360 px rule
    // hid the trail through `.mm-admin-topbar .mm-breadcrumbs`, an ancestor class the layout never had, so on the
    // narrowest phone §3 names the trail stayed in the topbar.
    //
    // Every class in `styles/shell.css` is therefore required to exist in the shell. That is a deliberately strict rule:
    // the file is *the shell's* stylesheet, and the day a rule serves another area it moves to that area's file.
    // A country's page, not the dashboard: the dashboard's trail has one step and therefore no link and no divider, so the
    // deepest screen is the one that renders every class the file styles.
    const { container } = await mountAdmin({ at: adminPagePaths.cacheCountry('finland') });
    // Comments are stripped first: this file names its own selectors in prose, and the prose is not a selector.
    const css = readFileSync(
      resolve(import.meta.dirname, '../src/styles/shell.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//gu, '');
    const classes = new Set([...css.matchAll(/\.[a-z][a-z0-9-]*/gu)].map(([name]) => name));

    expect(classes.size).toBeGreaterThan(2);
    const dead = [...classes].filter((name) => container.querySelector(name) === null);
    expect(dead, 'classes styled but never rendered').toEqual([]);
  });

  it('hides the trail below 600 px so the topbar fits 360', () => {
    // The rule itself, read from the file: `display: none` under 600 px, and the trail is a direct child of the bar — no
    // ancestor class in the selector, which is what the defect above was.
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/shell.css'), 'utf8');
    const mobile = /@media \(max-width: 599px\) \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? '';
    expect(mobile).toMatch(/\.mm-breadcrumbs\s*\{\s*display:\s*none/u);
    expect(mobile).not.toMatch(/\.mm-admin-topbar/u);
  });

  it('renders no icon the app cannot draw', async () => {
    // The icon font is not installed (pass 35): a `.mdi` element is an empty box. Vuetify's own defaults supply some —
    // `v-app-bar-nav-icon`'s menu glyph, the breadcrumb divider, the user menu — so this asserts the shell's, not one
    // component's, and it is the reason every control here is labelled text.
    const { container } = await mountAdmin({ at: adminPagePaths.dashboard() });

    expect(container.querySelectorAll('.mdi')).toHaveLength(0);
  });

  it('uses the measurements the document states', async () => {
    // §3's numbers, asserted where they are used: a sidebar of another width is a different shell, and the topbar's
    // height is what the page's first row is laid out against.
    expect(SIDEBAR_WIDTH).toBe(248);
    expect(TOPBAR_HEIGHT).toBe(64);
    expect(MOBILE_BREAKPOINT).toBe(1024);

    const { container } = await mountAdmin({ at: adminPagePaths.dashboard() });
    expect(drawer(container)?.style.width).toBe(`${String(SIDEBAR_WIDTH)}px`);
    // The bar's height is applied to its content box, which is what the bar's own box grows to.
    expect(
      container.querySelector('.v-app-bar .v-toolbar__content')?.getAttribute('style') ?? '',
    ).toContain(`${String(TOPBAR_HEIGHT)}px`);

    const doc = readFileSync(resolve(import.meta.dirname, '../../../docs/13-ui-ux.md'), 'utf8');
    expect(doc).toMatch(/Sidebar 248 px/u);
    expect(doc).toMatch(/< 1024 px/u);
    expect(doc).toMatch(/topbar 64px/u);
  });

  it('leaves the public pages on the bare main region', async () => {
    // The branch in `App.vue` is on the area (`theme/policy.ts`), so the public home must not grow an admin drawer — and
    // the theme's own rule already says which area a path is in.
    const { container } = await mountAdmin({ at: `${ADMIN_ROOT}/` });
    expect(drawer(container)).not.toBeNull();

    window.history.replaceState({}, '', '/_site/');
    const app = createWebApp();
    mounted.push(app);
    const publicContainer = document.createElement('div');
    document.body.append(publicContainer);
    app.mount(publicContainer);
    await routerOf(app).isReady();
    await flushPromises();

    expect(publicContainer.querySelector('.v-navigation-drawer')).toBeNull();
    expect(publicContainer.querySelector('.v-app-bar')).toBeNull();
  });
});

describe('the navigation data matches the router', () => {
  const adminRoutes = APP_ROUTES.filter(
    (route) => typeof route.path === 'string' && route.path.startsWith(`${ADMIN_ROOT}/`),
  );

  it('has one entry per admin screen, and no entry without a screen', () => {
    // The sidebar and the route table are two descriptions of one fact. A screen added to the router without a sidebar
    // entry is a page nobody can reach; an entry without a route is a link that 404s.
    const screens = new Set(ADMIN_NAV.map((item) => item.screen));
    const routed = new Set(
      adminRoutes
        .map((route) => route.meta?.screen)
        .filter((screen): screen is string => typeof screen === 'string' && screen !== 'S8'),
    );

    expect([...screens].sort()).toEqual([...routed].sort());
    // S8 is the one admin screen that is deliberately not in the sidebar: it is reached from S7.
    expect(screens.has('S8')).toBe(false);
  });

  it('points every entry at a route that exists, under the admin root', () => {
    for (const item of ADMIN_NAV) {
      const route = APP_ROUTES.find((candidate) => candidate.name === item.name);
      expect(route, `${item.label} must name a real route`).toBeDefined();
      expect(route?.path).toBe(item.path);
      expect(item.path.startsWith(`${ADMIN_ROOT}/`)).toBe(true);
    }
  });

  it('marks exactly one entry active for every admin path it owns', () => {
    for (const item of ADMIN_NAV) {
      const active = ADMIN_NAV.filter((candidate) => isNavItemActive(candidate, item.path));
      expect(
        active.map((entry) => entry.name),
        item.label,
      ).toEqual([item.name]);
    }
    // The dashboard is the root with or without its trailing slash, and the child screen resolves to its parent.
    expect(navItemFor(ADMIN_ROOT)?.label).toBe('Dashboard');
    // A filtered URL is the same screen (§6 keeps sort and filters in the query), so the entry stays lit.
    expect(
      isNavItemActive(
        ADMIN_NAV[5] as (typeof ADMIN_NAV)[number],
        '/_site/admin/jobs?status=failed',
      ),
    ).toBe(true);
    expect(navItemFor(`${adminPagePaths.cache()}/finland`)?.label).toBe('Cache');
    expect(navItemFor('/_site/administrators')).toBeUndefined();
  });
});

describe('breadcrumbs', () => {
  const at = (path: string, title = 'A page'): { path: string; meta: { title: string } } => ({
    path,
    meta: { title },
  });

  it('is one step on the dashboard, and it is not a link', () => {
    expect(breadcrumbsFor(at(adminPagePaths.dashboard()))).toEqual([
      { label: 'Dashboard', to: null },
    ]);
  });

  it('walks from the dashboard down to the page', () => {
    expect(breadcrumbsFor(at(adminPagePaths.audit()))).toEqual([
      { label: 'Dashboard', to: `${ADMIN_ROOT}/` },
      { label: 'Audit', to: null },
    ]);
  });

  it('adds the URL tail below a sidebar entry, decoded', () => {
    expect(breadcrumbsFor(at(adminPagePaths.cacheCountry('côte d’ivoire')))).toEqual([
      { label: 'Dashboard', to: `${ADMIN_ROOT}/` },
      { label: 'Cache', to: adminPagePaths.cache() },
      { label: 'côte d’ivoire', to: null },
    ]);
  });

  it('keeps a segment it cannot decode rather than throwing', () => {
    // A hand-typed `%` is not an escape sequence, and `decodeURIComponent` throws on it. A render is not the place to
    // fail over a breadcrumb: the raw segment is what the reader typed.
    expect(breadcrumbsFor(at(`${adminPagePaths.cache()}/100%`)).at(-1)).toEqual({
      label: '100%',
      to: null,
    });
    expect(breadcrumbsFor(at(`${adminPagePaths.cache()}/%E0%A4%A`)).at(-1)).toEqual({
      label: '%E0%A4%A',
      to: null,
    });
  });

  it('names the route for an admin path no entry owns', () => {
    // `/_site/admin/nope` renders the not-found page *inside* the shell (the area is what picks the shell, not the route),
    // so the trail has to be honest about a page the sidebar does not list.
    expect(breadcrumbsFor(at('/_site/admin/nope', 'Not found'))).toEqual([
      { label: 'Dashboard', to: `${ADMIN_ROOT}/` },
      { label: 'Not found', to: null },
    ]);
  });

  it('stays out of the way outside the admin area', () => {
    // The public shell has its own header; a trail that invented a parent for `/_site/` would be a lie about the site.
    expect(breadcrumbsFor(at('/_site/'))).toEqual([]);
    expect(breadcrumbsFor(at(LOGIN_PAGE))).toEqual([]);
    expect(breadcrumbsFor(at('/_site/administrators'))).toEqual([]);
  });
});
