import { describe, expect, it } from 'vitest';

import {
  API_PREFIXES,
  LOGIN_PAGE_PATH,
  PROBE_PATHS,
  ROUTE_PREFIXES,
  SITE_ROOT_PATH,
  apiScopeOf,
  isAdminApiPath,
  isApiPath,
  isLegalPath,
  isPagePath,
  isPathUnder,
  isProbePath,
} from '@mapirror/shared';

/**
 * Pins the route law (L1, D-18, D-19) as code.
 *
 * The literals are asserted against `04-api.md` §0 rather than read from the constants, because a test that
 * compares a constant to itself proves nothing: if `ROUTE_PREFIXES.adminApi` were changed to `/_admin`,
 * the two law tests would still pass and the deployment would 404 every admin call.
 */
describe('route prefixes', () => {
  it('matches the normative table in 04-api.md §0', () => {
    expect(ROUTE_PREFIXES.site).toBe('/_site');
    expect(ROUTE_PREFIXES.authApi).toBe('/_auth/api');
    expect(ROUTE_PREFIXES.adminApi).toBe('/_admin/api');
    expect(ROUTE_PREFIXES.publicApi).toBe('/_public/api');
    expect(LOGIN_PAGE_PATH).toBe('/_auth/login');
    expect(SITE_ROOT_PATH).toBe('/_site/');
    expect(PROBE_PATHS).toEqual({ health: '/healthz', ready: '/readyz' });
  });

  it('exposes exactly the three API prefixes', () => {
    expect(API_PREFIXES).toHaveLength(3);
    expect(API_PREFIXES).not.toContain(ROUTE_PREFIXES.site);
  });

  it('keeps the login page outside the API namespaces', () => {
    // The trap D-19 exists for: the login *page* and the login *endpoint* differ by one segment.
    expect(isPagePath(LOGIN_PAGE_PATH)).toBe(true);
    expect(isApiPath(LOGIN_PAGE_PATH)).toBe(false);
    expect(isApiPath('/_auth/api/login')).toBe(true);
  });
});

describe('isPathUnder', () => {
  it('compares whole segments, so a lookalike prefix is not inside', () => {
    expect(isPathUnder('/_auth/apiX/login', '/_auth/api')).toBe(false);
    expect(isPathUnder('/_admin/apifoo', '/_admin/api')).toBe(false);
    expect(isPathUnder('/_admin/api/cache', '/_admin/api')).toBe(true);
  });

  it('accepts the prefix itself, with or without a trailing slash', () => {
    expect(isPathUnder('/_public/api', '/_public/api')).toBe(true);
    expect(isPathUnder('/_public/api/', '/_public/api')).toBe(true);
    expect(isPathUnder('/_site/countries/', '/_site')).toBe(true);
  });

  it('ignores the query string', () => {
    expect(isPathUnder('/_public/api/countries?page=2', '/_public/api')).toBe(true);
    expect(isPathUnder('/_admin/api?token=leak', '/_admin/api')).toBe(true);
  });

  it('handles the root and empty paths without mis-normalising them', () => {
    // A lone "/" must not be stripped to "" and then match every prefix that starts with a slash.
    expect(isPathUnder('/', '/_site')).toBe(false);
    expect(isPathUnder('', '/_site')).toBe(false);
    expect(isPathUnder('/?x=1', '/_site')).toBe(false);
  });

  it('does not treat the prefix as a substring match', () => {
    expect(isPathUnder('/x/_admin/api', '/_admin/api')).toBe(false);
    expect(isPathUnder('/_site', '/_site/admin')).toBe(false);
  });
});

