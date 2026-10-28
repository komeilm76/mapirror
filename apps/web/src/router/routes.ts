/**
 * The route table (`P1-WEB-03`).
 *
 * Data, in its own module, for two reasons: `router/index.ts` stays the twelve lines that build a router, and the law
 * test (`tests/law-router.test.ts`) can walk the table without creating a history object or touching `window`.
 *
 * ## What each route carries
 *
 * Every route names the **screen** it is (`13-ui-ux.md` §4, S1…S15) and the **task** that builds it, in `meta`. The
 * augmentation in `src/types/vue-router.d.ts` makes all three fields (`title`, `screen`, `owner`) required, so a route
 * added without them fails the typecheck rather than the review. That is the same trick the auth matrix uses for
 * verdicts (`P1-AUTH-08`): the table cannot fall behind the document without a compiler complaint.
 *
 * ## Which screens are real today
 *
 * Four: the catalog admin screen renders `CatalogPage.vue` (`P2-WEB-01`), `/_site/` renders `HomePage.vue` — still a
 * token/wiring preview until `P3-WEB-01` replaces it — the login page renders `LoginPage.vue` (`P1-WEB-06`), and the
 * not-found catch-all renders `NotFoundPage.vue`. The other eleven are `PlaceholderPage`, which says which screen it
 * stands in for and which task replaces it. A router tree full of invented screens would be worse than one that names
 * its own gaps.
 *
 * ## The two records that are not pages
 *
 * `/` and `/:pathMatch(.*)*` are **redirects**: they render nothing, they only move the browser to a path that is a
 * page. L1 says every page lives under `/_site/` with one exception (`/_auth/login`), and a redirect is not a page —
 * the law test states that distinction rather than pretending these two records do not exist.
 *
 * @module router/routes
 */

import { ROUTE_PREFIXES } from '@mapirror/shared';
import type { RouteRecordRaw } from 'vue-router';

import CatalogPage from '@/pages/admin/CatalogPage.vue';
import LoginPage from '@/pages/auth/LoginPage.vue';
import HomePage from '@/pages/public/HomePage.vue';
import NotFoundPage from '@/pages/public/NotFoundPage.vue';
import PlaceholderPage from '@/pages/PlaceholderPage.vue';
import { ADMIN_ROOT, LOGIN_PAGE, SITE_ROOT, adminPagePaths } from './paths';

/** A screen not yet built: one component, told by `meta` which screen it stands in for. */
function pending(options: {
  readonly path: string;
  readonly name: string;
  readonly title: string;
  readonly screen: string;
  readonly owner: string;
}): RouteRecordRaw {
  // Only the three documented fields reach `meta`: spreading the whole object also copied `path` and `name`, and a copy
  // of a path inside a route is a fact that can drift from the route itself.
  const meta = {
    title: options.title,
    screen: options.screen,
    owner: options.owner,
    placeholder: true,
  };
  return { path: options.path, name: options.name, component: PlaceholderPage, meta };
}

/**
 * Every route in the SPA, in navigation-priority order.
 *
 * The catch-alls are last, in the order Vue Router needs: the `/_site/` one first, so a bad site path renders the
 * not-found page **at the URL the visitor typed** rather than being rewritten to a second one; the global one second,
 * for paths outside the site entirely (a mistyped link, a bookmark from an older version), where the only law-abiding
 * answer is a redirect to a path that is a page.
 */
export const APP_ROUTES: readonly RouteRecordRaw[] = [
  // `GET /` is a redirect, not a page (`12-deployment.md` §5: `curl -sI /` expects `302 → /_site/`).
  { path: '/', redirect: SITE_ROOT },

  // ---- Public (S2–S4) ----
  {
    path: SITE_ROOT,
    name: 'home',
    component: HomePage,
    meta: { title: 'Catalog', screen: 'S2', owner: 'P3-WEB-01', placeholder: true },
  },
  pending({
    path: '/_site/countries/:slug',
    name: 'country',
    title: 'Country',
    screen: 'S3',
    owner: 'P3-WEB-02',
  }),
  pending({
    path: '/_site/api-docs',
    name: 'api-docs',
    title: 'API',
    screen: 'S4',
    owner: 'P3-WEB-04',
  }),

  // ---- Admin (S5–S14). Guarded by path, not by a flag — see `guards.ts` ----
  pending({
    path: adminPagePaths.dashboard(),
    name: 'admin-dashboard',
    title: 'Dashboard',
    screen: 'S5',
    owner: 'P5-MON-04',
  }),
  {
    path: adminPagePaths.catalog(),
    name: 'admin-catalog',
    component: CatalogPage,
    meta: { title: 'Catalog', screen: 'S6', owner: 'P2-WEB-01' },
  },
  pending({
    path: adminPagePaths.cache(),
    name: 'admin-cache',
    title: 'Cache',
    screen: 'S7',
    owner: 'P2-WEB-03',
  }),
  pending({
    path: `${ADMIN_ROOT}/cache/:slug`,
    name: 'admin-cache-country',
    title: 'Cached country',
    screen: 'S8',
    owner: 'P2-WEB-04',
  }),
  pending({
    path: adminPagePaths.intervals(),
    name: 'admin-intervals',
    title: 'Intervals',
    screen: 'S9',
    owner: 'P4-INT-08',
  }),
  pending({
    path: adminPagePaths.import(),
    name: 'admin-import',
    title: 'Import',
    screen: 'S10',
    owner: 'P4-IMP-05',
  }),
  pending({
    path: adminPagePaths.jobs(),
    name: 'admin-jobs',
    title: 'Jobs',
    screen: 'S11',
    owner: 'P2-WEB-06',
  }),
  pending({
    path: adminPagePaths.system(),
    name: 'admin-system',
    title: 'System',
    screen: 'S12',
    owner: 'P5-MON-02',
  }),
  pending({
    path: adminPagePaths.settings(),
    name: 'admin-settings',
    title: 'Settings',
    screen: 'S13',
    owner: 'P5-ADM-02',
  }),
  pending({
    path: adminPagePaths.audit(),
    name: 'admin-audit',
    title: 'Audit log',
    screen: 'S14',
    owner: 'P5-ADM-04',
  }),

  // ---- Auth (S1): the only page outside `/_site` (D-19) ----
  {
    path: LOGIN_PAGE,
    name: 'login',
    component: LoginPage,
    meta: { title: 'Sign in', screen: 'S1', owner: 'P1-WEB-06' },
  },

  // ---- Not found (S15) ----
  {
    path: `${ROUTE_PREFIXES.site}/:pathMatch(.*)*`,
    name: 'not-found',
    component: NotFoundPage,
    meta: { title: 'Not found', screen: 'S15', owner: 'P3-WEB-05' },
  },
  {
    // Outside the site entirely. A redirect, never a page: L1 has no page outside `/_site/` but the login page.
    path: '/:pathMatch(.*)*',
    redirect: `${ROUTE_PREFIXES.site}/not-found`,
  },
];
