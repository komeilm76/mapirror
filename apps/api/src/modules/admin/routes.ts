/**
 * `/_admin/api/*` — admin routes (Bearer, deny by default — L2).
 *
 * Registered by {@link registerRoutes}. Every route under this prefix must be protected by the **global**
 * guard (`P1-AUTH-05`) rather than by per-route checks; an unprotected admin route is exactly the failure
 * mode L2 exists to prevent. Catalog listing is implemented here; other admin routes remain owned by their task stubs.
 *
 * @module modules/admin/routes
 */

import type { FastifyPluginCallback } from 'fastify';

import { getCatalog } from './catalog-route';
import { postCatalogSync } from './catalog-sync-route';

/** Catalog, cache, versions, imports, intervals, jobs, system, settings, audit land here. */
export const adminRoutes: FastifyPluginCallback = (app) => {
  app.get('/catalog', getCatalog);
  app.post('/catalog/sync', postCatalogSync);
};
