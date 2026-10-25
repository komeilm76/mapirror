import { isPagePath } from '@mapirror/shared';
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { ADMIN_ROOT, LOGIN_PAGE, SITE_ROOT } from '../src/router/paths';
import { APP_ROUTES } from '../src/router/routes';
import {
  DEFAULT_REDIRECT,
  loginRedirectFor,
  MAX_REDIRECT_LENGTH,
  safeRedirectTarget,
} from '../src/router/redirect';

/**
 * The `redirect` parameter (`P1-WEB-03`).
 *
 * The login page is public, so this parameter is attacker-influenced input by construction: anyone can hand out
 * `/_auth/login?redirect=https://evil.example/sign-in`. The rule is one sentence — **a redirect target is a page path
 * inside this site, or it is the dashboard** — and the cases below are that sentence, one clause each.
 *
 * The function is used on **both** sides of the round trip: the guard writes the parameter, and the login form
 * (`P1-WEB-06`) reads it back. A check on one side only is a check the other side can be talked out of, which is why it
 * is tested as a pure function rather than through either caller.
 */

describe('what a redirect target may be', () => {
  it('keeps a path, and everything that belongs to it', () => {
    expect(safeRedirectTarget(`${ADMIN_ROOT}/jobs`)).toBe(`${ADMIN_ROOT}/jobs`);
    expect(safeRedirectTarget(`${ADMIN_ROOT}/jobs?status=failed&page=2`)).toBe(
      `${ADMIN_ROOT}/jobs?status=failed&page=2`,
    );
    // A fragment is part of a router location — `/_site/api-docs#curlv` is a link to a section, and dropping the
    // fragment would land the reader at the top of the page they thought they were going to.
    expect(safeRedirectTarget(`${SITE_ROOT}api-docs#curlv`)).toBe(`${SITE_ROOT}api-docs#curlv`);
    expect(safeRedirectTarget(SITE_ROOT)).toBe(SITE_ROOT);
  });

  it('refuses another origin, in every form a browser will accept', () => {
    const hostile = [
      'https://evil.example/sign-in',
      'http://evil.example',
      '//evil.example/sign-in',
      // Backslash: browsers normalise `/\host` to `//host`, so a check that only looked for `//` would miss it.
      '/\\evil.example/sign-in',
      '\\\\evil.example',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      // A scheme-relative URL with a tab in it — `javascript:` was written this way to get past naive filters.
      'java\tscript:alert(1)',
      'evil.example',
      '?redirect=/_site/',
      '#/_site/',
    ];

    for (const value of hostile) {
      expect(safeRedirectTarget(value), value).toBe(DEFAULT_REDIRECT);
    }
  });

  it('refuses a backslash *inside* a page path, which the law alone would accept', () => {
    // The case that makes the backslash check load-bearing rather than decorative: it starts with `/_site/`, so
    // `isPagePath` says yes — and browsers normalise `\` to `/`, so the address resolves somewhere the router never
    // agreed to. Removing the check turns this into a pass-through.
    expect(safeRedirectTarget(`${SITE_ROOT}admin\\..\\..\\evil.example`)).toBe(DEFAULT_REDIRECT);
  });

  it('refuses a protocol-relative URL even when it names a page path', () => {
    // `//_site/admin` is the shape a filter that only blocks `http(s)://` lets through. Two locks turn it away: this
    // module's `//` check, and then the law — no value starting with `//` can start with `/_site/` or equal the login
    // page. The second lock is why the first one is provably redundant, and it stays because the cost of being wrong
    // once, here, is an open redirect.
    expect(safeRedirectTarget('//_site/admin')).toBe(DEFAULT_REDIRECT);
    expect(isPagePath('//_site/admin')).toBe(false);
  });

  it('refuses every namespace that is not a page', () => {
    // L1: `/_admin/*` and `/_public/*` are APIs, `/_auth/*` is the auth API. Sending a browser to an API path after
    // sign-in renders JSON, which is a dead end that looks like a bug.
    const notPages = [
      `/_admin/api/cache`,
      `/_admin/api/settings`,
      `/_public/api/countries`,
      `/_auth/api/login`,
      `/_auth/api/session`,
      '/healthz',
      '/readyz',
      '/metrics',
    ];

    for (const value of notPages) {
      expect(safeRedirectTarget(value), value).toBe(DEFAULT_REDIRECT);
    }
  });

  it('refuses the login page itself, which is a loop rather than a destination', () => {
    expect(safeRedirectTarget(LOGIN_PAGE)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectTarget(`${LOGIN_PAGE}?redirect=${ADMIN_ROOT}/`)).toBe(DEFAULT_REDIRECT);
  });

  it('refuses a page that is not a page here', () => {
    expect(safeRedirectTarget('/')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectTarget('/somewhere-else')).toBe(DEFAULT_REDIRECT);
  });

  it('keeps `/_site` without its trailing slash, because the router does', async () => {
    // The site root is registered as `/_site/` and Vue Router's `strict: false` default matches the unslashed form to
    // it, so `/_site` is a page the router can render — and `isPagePath` accepts it by segment, which is what the law
    // means. Proven rather than assumed: the fallback below is the dashboard, so a wrong "allowed" here would land a
    // signed-in reader on a 404 that looks like a sign-in failure.
    const router = createRouter({ history: createMemoryHistory(), routes: [...APP_ROUTES] });
    await router.push('/_site');
    expect(router.currentRoute.value.name).toBe('home');

    expect(safeRedirectTarget('/_site')).toBe('/_site');
  });
});

