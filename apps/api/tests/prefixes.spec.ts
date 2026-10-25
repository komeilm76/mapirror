import { describe, expect, it } from 'vitest';

import { isLegalPath } from '@mapirror/shared';

import { API_PREFIXES, PROBE_PATHS, isApiRequest, requiresAdminToken, scopeOf } from '../src/index';

/**
 * Proves the API actually consumes `@mapirror/shared` (the acceptance criterion of `P1-REPO-07`) and that
 * its route classification obeys L1/L2.
 *
 * This is the layer the global admin guard will be keyed on, so the cases that matter are the ones where a
 * naive `startsWith` would get it wrong.
 */
describe('API prefixes', () => {
  it('registers exactly the three API prefixes, all legal under L1', () => {
    expect([...API_PREFIXES]).toEqual(['/_auth/api', '/_admin/api', '/_public/api']);
    for (const prefix of API_PREFIXES) expect(isLegalPath(prefix), prefix).toBe(true);
  });

  it('keeps the probes outside the prefixes but inside the law', () => {
    for (const probe of Object.values(PROBE_PATHS)) {
      expect(isLegalPath(probe), probe).toBe(true);
      expect(API_PREFIXES.some((prefix) => probe.startsWith(prefix))).toBe(false);
    }
  });
});

describe('requiresAdminToken (L2 — deny by default)', () => {
  it('protects every admin API path, including ones not written yet', () => {
    for (const url of [
      '/_admin/api',
      '/_admin/api/catalog',
      '/_admin/api/cache/123/public',
      '/_admin/api/intervals/7',
      '/_admin/api/anything/added/later',
    ]) {
      expect(requiresAdminToken(url), url).toBe(true);
    }
  });

  it('does not protect public, auth or probe paths', () => {
    for (const url of ['/_public/api/countries', '/_auth/api/login', '/healthz', '/readyz']) {
      expect(requiresAdminToken(url), url).toBe(false);
    }
  });

  it('is not fooled by a lookalike prefix', () => {
    expect(requiresAdminToken('/_admin/apifoo')).toBe(false);
    expect(requiresAdminToken('/_site/admin/cache')).toBe(false);
  });
});

describe('isApiRequest / scopeOf', () => {
  it('separates API calls from page requests', () => {
    expect(isApiRequest('/_public/api/countries')).toBe(true);
    expect(isApiRequest('/_site/countries')).toBe(false);
    expect(isApiRequest('/_auth/login')).toBe(false);
  });

  it('names the scope for logging and error envelopes', () => {
    expect(scopeOf('/_auth/api/me')).toBe('auth');
    expect(scopeOf('/_admin/api/jobs')).toBe('admin');
    expect(scopeOf('/_public/api/countries')).toBe('public');
    expect(scopeOf('/_site/')).toBeNull();
  });
});
