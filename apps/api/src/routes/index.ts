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

import { adminRoutes } from '../modules/admin/routes';
import { authRoutes } from '../modules/auth/routes';
import { publicRoutes } from '../modules/public/routes';

import { probeRoutes } from './probes';

/** What the routes need from the configuration. */
export interface RouteOptions {
  /** Passed to the readiness probe, which proves it accepts a write. */
  readonly cacheDir: string;
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
  await app.register(authRoutes, { prefix: ROUTE_PREFIXES.authApi });
  await app.register(adminRoutes, { prefix: ROUTE_PREFIXES.adminApi });
  await app.register(publicRoutes, { prefix: ROUTE_PREFIXES.publicApi });
};
