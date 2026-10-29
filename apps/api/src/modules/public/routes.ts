/**
 * `/_public/api/*` — public read-only routes (`P3-API-03`…`P3-API-06`).
 *
 * Registered by {@link registerRoutes}. Public routes may only read what an admin explicitly published
 * (L2/L8); that filter belongs in the read model, not in these route definitions.
 *
 * @module modules/public/routes
 */

import type { FastifyPluginCallback } from 'fastify';

import { getPublicCountries } from './countries-route';

/** Countries, versions, download, stats land here. */
export const publicRoutes: FastifyPluginCallback = (app) => {
  app.get('/countries', getPublicCountries);
};
