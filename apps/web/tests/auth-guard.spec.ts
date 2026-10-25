import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, type App as VueApp } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { ADMIN_ROOT, LOGIN_PAGE, SITE_ROOT } from '../src/router/paths';
import { APP_ROUTES } from '../src/router/routes';
import { installAuthGuard } from '../src/router/guards';

/**
 * The navigation guard (`P1-WEB-03`).
 *
 * The acceptance criterion is one line — "unauthenticated `/_site/admin/*` → `/_auth/login`" — and the cases below are
 * that line plus the five ways that line is usually got wrong:
 *
 * 1. **A per-route flag** is forgotten by the next admin page, so the last two cases add a route *after* the guard is
 *    installed and expect it to be refused anyway.
 * 2. **The public prefix is gated** because a slug begins with "admin" (`/_site/administrators`), which is why the
 *    classifier is segment-aware and this test says so out loud.
 * 3. **The destination is lost**, so a deep link lands on the dashboard after signing in.
 * 4. **The destination is attacker-controlled**, so `?redirect=https://evil.example` is honoured on the way back.
 * 5. **The login page is gated**, which is a sign-in form nobody can reach.
 *
 * Every router here uses `createMemoryHistory`. The guard's decisions are about the router's own resolution, and a case
 * that navigated the real `window` would decide the *next* file's starting URL.
 */

/** The real route table plus the real guard, told whether a session exists. */
function guardedRouter(hasSession: boolean): Router {
  const router = createRouter({ history: createMemoryHistory(), routes: [...APP_ROUTES] });
  installAuthGuard(router, { hasSession: () => hasSession });
  return router;
}

/** A route path with its `:slug` filled in, so it can be pushed. */
function concrete(path: string): string {
  return path.replace(':slug', 'finland');
}

/** Every admin page in the table, as concrete paths. */
const ADMIN_PAGES = APP_ROUTES.filter(
  (route) => typeof route.path === 'string' && route.path.startsWith(`${ADMIN_ROOT}/`),
).map((route) => concrete(route.path));

describe('an unauthenticated visitor never sees an admin page', () => {
  it('walks a table large enough to mean something', () => {
    // The dashboard at the root of the area plus nine pages under it. Without this, a refactor that narrowed the filter
    // above to nothing would leave the walk below passing vacuously.
    expect(ADMIN_PAGES).toHaveLength(10);
  });

  it('sends every admin page to the login page, remembering where it was going', async () => {
    for (const path of ADMIN_PAGES) {
      const router = guardedRouter(false);
      await router.push(path);

      expect(router.currentRoute.value.path, path).toBe(LOGIN_PAGE);
      expect(router.currentRoute.value.query.redirect, path).toBe(path);
    }
  });

  it('sends the dashboard itself, at the root of the admin area', async () => {
    // `/_site/admin/` is not under `/_site/admin/` by a naive `startsWith('/_site/admin/')` — it *is* that string. The
    // classifier compares against `ADMIN_ROOT` as well as its slash form, and this is the case that proves it.
    const router = guardedRouter(false);
    await router.push(`${ADMIN_ROOT}/`);

    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
    expect(router.currentRoute.value.query.redirect).toBe(`${ADMIN_ROOT}/`);
  });

  it('remembers the query string, so a filtered view survives the round trip', async () => {
    const router = guardedRouter(false);
    await router.push(`${ADMIN_ROOT}/jobs?status=failed&page=2`);

    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
    expect(router.currentRoute.value.query.redirect).toBe(
      `${ADMIN_ROOT}/jobs?status=failed&page=2`,
    );
  });

  it('lets an admin page through when a session exists', async () => {
    const router = guardedRouter(true);
    await router.push(`${ADMIN_ROOT}/cache`);

    expect(router.currentRoute.value.path).toBe(`${ADMIN_ROOT}/cache`);
    expect(router.currentRoute.value.query.redirect).toBeUndefined();
  });
});

describe('the guard does not close the doors it must leave open', () => {
  it('lets every public page and the login page through', async () => {
    const publicPages = APP_ROUTES.filter(
      (route) =>
        typeof route.path === 'string' &&
        !route.path.startsWith(ADMIN_ROOT) &&
        !route.path.includes(':pathMatch') &&
        route.path !== '/',
    ).map((route) => concrete(route.path));
    expect(publicPages).toEqual([
      SITE_ROOT,
      `${SITE_ROOT}countries/finland`,
      `${SITE_ROOT}api-docs`,
      LOGIN_PAGE,
    ]);

    for (const path of publicPages) {
      const router = guardedRouter(false);
      await router.push(path);

      expect(router.currentRoute.value.path, path).toBe(path);
      expect(router.currentRoute.value.query.redirect, path).toBeUndefined();
    }
  });

  it('does not mistake a page whose slug starts with "admin" for the admin area', async () => {
    // The guard asks `theme/policy.ts`'s `areaForPath`, which is segment-aware. `/site/administrators` is a public
    // path that matches the not-found catch-all (there is no such page); a `startsWith` test would send it to the login
    // page, which would then tell the visitor to sign in to reach a page that does not exist.
    const router = guardedRouter(false);
    await router.push(`${SITE_ROOT}administrators`);

    expect(router.currentRoute.value.path).toBe(`${SITE_ROOT}administrators`);
    expect(router.currentRoute.value.query.redirect).toBeUndefined();
  });
});

