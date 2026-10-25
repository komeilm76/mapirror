import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { createAppRouter } from '../src/router';
import { installRouteTitles, pageTitle, TITLE_SUFFIX } from '../src/router/titles';

/**
 * The browser tab (`P1-WEB-03`).
 *
 * `13-ui-ux.md` §9 asks for copy that says where you are, and the tab is the first place a reader looks: fifteen pages
 * all called "MapMirror" is a browser full of identical tabs, and a reader with three of them open has no way to tell
 * the jobs page from the audit log.
 *
 * `document.title` is written through a narrow `{ title: string }` interface rather than read from the global, because
 * jsdom's title is shared by every case in a file — a probe that read it would assert on whatever the previous case's
 * navigation left behind. The interface is also how the "no title at all" branch below is reachable.
 */

describe('the title format', () => {
  it('puts the page first and the product second', () => {
    // Page first: a browser truncates the *end* of a tab, so a title that led with the product name would show
    // "MapMirror · Cach…" for every page at once.
    expect(pageTitle('Cache')).toBe(`Cache · ${TITLE_SUFFIX}`);
    expect(TITLE_SUFFIX).toBe('MapMirror');
  });

  it('keeps a title that already carries punctuation intact', () => {
    expect(pageTitle('Audit log — 2,431 entries')).toBe('Audit log — 2,431 entries · MapMirror');
  });
});

describe('the writer follows the router', () => {
  it('writes on install, then on every navigation', async () => {
    const router = createAppRouter();
    const heading = { title: '' };

    installRouteTitles(router, heading);
    // Before any navigation: `createWebHistory()` reads the document's URL, which `tests/setup.ts` left at `/`, so the
    // app router has already resolved the redirect to the home page by the time `app.mount()` runs — but a router built
    // and never navigated has no title, which is the fallback branch.
    expect(heading.title).toBe(TITLE_SUFFIX);

    await router.push('/_site/');
    expect(heading.title).toBe(`Catalog · ${TITLE_SUFFIX}`);

    // A public page: the app router carries the guard, and an admin path here would land on the login page's title —
    // which is the next file's subject, not this one's.
    await router.push('/_site/api-docs');
    expect(heading.title).toBe(`API · ${TITLE_SUFFIX}`);

    // A second navigation to the *same* route still writes: `afterEach` fires, and a title that only updated on change
    // would keep a stale one after a parameter-only navigation such as a country page.
    await router.push('/_site/countries/finland');
    expect(heading.title).toBe(`Country · ${TITLE_SUFFIX}`);
  });

  it('writes the fallback for a route with no title', async () => {
    // The `?? TITLE_SUFFIX` branch: a record whose `meta` carries no title. The `RouteMeta` augmentation makes that a
    // type error for `APP_ROUTES`, but a router is a public API and a redirect-only record can reach it — the fallback
    // exists so such a route produces "MapMirror" rather than "undefined".
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/bare', name: 'bare', component: { render: () => null } }],
    });
    const heading = { title: 'stale title from a previous page' };

    installRouteTitles(router, heading);
    await router.push('/bare');

    // `MapMirror`, not `MapMirror · MapMirror`: the fallback is the product name alone.
    expect(heading.title).toBe(TITLE_SUFFIX);
  });

  it('can be stopped', async () => {
    // The teardown lets a test (or a future re-mount) stop following the router; a hook that outlives its purpose keeps
    // the router object alive and writes to a document that may no longer be the app's.
    const router = createAppRouter();
    const heading = { title: '' };
    const stop = installRouteTitles(router, heading);

    expect(heading.title).toBe(TITLE_SUFFIX);
    stop();
    await router.push('/_site/admin/audit');

    // Still the install-time fallback: the navigation happened, and nothing wrote to it.
    expect(heading.title).toBe(TITLE_SUFFIX);
  });
});
