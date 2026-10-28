/**
 * Route registration (task `P1-API-01`).
 *
 * One encapsulated plugin per API prefix, registered in the order of the prefixes in `@mapirror/shared`
 * (auth, admin, public). Encapsulation is the point: a hook added inside `adminRoutes` applies to the admin
 * API and nothing else, so the guard in `P1-AUTH-05` cannot accidentally protect — or fail to protect —
 * another namespace.
 *
 * The prefixes are not literals here; they come from the shared route law, which the web app and the law
 * tests read too. Adding a fourth namespace therefore cannot be done in one place.
 *
 * @module routes/index
 */

import { ROUTE_PREFIXES } from '@mapirror/shared';
import type { FastifyPluginAsync } from 'fastify';

import type { AppConfig } from '../config/env';
import { adminRoutes } from '../modules/admin/routes';
import { authRoutes } from '../modules/auth/routes';
import type { LoginThrottle } from '../modules/auth/login-throttle';
import { publicRoutes } from '../modules/public/routes';

import { probeRoutes } from './probes';

/** What the routes need from the configuration. */
export interface RouteOptions {
  /** Passed to the readiness probe, which proves it accepts a write. */
  readonly cacheDir: string;
  /** The validated configuration; `/login` reads the token TTL from it. */
  readonly config: AppConfig;
  /**
   * The process's login throttle — **the** one, built once in `app.ts` and handed down.
   *
   * Required on purpose. While it was optional the namespace could build a second throttle of its own, and two
   * counters in one process multiply every limit silently: a client would get twenty guesses at a password, ten against
   * each counter, with nothing in the code looking wrong.
   */
  readonly loginThrottle: LoginThrottle;
}

/**
 * Registers every API namespace under its prefix, plus the probes. Runs last in the pipeline.
 *
 * The probes come first only for readability — they are outside the prefixes and cannot collide with them, and
 * `onRoute` fires for them exactly as it does for the namespaces, so L1 sees them either way.
 */
export const registerRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  // The readiness budget is not configurable: `READY_PROBE_TIMEOUT_MS` is the number the docs quote and the one a
  // load balancer's own timeout is sized against. Tests that need a shorter one register `probeRoutes` themselves.
  await app.register(probeRoutes, { cacheDir: options.cacheDir });
  await app.register(authRoutes, {
    prefix: ROUTE_PREFIXES.authApi,
    config: options.config,
    throttle: options.loginThrottle,
  });
  await app.register(adminRoutes, {
    prefix: ROUTE_PREFIXES.adminApi,
    config: options.config,
  });
  await app.register(publicRoutes, { prefix: ROUTE_PREFIXES.publicApi });
};