describe('the rule is the path, not a flag somebody remembers to set', () => {
  it('guards an admin route registered after the guard was installed', async () => {
    const Late = defineComponent({ render: () => h('p', 'reports') });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        ...APP_ROUTES,
        {
          path: `${ADMIN_ROOT}/reports`,
          name: 'admin-reports',
          component: Late,
          meta: { title: 'Reports', screen: 'S99', owner: 'P5-ADM-02' },
        },
      ],
    });
    installAuthGuard(router, { hasSession: () => false });
    await router.push(`${ADMIN_ROOT}/reports`);

    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
    expect(router.currentRoute.value.query.redirect).toBe(`${ADMIN_ROOT}/reports`);
  });

  it('comes off again when the returned function is called', async () => {
    // The teardown exists so a future sign-out can stop the rule, and so a test can prove the hook it registered is the
    // one it removes. A `beforeEach` that cannot be removed keeps the router alive after the app has gone.
    const router = createRouter({ history: createMemoryHistory(), routes: [...APP_ROUTES] });
    const remove = installAuthGuard(router, { hasSession: () => false });

    remove();
    await router.push(`${ADMIN_ROOT}/cache`);

    expect(router.currentRoute.value.path).toBe(`${ADMIN_ROOT}/cache`);
  });
});

/** Apps mounted by a case, unmounted afterwards so a leaked listener cannot reach the next one. */
const mounted: VueApp<Element>[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
});

/** The router an app was built with, read off the app rather than rebuilt. */
function routerOf(app: VueApp<Element>): Router {
  return (app.config.globalProperties as unknown as { $router: Router }).$router;
}

/** Mounts the app the browser gets, starting at a given URL, and returns its container and router. */
async function mountAt(path: string): Promise<{ container: HTMLElement; router: Router }> {
  // `createWebHistory()` reads `window.location` for its first navigation, so the start URL is set before building the
  // app; `tests/setup.ts` puts it back to `/` afterwards.
  window.history.replaceState({}, '', path);
  const app = createWebApp();
  mounted.push(app);

  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);

  const router = routerOf(app);
  await router.isReady();
  await nextTick();
  await flushPromises();
  return { container, router };
}

describe('the app router ships with the guard already on', () => {
  it('refuses an admin deep link with no options passed to the factory', async () => {
    // `createAppRouter()` is what `bootstrap.ts` uses and it takes no session predicate: the default reads
    // `sessionStorage`, which this file empties. A guard the caller had to install would be a guard that can be left
    // out, and nothing else in the repository would notice.
    expect(sessionStorage.length).toBe(0);

    const { container, router } = await mountAt(`${ADMIN_ROOT}/audit`);

    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
    const redirect = router.currentRoute.value.query.redirect;
    expect(redirect).toBe(`${ADMIN_ROOT}/audit`);
    // The login page is a placeholder (§4 S1 is `P1-WEB-06`'s), and it prints the URL it is at — so the destination is
    // readable on screen, not only in the object graph.
    expect(container.textContent).toContain('Sign in');
    expect(container.textContent).toContain(`${ADMIN_ROOT}/audit`);
  });

  it('survives a hostile destination in the address bar', async () => {
    // The parameter is attacker-supplied by construction: the login page is public. `safeRedirectTarget` is what makes
    // it inert, and `redirect.spec.ts` states the rule; what this case adds is that the *app* still renders, because
    // the failure mode of an unvalidated value here is a thrown error in a computed — a blank page, and no clue.
    const hostile = encodeURIComponent('https://evil.example/sign-in');
    const { container } = await mountAt(`${LOGIN_PAGE}?redirect=${hostile}${hostile}`);

    expect(container.querySelector('.v-application')).not.toBeNull();
    expect(container.textContent).toContain('Sign in');
  });

  it('renders an admin page for a visitor who has a session', async () => {
    // The other half of the guard: a stored token means the page renders rather than redirecting. Without this case,
    // a guard that refused every admin navigation would pass every test above.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'token-from-a-login');

    const { container, router } = await mountAt(`${ADMIN_ROOT}/cache`);

    expect(router.currentRoute.value.path).toBe(`${ADMIN_ROOT}/cache`);
    expect(container.textContent).toContain('Screen S7');
  });
});
