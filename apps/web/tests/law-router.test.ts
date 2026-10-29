import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  isApiPath,
  isLegalPath,
  isPagePath,
  LOGIN_PAGE_PATH,
  ROUTE_PREFIXES,
} from '@mapirror/shared';
import { describe, expect, it } from 'vitest';

import { createAppRouter } from '../src/router';
import { ADMIN_ROOT, LOGIN_PAGE } from '../src/router/paths';
import { areaForPath, themeForPath } from '../src/theme/policy';

/**
 * **L1 for the SPA** — the router table, against the law and against the screen inventory (`P1-WEB-03`).
 *
 * `10-laws.md` L1 and `04-api.md` §5 name this file: "every page path starts with `/_site/` (admin pages under
 * `/_site/admin`)". It is one of the two law tests the project calls non-negotiable (`09-development.md` §7), which is
 * why it contains no `skipIf`, no `describe.skip` and no early return: it needs no database, no network and no
 * fixtures, so there is never a reason to skip it, and a law test that can be skipped is a law that can be missing.
 *
 * Four kinds of assertion, each of which catches a different mistake:
 *
 * 1. **The law, per route.** Every path is a legal page path, none collides with an API prefix, and every admin page is
 *    under `/_site/admin`. This is what stops a page being mounted under `/_admin/api` — the mistake that makes a
 *    browser request for HTML answer with a `401` envelope.
 * 2. **The two tables agree.** The routes are compared with `13-ui-ux.md` §4 in **both** directions: a screen with no
 *    route is a page the SPA cannot reach, and a route with no screen is a page nobody specified.
 * 3. **Every route is described.** A title, a screen and the task that owns it — the same three fields
 *    `src/types/vue-router.d.ts` makes required, asserted here so the test proves the table rather than trusting the
 *    compiler to have been run.
 * 4. **The excuses are named.** Two records are not pages (`/` and the global catch-all) and one route is the not-found
 *    page; each is listed here with its reason and asserted to be what it claims, so a third exception cannot appear
 *    without someone writing it down.
 */

const REPO = resolve(import.meta.dirname, '../../..');
const DOC = readFileSync(resolve(REPO, 'docs/13-ui-ux.md'), 'utf8');
const TASKS = readFileSync(resolve(REPO, 'docs/08-tasks.md'), 'utf8');

/** The router table, normalised. */
const ROUTES = createAppRouter().getRoutes();

/**
 * Records that are **not** pages, and why.
 *
 * A redirect renders nothing: it moves the browser to a path that is a page. L1 governs pages, so these two are outside
 * it by construction — but they are inside this test's scope, because "a route that does not start with `/_site/`" is
 * exactly the shape a smuggling attempt would take.
 */
const REDIRECTS = new Map([
  ['/', 'GET / redirects to /_site/ (12-deployment.md §5)'],
  [
    '/:pathMatch(.*)*',
    'a path outside the site has no page; it is redirected to the not-found page',
  ],
]);

/** Every route that renders a page. */
const PAGES = ROUTES.filter((route) => route.redirect === undefined);

/** The path pattern of the not-found route, which §4 documents as `/_site/*`. */
const NOT_FOUND_PATH = `${ROUTE_PREFIXES.site}/:pathMatch(.*)*`;

