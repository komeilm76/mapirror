/**
 * `/_public/api/*` — public read-only routes (`P3-API-03`…`P3-API-06`).
 *
 * Registered by {@link registerRoutes}. Public routes may only read what an admin explicitly published
 * (L2/L8); that filter belongs in the read model, not in these route definitions.
 *
 * @module modules/public/routes
 */

import type { FastifyPluginCallback } from 'fastify';

import type { AppConfig } from '../../config/env';
import { getPublicCountries, getPublicCountry, getPublicCountryVersions } from './countries-route';
import { createPublicCountryDownloadHandler } from './country-download-route';
import { getPublicStatsResponse } from './stats-route';

/** Countries, versions, download, stats land here. */
export const publicRoutes: FastifyPluginCallback<{ config: AppConfig }> = (app, options) => {
  app.get('/stats', getPublicStatsResponse);
  app.get('/countries', getPublicCountries);
  app.get('/countries/:slug/versions', getPublicCountryVersions);
  app.get('/countries/:slug', getPublicCountry);
  app.get(
    '/countries/:slug/download',
    createPublicCountryDownloadHandler({ config: options.config }),
  );
};
