/**
 * `/_admin/api/*` — admin routes (Bearer, deny by default — L2).
 *
 * Registered by {@link registerRoutes}. Every route under this prefix must be protected by the **global**
 * guard (`P1-AUTH-05`) rather than by per-route checks; an unprotected admin route is exactly the failure
 * mode L2 exists to prevent. Until the guard lands the only thing here is a stub that returns no data.
 *
 * @module modules/admin/routes
 */

import type { FastifyPluginCallback } from 'fastify';

import { notImplemented } from '../../routes/not-implemented';

/** Catalog, cache, versions, imports, intervals, jobs, system, settings, audit land here. */
export const adminRoutes: FastifyPluginCallback = (app) => {
  app.get('/catalog', notImplemented('GET /_admin/api/catalog'));
};