/** The screen inventory of §4, as `id → { route, purpose }`. */
function documentedScreens(): Map<string, { route: string; purpose: string }> {
  const start = DOC.indexOf('## 4. Screen inventory');
  expect(start, '13-ui-ux.md §4 must exist').toBeGreaterThan(-1);
  const section = DOC.slice(start, DOC.indexOf('\n## 5.', start));

  const screens = new Map<string, { route: string; purpose: string }>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| S')) continue;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    const id = cells[0] ?? '';
    // The route is the first backticked cell that starts with a slash. Not an anchored match: S15's cell is
    // `` `/_site/*` (unmatched) ``, and requiring the backticks to span the whole cell silently dropped that row — which
    // made "a route for every documented screen" pass while the not-found route went uncompared.
    const route = cells
      .map((cell) => /`([^`]+)`/u.exec(cell)?.[1])
      .find((value) => value?.startsWith('/') === true);
    if (id === '' || route === undefined) continue;
    screens.set(id, { route, purpose: cells[2] ?? '' });
  }
  return screens;
}

/** Replaces a router's `:param` segments with a value, to compare a pattern with a path builder's output. */
function fillParams(path: string, value: string): string {
  return path.replaceAll(/:[A-Za-z]+(\(\.\*\)\*)?/gu, value);
}

describe('L1: every page lives under /_site/, except the one login page', () => {
  it('has a non-trivial table, so the walk below means something', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(14);
    expect(ROUTES.some((route) => route.redirect !== undefined)).toBe(true);
  });

  it('puts every page path inside the site prefix, or at the login page', () => {
    for (const route of PAGES) {
      if (route.path === NOT_FOUND_PATH) continue;
      const legal = route.path.startsWith(`${ROUTE_PREFIXES.site}/`) || route.path === LOGIN_PAGE;
      expect(
        legal,
        `${route.path} is outside ${ROUTE_PREFIXES.site} and is not ${LOGIN_PAGE}`,
      ).toBe(true);
    }
    // ...and the exception is exactly one route, not a habit.
    const outside = PAGES.filter(
      (route) => !route.path.startsWith(`${ROUTE_PREFIXES.site}/`) && route.path !== NOT_FOUND_PATH,
    );
    expect(outside.map((route) => route.path)).toEqual([LOGIN_PAGE]);
  });

  it('keeps every page a legal path by the shared law, and never an API path', () => {
    // The same predicates the API's own law test uses (`P1-REPO-07`), against the SPA's table. A page under
    // `/_admin/api/…` would answer a browser's HTML request with the guard's `401` JSON envelope.
    for (const route of PAGES) {
      const sample = fillParams(route.path, 'sample');
      expect(isLegalPath(sample), `${route.path} is not a legal path`).toBe(true);
      expect(isPagePath(sample), `${route.path} is not a page path`).toBe(true);
      expect(isApiPath(sample), `${route.path} is under an API prefix`).toBe(false);
    }
  });

  it('nests every admin page under /_site/admin', () => {
    const admin = PAGES.filter((route) => route.path.startsWith(ADMIN_ROOT));
    // Ten screens (S5–S14); a table that lost one would otherwise make this walk vacuous.
    expect(admin.length).toBe(10);
    for (const route of admin) {
      expect(
        route.path === `${ADMIN_ROOT}/` || route.path.startsWith(`${ADMIN_ROOT}/`),
        route.path,
      ).toBe(true);
    }
  });

  it('registers the login page once, at the D-19 path', () => {
    const logins = PAGES.filter((route) => route.path === LOGIN_PAGE_PATH);
    expect(logins).toHaveLength(1);
    expect(logins[0]?.name).toBe('login');
    // D-19: no second login URL. `/_site/login` is a legal namespace and the wrong address.
    expect(PAGES.some((route) => route.path === `${ROUTE_PREFIXES.site}/login`)).toBe(false);
  });

  it('names its redirects, and each one really redirects', () => {
    for (const [path, reason] of REDIRECTS) {
      const route = ROUTES.find((candidate) => candidate.path === path);
      expect(route, `${path} must exist (${reason})`).toBeDefined();
      expect(typeof route?.redirect, `${path} must be a redirect`).not.toBe('undefined');
      // A redirect has no component: if one appeared, the record would render a page and stop being an exception.
      expect(route?.components, `${path} must not render a component`).toBeFalsy();
    }
    // No other record may be a redirect without being listed above.
    const unlisted = ROUTES.filter(
      (route) => route.redirect !== undefined && !REDIRECTS.has(route.path),
    );
    expect(unlisted.map((route) => route.path)).toEqual([]);
  });

  it('renders the not-found page inside the site, where §4 S15 puts it', () => {
    const route = PAGES.find((candidate) => candidate.path === NOT_FOUND_PATH);
    expect(route?.name).toBe('not-found');
    expect(route?.meta.screen).toBe('S15');
  });
});

describe('the router table and 13-ui-ux.md §4 are the same list', () => {
  /** A route in the shape §4 writes it: the catch-all is documented as `/_site/*`, not as its Vue Router pattern. */
  function inDocumentForm(path: string): string {
    return path === NOT_FOUND_PATH ? `${ROUTE_PREFIXES.site}/*` : path;
  }

  /**
   * One form for both sides of the comparison.
   *
   * Two harmless differences are normalised away, and only these two: the dashboard is written `/_site/admin` in §4 and
   * `/_site/admin/` in the router (a trailing slash on the admin root, not on the site root), and §4 documents S15 as a
   * wildcard. Everything else must match character for character.
   */
  function comparable(path: string): string {
    const documentForm = inDocumentForm(path);
    return documentForm === `${ADMIN_ROOT}/` ? ADMIN_ROOT : documentForm;
  }

  const registered = new Set(PAGES.map((route) => comparable(route.path)));

  it('has a route for every documented screen', () => {
    const screens = documentedScreens();
    // Fifteen rows: S1–S14 pages plus S15, the unmatched case. A row lost to a parser change would make the walk below
    // silently narrower, so the count is asserted before it is used.
    expect(screens.size).toBe(15);

    for (const [id, screen] of screens) {
      expect(registered, `${id} ${screen.route} has no route`).toContain(comparable(screen.route));
    }
  });

  it('has a documented screen for every route', () => {
    const documented = new Set(
      [...documentedScreens().values()].map((screen) => comparable(screen.route)),
    );

    for (const route of PAGES) {
      expect(documented, `${route.path} is not a screen in 13-ui-ux.md §4`).toContain(
        comparable(route.path),
      );
    }
  });

  it('does not document a screen twice', () => {
    // Two rows with one route would mean one of the two screens cannot be reached, and the comparison above would still
    // pass because `toContain` does not count.
    const routes = [...documentedScreens().values()].map((screen) => comparable(screen.route));
    expect(new Set(routes).size).toBe(routes.length);
  });
});

