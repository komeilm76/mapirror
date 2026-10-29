import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_REQUESTS_PER_MINUTE,
  PUBLIC_READ_REQUESTS_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  isDownloadRequest,
} from '../src/plugins/rate-limit';
import { SlidingWindowLimiter } from '../src/lib/rate-limit';
import { LoginRateLimitDetailsSchema } from '@mapirror/shared';
import { parseEnv } from '../src/config/env';
import { loginThrottleFromConfig } from '../src/modules/auth/login-throttle';
import { buildTestApp, TEST_ADMIN_IDENTITY } from './helpers/test-app';

/**
 * `P1-API-09`: the request limiter, and the numbers `14-security.md` §7 promises.
 *
 * Two layers. {@link SlidingWindowLimiter} is tested as arithmetic — a moving clock, no server — because "the window
 * expired" is the interesting case and a test that waited a minute would not run in the gate. The stage is then tested
 * through `buildApp`, because the questions that matter are about *which* requests are charged and which are not, and
 * those are answered by the pipeline rather than by the counter.
 *
 * No database: the limiter runs before the guard and before every handler. A charged request must reach its handler
 * rather than be refused with `429`; the catalog handler may itself fail when it touches this suite's hostile DB stub.
 * The same file parses the limit table out of `14-security.md` §7 — a document that promises `60`, `10` and `600` and
 * a code that uses different numbers is a contract that is wrong in the one place an operator would look.
 */

/** A clock a test moves by hand. */
function clockAt(start: string): { now: Date; advance: (ms: number) => void } {
  const started = new Date(start).getTime();
  let offset = 0;
  return {
    get now(): Date {
      return new Date(started + offset);
    },
    advance(ms: number): void {
      offset += ms;
    },
  };
}

/** A limiter with a limit of three and a one-minute window, on a movable clock. */
function limiterWith(options: { limit?: number; windowMs?: number; maxKeys?: number } = {}): {
  limiter: SlidingWindowLimiter;
  clock: ReturnType<typeof clockAt>;
} {
  const clock = clockAt('2026-10-25T09:00:00.000Z');
  return {
    clock,
    limiter: new SlidingWindowLimiter({
      limit: options.limit ?? 3,
      windowMs: options.windowMs ?? 60_000,
      now: () => clock.now,
      ...(options.maxKeys === undefined ? {} : { maxKeys: options.maxKeys }),
    }),
  };
}

