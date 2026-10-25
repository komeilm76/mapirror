/**
 * The rate-limit stage (`P1-API-09`): per-client request limits for the public and admin namespaces.
 *
 * Slot 5 of the pipeline, ahead of the Bearer guard and the routes. Everything it protects is work that a flood would
 * otherwise make expensive: a public download loop, an admin UI stuck in a retry loop, and — because the guard hashes a
 * token and queries `admin_tokens` on **every** admin request — the read path behind the guard itself.
 *
 * The limits are the table in `14-security.md` §7, and a test parses that table so the document and these constants
 * cannot drift:
 *
 * | Requests | Limit | Key |
 * |---|---|---|
 * | `/_public/api/countries*` | 60 / min | client address |
 * | `/_public/api/countries/:slug/download` | `PUBLIC_DOWNLOADS_PER_MINUTE` / min (default 10) | client address |
 * | `/_admin/api/*` | 600 / min | `sha256` of the presented token |
 *
 * What is deliberately **not** here:
 *
 * - **Login.** `POST /_auth/api/login` has its own limiter (`modules/auth/login-throttle.ts`, ADR-027) with a longer
 *   window, per-username keys and in-flight reservations. A second counter in front of it would halve the documented
 *   allowance or double-count the same failure, and neither would be visible in the docs.
 * - **The probes.** `/healthz` and `/readyz` are unlimited by design (`14-security.md` §7): a container, a load balancer
 *   and an uptime monitor cannot hold a token or a budget, and throttling them would invent the outage they report.
 * - **Unauthenticated admin requests.** With no bearer token the answer is `401` before any work is done, so there is
 *   nothing to protect; keying a bucket on "no token" would just be a per-IP limit on a request that costs a map lookup.
 *
 * The counter is in memory, per process, and resets on restart — the same trade the login throttle makes, for the same
 * reason (`14-security.md` §7).
 *
 * @module plugins/rate-limit
 */

import { apiScopeOf } from '@mapirror/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config/env';
import { AppError } from '../lib/errors';
import { normaliseIp } from '../lib/client-ip';
import { SlidingWindowLimiter, type RateLimitVerdict } from '../lib/rate-limit';
import { readBearerToken } from '../modules/auth/session';
import { hashToken } from '../modules/auth/tokens';

/** The window every rule uses: one minute, as `14-security.md` §7 states. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** `/_public/api/*` reads allowed per address per minute (`14-security.md` §7). */
export const PUBLIC_READ_REQUESTS_PER_MINUTE = 60;

/** `/_admin/api/*` requests allowed per token per minute (`14-security.md` §7). */
export const ADMIN_REQUESTS_PER_MINUTE = 600;

/** What the stage needs. */
export interface RateLimitStageOptions {
  /** Configuration, for the one limit an operator can tune (`PUBLIC_DOWNLOADS_PER_MINUTE`). */
  readonly config: AppConfig;
  /** Clock, injectable so a test drives the window instead of waiting a minute for it. */
  readonly now?: () => Date;
}

/** The message a limited client is shown. One sentence, no advice that depends on which rule fired. */
const RATE_LIMITED_MESSAGE = 'Too many requests. Wait a moment and try again.';

/**
 * Reports whether a path is the per-download rule rather than the general read rule.
 *
 * `04-api.md` names exactly one download endpoint, `GET /_public/api/countries/:slug/download`, so the last segment is
 * the discriminator. The check is on the path **after** any query string, which `apiScopeOf` also ignores.
 *
 * @param url - Request URL, with or without a query string.
 * @returns `true` for the download endpoint.
 */
export function isDownloadRequest(url: string): boolean {
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  return path.endsWith('/download');
}

/**
 * Installs the limiter as one global `onRequest` hook.
 *
 * A single hook keyed on the namespace, rather than a per-route plugin: a route added later is limited automatically,
 * which is the same reason the Bearer guard is prefix-based (L2).
 *
 * @param app - Root instance to install on.
 * @param options - Configuration and an optional clock.
 */
export function installRateLimit(app: FastifyInstance, options: RateLimitStageOptions): void {
  const now = options.now ?? (() => new Date());

  const publicReads = new SlidingWindowLimiter({
    limit: PUBLIC_READ_REQUESTS_PER_MINUTE,
    windowMs: RATE_LIMIT_WINDOW_MS,
    now,
  });
  const publicDownloads = new SlidingWindowLimiter({
    limit: options.config.publicDownloadsPerMinute,
    windowMs: RATE_LIMIT_WINDOW_MS,
    now,
  });
  const adminRequests = new SlidingWindowLimiter({
    limit: ADMIN_REQUESTS_PER_MINUTE,
    windowMs: RATE_LIMIT_WINDOW_MS,
    now,
  });

  /**
   * Takes one slot from the rule that applies, or throws the documented `429`.
   *
   * @param limiter - The rule's counter.
   * @param key - What the allowance belongs to.
   * @throws {AppError} `RATE_LIMITED`, with the `details` shape every `429` in this API carries.
   */
  const charge = (limiter: SlidingWindowLimiter, key: string): void => {
    const verdict: RateLimitVerdict = limiter.take(key);
    if (verdict.allowed) return;
    throw new AppError('RATE_LIMITED', RATE_LIMITED_MESSAGE, {
      lockedUntil: verdict.resetAt.toISOString(),
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  };

  app.addHook('onRequest', (request: FastifyRequest, _reply, done) => {
    try {
      const scope = apiScopeOf(request.url);
      if (scope === 'public') {
        const address = `ip:${normaliseIp(request.ip) ?? 'unknown'}`;
        charge(isDownloadRequest(request.url) ? publicDownloads : publicReads, address);
      } else if (scope === 'admin') {
        const token = readBearerToken(request.headers.authorization);
        // No usable bearer: the guard answers `401` two stages later without touching the database, so this request
        // cannot become work worth limiting.
        if (token !== null) charge(adminRequests, `token:${hashToken(token).toString('hex')}`);
      }
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
