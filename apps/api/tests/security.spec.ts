import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { JSON_BODY_LIMIT_BYTES, parseEnv, SECURITY_HEADERS, type AppConfig } from '../src/index';
import { buildTestApp } from './helpers/test-app';

/**
 * The task's gate is "headers asserted in test; no `*` CORS in prod", so these tests assert the response as a
 * client sees it — not the configuration the code intended. They also parse `14-security.md` §6 and compare,
 * because a header list that silently diverges from the security document is worse than a missing header: the
 * document is what a reviewer signs off.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Reads the header block of `14-security.md` §6 into a map.
 *
 * The block wraps long values across indented continuation lines, so lines are joined before splitting on the
 * first colon. A trailing `# …` comment (used for the header the proxy owns) is stripped.
 *
 * @returns Lower-cased header name → value.
 */
function documentedHeaders(): Map<string, string> {
  const doc = readFileSync(`${ROOT}docs/14-security.md`, 'utf8');
  const start = doc.indexOf('## 6. Transport & headers');
  expect(start, '14-security.md has a header section').toBeGreaterThan(-1);
  const block = doc.slice(start);
  const fence = block.indexOf('```');
  const body = block.slice(block.indexOf('\n', fence) + 1, block.indexOf('\n```', fence));

  const headers = new Map<string, string>();
  let current = '';
  for (const raw of body.split('\n')) {
    // A continuation line starts with whitespace and belongs to the header above it.
    if (/^\s+\S/.test(raw) && current !== '') {
      const [name] = current.split(/:(.*)/s);
      const value = `${current.slice((name ?? '').length + 1)} ${raw.trim()}`;
      headers.set((name ?? '').toLowerCase(), value.replace(/\s+/g, ' ').trim());
      current = `${name}: ${value}`;
      continue;
    }
    current = raw.trim();
    const colon = current.indexOf(':');
    if (colon === -1) continue;
    const name = current.slice(0, colon).toLowerCase();
    const value = current
      .slice(colon + 1)
      .replace(/#.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    headers.set(name, value);
  }
  return headers;
}

/** A config whose CORS allow-list is exactly the given origins. */
function configWithOrigins(origins: readonly string[]): AppConfig {
  return { ...parseEnv({}), corsOrigins: origins };
}

describe('security headers', () => {
  it('sets every documented header on a normal response', async () => {
    const documented = documentedHeaders();
    const instance = await buildTestApp();

    const response = await instance.inject({ method: 'GET', url: '/_public/api/countries' });

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers[name], name).toBe(value);
      // …and the value is the one the security document states, not merely a plausible one.
      expect(documented.get(name), `14-security.md §6 documents ${name}`).toBe(value);
    }
    await instance.close();
  });

  it('sets them on a 404 as well, where a wrong route could otherwise answer bare', async () => {
    const instance = await buildTestApp();

    const response = await instance.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    for (const name of Object.keys(SECURITY_HEADERS)) {
      expect(response.headers[name], name).toBeDefined();
    }
    await instance.close();
  });

  it('keeps script-src strict: style-src is the only relaxation', () => {
    const csp = CONTENT_SECURITY_POLICY_FOR_TEST();

    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toMatch(/script-src 'self';/);
    // The relaxation must not leak into the script directive.
    const scriptSrc = /script-src([^;]*);/.exec(csp)?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('does not set HSTS — the TLS proxy owns that header', () => {
    // `14-security.md` §6 marks it "set at the TLS proxy": the API speaks plain HTTP on a private port.
    expect(documentedHeaders().get('strict-transport-security')).toContain('max-age=31536000');
    expect(SECURITY_HEADERS['strict-transport-security']).toBeUndefined();
  });
});

/** Reads the CSP out of the exported header map, so the test never restates it. */
function CONTENT_SECURITY_POLICY_FOR_TEST(): string {
  return SECURITY_HEADERS['content-security-policy'] ?? '';
}

describe('CORS', () => {
  it('adds no CORS headers by default, and still answers the request', async () => {
    const instance = await buildTestApp();

    const response = await instance.inject({
      method: 'GET',
      url: '/_public/api/countries',
      headers: { origin: 'https://somewhere.example.org' },
    });

    // Answered, not refused: CORS is a browser-side read barrier. Without `access-control-allow-origin` the
    // browser hides the body; no other client is affected.
    expect(response.statusCode).toBe(503);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers.vary).toContain('Origin');
    await instance.close();
  });

  it('does not refuse a same-origin POST that carries Origin', async () => {
    // The regression this guards, measured before the fix: browsers send `Origin` on same-origin POSTs, so a
    // server-side block on unlisted origins returned 403 to the SPA posting its own login form.
    const instance = await buildTestApp({
      config: configWithOrigins(['https://maps.example.org']),
    });

    const response = await instance.inject({
      method: 'POST',
      url: '/_auth/api/login',
      headers: { origin: 'http://localhost:8080', 'content-type': 'application/json' },
      payload: { username: 'admin', password: 'x' },
    });

    expect(response.statusCode).toBe(503);
    await instance.close();
  });

  it('allows a configured origin and varies on it', async () => {
    const instance = await buildTestApp({
      config: configWithOrigins(['https://maps.example.org']),
    });

    const response = await instance.inject({
      method: 'GET',
      url: '/_public/api/countries',
      headers: { origin: 'https://maps.example.org' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['access-control-allow-origin']).toBe('https://maps.example.org');
    expect(response.headers.vary).toContain('Origin');
    // Bearer tokens travel in a header, so the allow-headers list has to include authorization.
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
    // …and the id the contract tells clients to quote must be readable by a browser, which by default hides
    // every header except the CORS-safelisted ones.
    expect(response.headers['access-control-expose-headers']).toBe('x-request-id');
    await instance.close();
  });

  it('answers a preflight with 204 and the allowed methods', async () => {
    const instance = await buildTestApp({
      config: configWithOrigins(['https://maps.example.org']),
    });

    const response = await instance.inject({
      method: 'OPTIONS',
      url: '/_admin/api/catalog',
      headers: {
        origin: 'https://maps.example.org',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('GET');
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
    expect(response.headers['access-control-max-age']).toBeDefined();
    await instance.close();
  });

  it('refuses a preflight from an origin that is not on the list, with the envelope', async () => {
    const instance = await buildTestApp({
      config: configWithOrigins(['https://maps.example.org']),
    });

    const response = await instance.inject({
      method: 'OPTIONS',
      url: '/_public/api/countries',
      headers: { origin: 'https://evil.example.org', 'access-control-request-method': 'GET' },
    });
    const body = response.json<{ error: { code: string; requestId: string } }>();

    expect(response.statusCode).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    // The refusal still carries the security headers and the envelope: it is a normal API response.
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await instance.close();
  });

  it('answers an actual request from a foreign origin without letting the browser read it', async () => {
    const instance = await buildTestApp({
      config: configWithOrigins(['https://maps.example.org']),
    });

    const response = await instance.inject({
      method: 'GET',
      url: '/_public/api/countries',
      headers: { origin: 'https://evil.example.org' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await instance.close();
  });

  it('never emits a wildcard, even if one reaches the config', async () => {
    // `parseEnv` refuses `*`, so this value can only arrive by another route — which is exactly why the stage
    // filters it too: the task's guarantee is "no `*` CORS in prod", not "no `*` in one of the two places".
    const instance = await buildTestApp({
      config: configWithOrigins(['*', 'https://maps.example.org']),
    });

    const allowed = await instance.inject({
      method: 'GET',
      url: '/_public/api/countries',
      headers: { origin: 'https://maps.example.org' },
    });
    const wildcard = await instance.inject({
      method: 'OPTIONS',
      url: '/_public/api/countries',
      headers: { origin: '*', 'access-control-request-method': 'GET' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('https://maps.example.org');
    expect(wildcard.headers['access-control-allow-origin']).toBeUndefined();
    expect(wildcard.statusCode).toBe(403);
    await instance.close();
  });

  it('leaves a request with no Origin alone', async () => {
    // curl, a health check, the proxy: no Origin header, no CORS decision to make.
    const instance = await buildTestApp({
      config: configWithOrigins(['https://maps.example.org']),
    });

    const response = await instance.inject({ method: 'GET', url: '/_public/api/countries' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await instance.close();
  });
});

describe('the JSON body limit', () => {
  it('is the 1 MB documented in 14-security.md §5', () => {
    expect(JSON_BODY_LIMIT_BYTES).toBe(1_048_576);
    // Matched as a fact, not as a sentence: the doc explains where the limit lives and may say more later.
    expect(readFileSync(`${ROOT}docs/14-security.md`, 'utf8')).toMatch(/Body limit 1 MB/);
  });

  it('refuses a JSON body over the limit with FILE_TOO_LARGE, envelope and headers intact', async () => {
    const instance = await buildTestApp();

    const response = await instance.inject({
      method: 'POST',
      url: '/_auth/api/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'x', padding: 'y'.repeat(JSON_BODY_LIMIT_BYTES + 1024) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('FILE_TOO_LARGE');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await instance.close();
  });

  it('accepts a body just under the limit, so the boundary is where the document says', async () => {
    const instance = await buildTestApp();

    const response = await instance.inject({
      method: 'POST',
      url: '/_auth/api/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'x', padding: 'y'.repeat(JSON_BODY_LIMIT_BYTES - 2048) },
    });

    // The stub route answers 503: the request got through the parser and reached a handler.
    expect(response.statusCode).toBe(503);
    await instance.close();
  });
});
