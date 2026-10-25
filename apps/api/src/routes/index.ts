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

/** Registers every API namespace under its prefix. Runs last in the pipeline. */
export const registerRoutes: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes, { prefix: ROUTE_PREFIXES.authApi });
  await app.register(adminRoutes, { prefix: ROUTE_PREFIXES.adminApi });
  await app.register(publicRoutes, { prefix: ROUTE_PREFIXES.publicApi });
};
