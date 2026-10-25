import { describe, expect, it } from 'vitest';

import { isApiPath, isLegalPath, isPagePath } from '@mapirror/shared';

import { ADMIN_ROOT, LOGIN_PAGE, SITE_ROOT, adminPagePaths, pagePaths } from '../src/index';

/**
 * A miniature router law test (L1), run against the path table the real Vue router will use.
 *
 * `apps/web/tests/law-router.test.ts` walks the router once it exists; this walks the builders that feed
 * it today, so the law is enforced from the moment the first path is written rather than from the moment
 * the router is assembled. It also proves the web app consumes `@mapirror/shared` (`P1-REPO-07`).
 */
const publicPaths = [
  pagePaths.home(),
  pagePaths.countries(),
  pagePaths.country('finland'),
  pagePaths.country('europe/finland'), // encoded, and must still be a legal page path
  pagePaths.apiDocs(),
  pagePaths.notFound(),
];

const adminPaths = [
  adminPagePaths.dashboard(),
  adminPagePaths.catalog(),
  adminPagePaths.cache(),
  adminPagePaths.cacheCountry('0b8c4a58-7f6e-4c1e-9f0a-1c2d3e4f5a6b'),
  adminPagePaths.intervals(),
  adminPagePaths.import(),
  adminPagePaths.jobs(),
  adminPagePaths.system(),
  adminPagePaths.settings(),
  adminPagePaths.audit(),
];

describe('page paths', () => {
  it('starts at /_site/', () => {
    expect(SITE_ROOT).toBe('/_site/');
    expect(pagePaths.home()).toBe('/_site/');
  });

  it('keeps the login page exactly as D-19 defines it', () => {
    expect(LOGIN_PAGE).toBe('/_auth/login');
    expect(isPagePath(LOGIN_PAGE)).toBe(true);
    expect(isApiPath(LOGIN_PAGE)).toBe(false);
  });

  it('produces only legal page paths', () => {
    for (const path of [...publicPaths, ...adminPaths]) {
      expect(isLegalPath(path), path).toBe(true);
      expect(isPagePath(path), path).toBe(true);
      expect(isApiPath(path), path).toBe(false);
    }
  });

  it('never collides with an API prefix', () => {
    for (const path of [...publicPaths, ...adminPaths]) {
      expect(path.startsWith('/_admin/api'), path).toBe(false);
      expect(path.startsWith('/_public/api'), path).toBe(false);
      expect(path.startsWith('/_auth/api'), path).toBe(false);
    }
  });

  it('nests every admin page under /_site/admin', () => {
    expect(ADMIN_ROOT).toBe('/_site/admin');
    for (const path of adminPaths) expect(path.startsWith(`${ADMIN_ROOT}/`), path).toBe(true);
  });

  it('encodes slugs instead of pasting them into the path', () => {
    // '../admin' must not become a route: the slug arrives from a URL and is attacker-influenced.
    expect(pagePaths.country('../admin')).toBe('/_site/countries/..%2Fadmin');
    expect(pagePaths.country('../admin')).not.toContain('/admin');
  });

  it('never builds a second login page', () => {
    // `/_site/login` is a legal namespace but the wrong URL (D-19): one login page, at /_auth/login.
    for (const path of [...publicPaths, ...adminPaths]) expect(path).not.toBe('/_site/login');
    expect(LOGIN_PAGE).toBe('/_auth/login');
  });

  it('documents the api-docs page as /_site/api-docs, never /_site/api', () => {
    expect(pagePaths.apiDocs()).toBe('/_site/api-docs');
    expect(pagePaths.apiDocs()).not.toBe('/_site/api');
  });
});