describe('every route says what it is and who builds it', () => {
  it('carries a title, a screen and an owner', () => {
    for (const route of PAGES) {
      expect(route.meta.title, `${route.path} needs a title`).toBeTruthy();
      expect(route.meta.screen, `${route.path} needs a screen id`).toMatch(/^S\d{1,2}$/u);
      expect(route.meta.owner, `${route.path} needs an owning task`).toMatch(/^P\d-[A-Z]+-\d+$/u);
    }
  });

  it('names an owning task that exists in 08-tasks.md', () => {
    // The placeholders tell a reader which task replaces them, so the id has to be real. Two routes point at tasks this
    // task added while writing the table (`P5-ADM-02`, `P5-ADM-04`): §4 specified the Settings and Audit screens and
    // `08-tasks.md` had no task for either, which is recorded in `16-changelog.md` pass 31.
    for (const route of PAGES) {
      expect(TASKS.includes(`| ${route.meta.owner} |`), `${route.meta.owner} is not a task`).toBe(
        true,
      );
    }
  });

  it('gives every route a distinct name', () => {
    const names = PAGES.map((route) => route.name).filter((name) => name !== undefined);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks exactly the routes that still render a placeholder', () => {
    // Nine screens render real components: public catalog, country detail and API docs (`P3-WEB-01…04`), admin catalog
    // (`P2-WEB-01`), cached-country table (`P2-WEB-03`), cached-country detail (`P2-WEB-04`), Jobs (`P2-WEB-06`),
    // login (`P1-WEB-06`) and not-found. Placeholder status is explicit metadata, so this list is checked rather than
    // inferred from components.
    const placeholders = PAGES.filter((route) => route.meta.placeholder === true);
    expect(placeholders.map((route) => route.meta.screen).sort()).toEqual([
      'S10',
      'S12',
      'S13',
      'S14',
      'S5',
      'S9',
    ]);
    expect(PAGES.find((route) => route.meta.screen === 'S15')?.meta.placeholder).toBeUndefined();
  });
});

describe('the theme each route wears matches the document', () => {
  it('sends every admin page to the dark theme and nothing else', () => {
    // §1: dark admin, light public, auth follows the system. `theme/policy.ts` decides by path, so this walks the real
    // table through the **same** classifier the app installs — not a copy of it that could agree with itself while the
    // classifier disagreed with both. The system preference is `false` (light), which is what `tests/setup.ts` stubs.
    for (const route of PAGES) {
      const area = areaForPath(route.path);
      const theme = themeForPath(route.path, { prefersDark: false });

      if (route.path.startsWith(ADMIN_ROOT)) {
        expect(area, `${route.path} must be the admin area`).toBe('admin');
        expect(theme, `${route.path} must wear the dark theme`).toBe('dark');
      } else if (route.path !== NOT_FOUND_PATH) {
        // Every non-admin page is light, and the login page is the only one whose answer depends on the system.
        expect(theme, `${route.path} must wear the light theme`).toBe('light');
      }
    }
  });
});