describe('what is not a string at all', () => {
  it('refuses a parsed array, which is what `?redirect=a&redirect=b` becomes', () => {
    // Vue Router turns a repeated parameter into an array. Without the type check, `.startsWith` would throw inside the
    // guard's hook — a navigation that fails with a console error and no page.
    expect(safeRedirectTarget([`${ADMIN_ROOT}/`])).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectTarget([`${ADMIN_ROOT}/`, `${ADMIN_ROOT}/jobs`])).toBe(DEFAULT_REDIRECT);
  });

  it('refuses a parsed object, which is what `?redirect[path]=x` becomes', () => {
    expect(safeRedirectTarget({ path: `${ADMIN_ROOT}/` })).toBe(DEFAULT_REDIRECT);
  });

  it('refuses `undefined`, `null` and a number', () => {
    expect(safeRedirectTarget(undefined)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectTarget(null)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectTarget(42)).toBe(DEFAULT_REDIRECT);
  });

  it('refuses an empty string rather than treating it as the site root', () => {
    expect(safeRedirectTarget('')).toBe(DEFAULT_REDIRECT);
    // Whitespace is not a path either; it would be trimmed by nothing and rendered as a blank address.
    expect(safeRedirectTarget('   ')).toBe(DEFAULT_REDIRECT);
  });
});

describe('the length bound', () => {
  it('is a bound and not a ban', () => {
    const long = `${ADMIN_ROOT}/${'a'.repeat(MAX_REDIRECT_LENGTH)}`;
    expect(long.length).toBeGreaterThan(MAX_REDIRECT_LENGTH);
    expect(safeRedirectTarget(long)).toBe(DEFAULT_REDIRECT);

    // Just inside: `/_site/admin/` plus enough `a`s to land exactly on the limit.
    const justInside = `${ADMIN_ROOT}/`.padEnd(MAX_REDIRECT_LENGTH, 'a');
    expect(justInside).toHaveLength(MAX_REDIRECT_LENGTH);
    expect(safeRedirectTarget(justInside)).toBe(justInside);
  });

  it('is a number, so a later edit cannot quietly make it `Infinity`', () => {
    expect(MAX_REDIRECT_LENGTH).toBe(512);
  });
});

describe('the default, and the location built from it', () => {
  it('sends a refused admin visitor to the dashboard, not the marketing site', () => {
    // Someone who was refused an admin page and then signed in did not ask for the home page.
    expect(DEFAULT_REDIRECT).toBe(`${ADMIN_ROOT}/`);
  });

  it('builds a login location carrying the refused path', () => {
    expect(loginRedirectFor(`${ADMIN_ROOT}/jobs?status=failed`)).toEqual({
      path: LOGIN_PAGE,
      query: { redirect: `${ADMIN_ROOT}/jobs?status=failed` },
    });
  });

  it('builds a login location even from a refused path that would not survive validation', () => {
    // The guard passes `to.fullPath`, which is normally a page path — but a navigation to `//evil.example` never
    // reaches the guard, and a query string can. Either way the result is a usable location, never a broken one.
    expect(loginRedirectFor('//evil.example')).toEqual({
      path: LOGIN_PAGE,
      query: { redirect: DEFAULT_REDIRECT },
    });
  });
});