describe('SlidingWindowLimiter', () => {
  it('allows the limit and refuses the next request, with the instant it may retry', () => {
    const { limiter } = limiterWith({ limit: 3 });

    for (let request = 1; request <= 3; request += 1) {
      expect(limiter.take('ip:203.0.113.7'), `request ${String(request)}`).toEqual({
        allowed: true,
      });
    }

    const verdict = limiter.take('ip:203.0.113.7');
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    // Every request was at T0, so the oldest leaves the window exactly one window from now.
    expect(verdict.resetAt.toISOString()).toBe('2026-10-25T09:01:00.000Z');
    expect(verdict.retryAfterSeconds).toBe(60);
  });

  it('counts each key separately', () => {
    const { limiter } = limiterWith({ limit: 1 });

    expect(limiter.take('ip:203.0.113.7').allowed).toBe(true);
    expect(limiter.take('ip:203.0.113.7').allowed).toBe(false);
    // A different client has its own allowance: one visitor cannot spend another's.
    expect(limiter.take('ip:198.51.100.7').allowed).toBe(true);
    expect(limiter.size).toBe(2);
  });

  it('slides rather than resetting on a boundary', () => {
    // The reason for a sliding window: with a fixed one, a client waits for the boundary and then sends 2 × limit in
    // two quick bursts. Here the allowance returns one request at a time, as each request leaves the window.
    const { limiter, clock } = limiterWith({ limit: 2 });

    expect(limiter.take('k').allowed).toBe(true);
    clock.advance(30_000);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(false);

    // Half a window later the first request has left; the second is still inside.
    clock.advance(30_001);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(false);

    clock.advance(30_000);
    expect(limiter.take('k').allowed).toBe(true);
  });

  it('does not charge a refused request, so retrying cannot extend its own penalty', () => {
    const { limiter, clock } = limiterWith({ limit: 1 });

    expect(limiter.take('k').allowed).toBe(true);
    // Half a window later the allowance is still spent; a client that ignores `Retry-After` and knocks now must not
    // push its own release further away. The knock happens *inside* the window on purpose: charged there, it would
    // hold the bucket until half a window after this instant, which is the assertion below.
    clock.advance(30_000);
    for (let knock = 0; knock < 10; knock += 1) expect(limiter.take('k').allowed).toBe(false);

    // One window after the request that was *allowed* — a millisecond past it — the key is free again.
    clock.advance(30_001);
    expect(limiter.take('k').allowed).toBe(true);
  });

  it('reports at least one second, so a client never sees Retry-After: 0', () => {
    const { limiter, clock } = limiterWith({ limit: 1 });
    expect(limiter.take('k').allowed).toBe(true);

    // One millisecond before the window ends: the honest wait is 1 second, not 0.
    clock.advance(59_999);
    const verdict = limiter.take('k');
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.retryAfterSeconds).toBe(1);
  });

  it('forgets a key once its requests have all left the window', () => {
    // Otherwise a long-lived process accumulates one entry per address that ever connected.
    const { limiter, clock } = limiterWith({ limit: 1 });
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.size).toBe(1);

    clock.advance(60_001);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it('stays bounded, evicting the oldest key rather than growing without limit', () => {
    // A limiter keyed on something a client controls is a memory-exhaustion lever aimed at the endpoint it protects.
    const { limiter } = limiterWith({ limit: 5, maxKeys: 2 });

    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('b').allowed).toBe(true);
    expect(limiter.take('c').allowed).toBe(true);
    expect(limiter.size).toBe(2);

    // The cost of the bound, stated: the evicted client gets a fresh allowance.
    expect(limiter.take('a').allowed).toBe(true);
  });

  it('rejects a limit or window that would silently disable it', () => {
    const clock = () => new Date();
    expect(() => new SlidingWindowLimiter({ limit: 0, windowMs: 60_000, now: clock })).toThrow(
      RangeError,
    );
    expect(() => new SlidingWindowLimiter({ limit: 1, windowMs: 0, now: clock })).toThrow(
      RangeError,
    );
    expect(() => new SlidingWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 0 })).toThrow(
      RangeError,
    );
    expect(() => new SlidingWindowLimiter({ limit: 1.5, windowMs: 60_000 })).toThrow(RangeError);
  });

  it('forgets everything on reset', () => {
    const { limiter } = limiterWith({ limit: 1 });
    expect(limiter.take('k').allowed).toBe(true);
    limiter.reset();
    expect(limiter.size).toBe(0);
    expect(limiter.take('k').allowed).toBe(true);
  });
});

