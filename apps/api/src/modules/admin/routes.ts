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

import type { AppConfig } from '../../config/env';
import { createGeofabrikMapSource } from '../geofabrik/map-source';
import {
  createCacheDownloadHandler,
  createCacheSpecificVersionHandler,
} from './cache-download-route';
import { createCacheDeleteHandler } from './cache-delete-route';
import { createCacheVersionDeleteHandler } from './cache-version-delete-route';
import { getCacheDetail, getCacheList } from './cache-route';
import { getCacheVersions } from './cache-versions-route';
import { createCatalogRegionHandlers } from './catalog-region-route';
import { getCatalog } from './catalog-route';
import { postCatalogSync } from './catalog-sync-route';

/** The validated settings required to configure admin source reads. */
export interface AdminRouteOptions {
  readonly config: AppConfig;
}

/** Catalog, cache, versions, imports, intervals, jobs, system, settings, audit land here. */
export const adminRoutes: FastifyPluginCallback<AdminRouteOptions> = (app, options) => {
  const source = createGeofabrikMapSource(options.config.geofabrikBaseUrl);
  const regionHandlers = createCatalogRegionHandlers(source);
  const cacheDownload = createCacheDownloadHandler({ config: options.config, source });
  const cacheSpecificVersion = createCacheSpecificVersionHandler({
    config: options.config,
    source,
  });
  const cacheDelete = createCacheDeleteHandler({ config: options.config });
  const cacheVersionDelete = createCacheVersionDeleteHandler({ config: options.config });
  app.get('/catalog', getCatalog);
  app.post('/catalog/sync', postCatalogSync);
  app.get('/catalog/regions/:slug', regionHandlers.getRegion);
  app.get('/catalog/regions/:slug/snapshots', regionHandlers.getSnapshots);
  app.get('/cache', getCacheList);
  app.get('/cache/:countryId', getCacheDetail);
  app.get('/cache/:countryId/versions', getCacheVersions);
  app.post('/cache/:countryId/versions', cacheSpecificVersion);
  app.delete('/cache/:countryId/versions/:versionId', cacheVersionDelete);
  app.delete('/cache/:countryId', cacheDelete);
  app.post('/cache/downloads', cacheDownload);
};