describe('apiScopeOf', () => {
  it('names the namespace of each API route', () => {
    expect(apiScopeOf('/_auth/api/login')).toBe('auth');
    expect(apiScopeOf('/_admin/api/cache')).toBe('admin');
    expect(apiScopeOf('/_public/api/countries/finland')).toBe('public');
  });

  it('returns null for pages and probes', () => {
    expect(apiScopeOf('/_site/')).toBeNull();
    expect(apiScopeOf('/_site/admin/cache')).toBeNull();
    expect(apiScopeOf('/_auth/login')).toBeNull();
    expect(apiScopeOf('/healthz')).toBeNull();
    expect(apiScopeOf('/')).toBeNull();
  });
});

describe('isAdminApiPath', () => {
  it('is true only for the admin API, which is what the guard keys on (L2)', () => {
    expect(isAdminApiPath('/_admin/api')).toBe(true);
    expect(isAdminApiPath('/_admin/api/cache/123/public')).toBe(true);
    expect(isAdminApiPath('/_public/api/countries')).toBe(false);
    expect(isAdminApiPath('/_auth/api/login')).toBe(false);
    expect(isAdminApiPath('/_site/admin/cache')).toBe(false);
  });
});

describe('isProbePath', () => {
  it('accepts exactly the two probes', () => {
    expect(isProbePath('/healthz')).toBe(true);
    expect(isProbePath('/readyz')).toBe(true);
    expect(isProbePath('/healthz/extra')).toBe(false);
    expect(isProbePath('/healthz?verbose=1')).toBe(true);
  });
});

describe('isPagePath', () => {
  it('allows /_site/* and the single login page', () => {
    expect(isPagePath('/_site/')).toBe(true);
    expect(isPagePath('/_site/admin/cache/finland')).toBe(true);
    expect(isPagePath('/_auth/login')).toBe(true);
  });

  it('treats `api` as a reserved segment, so /_site/api is not a page (L1)', () => {
    expect(isPagePath('/_site/api')).toBe(false);
    expect(isPagePath('/_site/api/countries')).toBe(false);
    expect(isPagePath('/_site/api-docs')).toBe(true);
    // The rule is on the first segment only: a country slug called "api" would still be a page.
    expect(isPagePath('/_site/countries/api')).toBe(true);
  });

  it('handles an empty path', () => {
    expect(isPagePath('')).toBe(false);
    expect(isLegalPath('')).toBe(false);
  });

  it('rejects pages in API namespaces and at the root', () => {
    expect(isPagePath('/_admin/api/cache')).toBe(false);
    expect(isPagePath('/_public/api/countries')).toBe(false);
    expect(isPagePath('/_admin/cache')).toBe(false);
    expect(isPagePath('/')).toBe(false);
    expect(isPagePath('/_auth/login/extra')).toBe(false);
  });
});

describe('isLegalPath', () => {
  it('accepts every documented example from 04-api.md §0 and L1', () => {
    for (const path of [
      '/_site/',
      '/_site/countries/finland',
      '/_site/api-docs',
      '/_site/admin/cache',
      '/_auth/login',
      '/_admin/api/catalog',
      '/_admin/api/cache/:countryId/public',
      '/_public/api/countries',
      '/_public/api/countries/finland/download',
      '/_auth/api/login',
      '/_auth/api/me',
      '/_auth/api/logout',
      '/healthz',
      '/readyz',
    ]) {
      expect(isLegalPath(path), path).toBe(true);
    }
  });

  it('accepts /_site/login as a namespace, though the router must never serve one', () => {
    // The law constrains namespaces, not the route table: `/_site/login` is a legal *page path*, and it is
    // the router that must not use it — there is exactly one login page (D-19). See
    // `apps/web/tests/router-paths.spec.ts`.
    expect(isPagePath('/_site/login')).toBe(true);
    expect(isPagePath(LOGIN_PAGE_PATH)).toBe(true);
  });

  it('rejects the paths the law forbids', () => {
    for (const path of [
      '/',
      '/admin/cache',
      '/login',
      '/_admin/cache',
      '/_public/countries',
      '/api/countries',
      '/_site/api',
      '/health',
    ]) {
      expect(isLegalPath(path), path).toBe(false);
    }
  });
});