describe('SlidingWindowLimiter — the default clock', () => {
  it('works with no clock injected, reading the real one', () => {
    // Every other test injects a clock; this one exists so the `options.now ?? (() => new Date())` default is not dead
    // code that a refactor could delete without a failing test.
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000 });
    const before = Date.now();
    const verdict = limiter.take('k');
    expect(verdict.allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(false);
    const refusal = limiter.take('k');
    expect(refusal.allowed).toBe(false);
    if (refusal.allowed) return;
    expect(refusal.resetAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(refusal.resetAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe('isDownloadRequest', () => {
  it('separates the per-download rule from the general read rule, query string included', () => {
    expect(isDownloadRequest('/_public/api/countries/finland/download')).toBe(true);
    expect(isDownloadRequest('/_public/api/countries/finland/download?x=1')).toBe(true);
    expect(isDownloadRequest('/_public/api/countries')).toBe(false);
    expect(isDownloadRequest('/_public/api/countries/finland')).toBe(false);
    // A path that merely mentions it is not the endpoint.
    expect(isDownloadRequest('/_public/api/downloads')).toBe(false);
  });
});

/** The documented download endpoint: the route lands with `P3-PUB-*`, and the limiter has to be ready for it now. */
const DOWNLOAD_URL = '/_public/api/countries/finland/download';

/** The app, with a limiter whose clock the test moves. */
async function appWithClock(
  clock: ReturnType<typeof clockAt>,
  options: { readonly publicDownloadsPerMinute?: number } = {},
): Promise<FastifyInstance> {
  const config = parseEnv({});
  return buildTestApp({
    // Accepts any token; the database stub may make a protected handler fail, but only the limiter's 429 is relevant.
    authVerify: () => Promise.resolve(TEST_ADMIN_IDENTITY),
    rateLimitNow: () => clock.now,
    config:
      options.publicDownloadsPerMinute === undefined
        ? config
        : { ...config, publicDownloadsPerMinute: options.publicDownloadsPerMinute },
  });
}

/** Sends `count` requests from one address, and returns the answers. */
function burst(
  app: FastifyInstance,
  count: number,
  options: { url?: string; address?: string; headers?: Record<string, string> } = {},
) {
  const url = options.url ?? '/_public/api/countries?sort=unsupported';
  const address = options.address ?? '203.0.113.7';
  return Promise.all(
    Array.from({ length: count }, () =>
      app.inject({
        method: 'GET',
        url,
        // `trustProxy` is `loopback` by default and `inject` connects from 127.0.0.1, so this header is the client.
        headers: { 'x-forwarded-for': address, ...options.headers },
      }),
    ),
  );
}

describe('the stage charges the documented requests, and only those', () => {
  it('lets the public read allowance through and refuses the next request with a documented 429', async () => {
    const clock = clockAt('2026-10-25T09:00:00.000Z');
    const app = await appWithClock(clock);
    try {
      const responses = await burst(app, PUBLIC_READ_REQUESTS_PER_MINUTE + 1);
      const allowed = responses.slice(0, PUBLIC_READ_REQUESTS_PER_MINUTE);
      const refused = responses.at(-1);

      // The invalid sort reaches the public handler and fails validation without a database query.
      for (const response of allowed) expect(response.statusCode).toBe(400);
      expect(refused?.statusCode).toBe(429);

      const body = refused?.json<{ error: { code: string; details: unknown } }>();
      expect(body?.error.code).toBe('RATE_LIMITED');
      // The header and the body describe the same instant, and the body satisfies the shared schema.
      const details = LoginRateLimitDetailsSchema.parse(body?.error.details);
      expect(refused?.headers['retry-after']).toBe(String(details.retryAfterSeconds));
      expect(details.retryAfterSeconds).toBe(60);
      expect(details.lockedUntil).toBe('2026-10-25T09:01:00.000Z');
    } finally {
      await app.close();
    }
  });

  it('gives each address its own allowance', async () => {
    const clock = clockAt('2026-10-25T09:00:00.000Z');
    const app = await appWithClock(clock);
    try {
      await burst(app, PUBLIC_READ_REQUESTS_PER_MINUTE, { address: '203.0.113.7' });
      expect(
        (await burst(app, 1, { address: '203.0.113.7' }))[0]?.statusCode,
        'the exhausted address',
      ).toBe(429);
      // One visitor cannot spend another's allowance — the reason the key is the address and not the process.
      expect((await burst(app, 1, { address: '198.51.100.7' }))[0]?.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('uses the configured limit for the download endpoint, not the read limit', async () => {
    const clock = clockAt('2026-10-25T09:00:00.000Z');
    // Three, so the case stays readable; the default is `PUBLIC_DOWNLOADS_PER_MINUTE` (10).
    const app = await appWithClock(clock, { publicDownloadsPerMinute: 3 });
    try {
      const responses = await burst(app, 4, { url: DOWNLOAD_URL });
      // The download route itself belongs to the public API (`P3-PUB-*`) and answers `404` today; what this case is
      // about is that a *charged* request gets past the limiter, so `404` is the marker and `429` the refusal.
      expect(responses.slice(0, 3).map((response) => response.statusCode)).toEqual([404, 404, 404]);
      expect(responses[3]?.statusCode).toBe(429);

      // A download does not spend the *read* allowance: the two rules are separate windows on purpose, so a client
      // downloading files cannot be locked out of the country list (and the reverse).
      expect((await burst(app, 1))[0]?.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('charges the admin allowance per token, so one runaway client cannot lock out another', async () => {
    const clock = clockAt('2026-10-25T09:00:00.000Z');
    const app = await appWithClock(clock);
    const first = `Bearer mm_${'a'.repeat(43)}`;
    const second = `Bearer mm_${'b'.repeat(43)}`;
    try {
      const token = (count: number, authorization: string) =>
        Promise.all(
          Array.from({ length: count }, () =>
            app.inject({
              method: 'GET',
              url: '/_admin/api/catalog',
              headers: { authorization },
            }),
          ),
        );

      const responses = await token(ADMIN_REQUESTS_PER_MINUTE + 1, first);
      // `authVerify` accepts anything. These requests must reach the handler; only the next one is a rate-limit refusal.
      expect(responses.slice(0, ADMIN_REQUESTS_PER_MINUTE).every((r) => r.statusCode !== 429)).toBe(
        true,
      );
      expect(responses.at(-1)?.statusCode).toBe(429);
      expect(responses.at(-1)?.headers['retry-after']).toBe('60');

      // A second administrator, or the same one on another device, has its own bucket.
      expect((await token(1, second))[0]?.statusCode).not.toBe(429);
    } finally {
      await app.close();
    }
  });

  it('does not charge a request without a token, which the guard refuses for free', async () => {
    const clock = clockAt('2026-10-25T09:00:00.000Z');
    const app = await appWithClock(clock);
    const authorization = `Bearer mm_${'c'.repeat(43)}`;
    try {
      for (let request = 0; request < 3; request += 1) {
        expect((await app.inject({ method: 'GET', url: '/_admin/api/catalog' })).statusCode).toBe(
          401,
        );
      }
      // The three anonymous requests above spent nothing: the token still has its whole allowance.
      const responses = await Promise.all(
        Array.from({ length: ADMIN_REQUESTS_PER_MINUTE }, () =>
          app.inject({
            method: 'GET',
            url: '/_admin/api/catalog',
            headers: { authorization },
          }),
        ),
      );
      expect(responses.every((response) => response.statusCode !== 429)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('does not spend the allowance on CORS preflights', async () => {
    // A preflight is the browser asking permission, not the client making a request: the `security` stage answers it
    // and ends the response before this hook runs. Charging it would halve every browser's real allowance and, worse,
    // could answer the *preflight* with `429` — which a browser reports as a CORS failure, not as a rate limit.
    const clock = clockAt('2026-10-25T09:00:00.000Z');
    const app = await buildTestApp({
      authVerify: () => Promise.resolve(TEST_ADMIN_IDENTITY),
      config: {
        ...parseEnv({}),
        corsOrigins: ['https://maps.example.org'],
        publicDownloadsPerMinute: 3,
      },
      rateLimitNow: () => clock.now,
    });
    try {
      const preflights = await Promise.all(
        Array.from({ length: 100 }, () =>
          app.inject({
            method: 'OPTIONS',
            url: '/_public/api/countries',
            headers: {
              origin: 'https://maps.example.org',
              'access-control-request-method': 'GET',
              'access-control-request-headers': 'authorization',
              'x-forwarded-for': '203.0.113.7',
            },
          }),
        ),
      );
      expect(preflights.every((response) => response.statusCode === 204)).toBe(true);

      // The whole allowance is still there afterwards.
      const reads = await burst(app, PUBLIC_READ_REQUESTS_PER_MINUTE);
      expect(reads.every((response) => response.statusCode === 400)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('never limits the probes', async () => {
    const clock = clockAt('2026-10-25T09:00:00.000Z');
    const app = await appWithClock(clock);
    try {
      // Well past every documented limit: a monitor is not a client, and throttling it would invent the outage it
      // reports (`14-security.md` §7).
      for (let request = 0; request < PUBLIC_READ_REQUESTS_PER_MINUTE + 5; request += 1) {
        const response = await app.inject({ method: 'GET', url: '/healthz' });
        expect(response.statusCode, `request ${String(request)}`).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('lets the allowance recover when the window passes', async () => {
    const clock = clockAt('2026-10-25T09:00:00.000Z');
    const app = await appWithClock(clock, { publicDownloadsPerMinute: 1 });
    try {
      expect((await burst(app, 1, { url: DOWNLOAD_URL }))[0]?.statusCode).toBe(404);
      expect((await burst(app, 1, { url: DOWNLOAD_URL }))[0]?.statusCode).toBe(429);

      clock.advance(RATE_LIMIT_WINDOW_MS);
      expect((await burst(app, 1, { url: DOWNLOAD_URL }))[0]?.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('the limits match the table an operator reads', () => {
  it('14-security.md §7 states the numbers this code uses', () => {
    const doc = readFileSync(resolve(import.meta.dirname, '../../../docs/14-security.md'), 'utf8');
    const start = doc.indexOf('## 7. Rate limiting');
    expect(start, '14-security.md §7 must exist').toBeGreaterThan(-1);
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1));

    const row = (label: RegExp): number | null => {
      const match = label.exec(section);
      return match?.[1] === undefined ? null : Number(match[1]);
    };

    expect(row(/\| `\/_public\/api\/countries\*` \| (\d+) \/ min/u)).toBe(
      PUBLIC_READ_REQUESTS_PER_MINUTE,
    );
    expect(row(/\| `\/_admin\/api\/\*` \| (\d+) \/ min/u)).toBe(ADMIN_REQUESTS_PER_MINUTE);
    // The download limit is the one an operator can move (`PUBLIC_DOWNLOADS_PER_MINUTE`), so the document states the
    // default and `config/env.ts` holds the same number.
    expect(row(/\| `\/_public\/api\/countries\/:slug\/download` \| (\d+) \/ min/u)).toBe(
      parseEnv({}).publicDownloadsPerMinute,
    );
  });

  it('14-security.md §7 describes the login throttle in the direction the code counts', () => {
    // The row used to read "10 / 15 min per IP (+ per-username counter)" — the shape of the policy backwards. The shipped
    // throttle allows **10 per `(ip, username)` pair** and **30 per IP**, which is the opposite claim: the pair limit is
    // the tight one and the per-IP limit is three times looser (ADR-027, `15-decisions.md`). An operator reading the old
    // row would expect a single address to be limited to ten attempts in total, and would see thirty. Measured, pass 41:
    // ten failures from one address lock that pair, and an eleventh attempt for the same username from a *different*
    // address is answered `401`, not `429`.
    const doc = readFileSync(resolve(import.meta.dirname, '../../../docs/14-security.md'), 'utf8');
    const start = doc.indexOf('## 7. Rate limiting');
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1));
    const cell = /\| `POST \/_auth\/api\/login` \| (.+?) \|/u.exec(section)?.[1] ?? '';
    const configured = parseEnv({});
    const throttle = loginThrottleFromConfig(configured);

    // Both limits, each attached to the key it counts: pair first, then the address.
    const pair = /(\d+) \/ (\d+) min per \(IP, username\) pair/u.exec(cell);
    const perIp = /(\d+) \/ (\d+) min per IP/u.exec(cell);

    expect(pair?.[1], 'the pair limit the code uses').toBe(String(throttle.maxAttempts));
    expect(perIp?.[1], 'the per-IP limit the code uses').toBe(String(throttle.perIpLimit));
    expect(throttle.maxAttempts).toBe(configured.authMaxLoginAttempts);
    // Three times the pair limit, which is the whole point of the multiplier: one office address must survive three
    // colleagues fumbling their own passwords.
    expect(throttle.perIpLimit).toBe(throttle.maxAttempts * 3);

    // The window is one number in the code (`AUTH_LOCKOUT_MINUTES`) and must be the same number for both counters.
    expect(pair?.[2]).toBe(String(configured.authLockoutMinutes));
    expect(perIp?.[2]).toBe(String(configured.authLockoutMinutes));
    // And the row must not go back to saying the address is the tight one.
    expect(cell, 'the per-IP limit is the looser of the two').not.toMatch(/^10 \/ 15 min per IP /u);
  });
});
