/**
 * `/_admin/api/*` — admin routes (Bearer, deny by default — L2).
 *
 * Registered by {@link registerRoutes}. Every route under this prefix must be protected by the **global**
 * guard (`P1-AUTH-05`) rather than by per-route checks; an unprotected admin route is exactly the failure
 * mode L2 exists to prevent. Catalog, cache, version and job routes register here as their tasks are implemented.
 *
 * @module modules/admin/routes
 */

import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';

import type { AppConfig } from '../../config/env';
import { createGeofabrikMapSource } from '../geofabrik/map-source';
import { createUpdateChecker, UPDATE_CHECK_SOURCE_TIMEOUT_MS } from '../updates/update-check';
import {
  createCacheDownloadHandler,
  createCacheSpecificVersionHandler,
} from './cache-download-route';
import { createCacheDeleteHandler } from './cache-delete-route';
import { createCacheVersionDeleteHandler } from './cache-version-delete-route';
import { createCacheVersionDownloadHandler } from './cache-version-download-route';
import { createCancelJobHandler, getJob, getJobs } from './jobs-route';
import { getCacheDetail, getCacheList } from './cache-route';
import { postCachePublic } from './cache-public-route';
import { getCacheVersions } from './cache-versions-route';
import { createCatalogRegionHandlers } from './catalog-region-route';
import { getCatalog } from './catalog-route';
import { postCatalogSync } from './catalog-sync-route';
import { postCacheUpdateCheck, postCacheUpdateChecks } from './cache-update-check-route';
import { createImportHandler } from './import-route';
import { getImportStatus } from './import-status-route';
import { deleteInterval, getIntervals, patchInterval, postInterval } from './intervals-route';
import { getIntervalRun, getIntervalRuns, postIntervalRun } from './interval-runs-route';
import { getSystemMetrics, getSystemStatus } from './system-routes';

/** The validated settings required to configure admin source reads. */
export interface AdminRouteOptions {
  readonly config: AppConfig;
}

/** Catalog, cache, versions, imports, intervals, jobs, system, settings, audit land here. */
export const adminRoutes: FastifyPluginAsync<AdminRouteOptions> = async (app, options) => {
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: {
      fileSize: options.config.maxUploadBytes,
      files: 1,
      fields: 3,
      parts: 4,
      fieldSize: 256,
    },
  });
  const importHandler = createImportHandler({ config: options.config });
  const cancelJob = createCancelJobHandler(options.config);
  const source = createGeofabrikMapSource(options.config.geofabrikBaseUrl);
  const updateChecker = createUpdateChecker({
    database: app.db.db,
    source: createGeofabrikMapSource(options.config.geofabrikBaseUrl, {
      pageTimeoutMs: UPDATE_CHECK_SOURCE_TIMEOUT_MS,
    }),
    log: app.log,
  });
  const regionHandlers = createCatalogRegionHandlers(source);
  const cacheDownload = createCacheDownloadHandler({ config: options.config, source });
  const cacheSpecificVersion = createCacheSpecificVersionHandler({
    config: options.config,
    source,
  });
  const cacheDelete = createCacheDeleteHandler({ config: options.config });
  const cacheVersionDelete = createCacheVersionDeleteHandler({ config: options.config });
  const cacheVersionDownload = createCacheVersionDownloadHandler({ config: options.config });
  app.get('/catalog', getCatalog);
  app.post('/catalog/sync', postCatalogSync);
  app.get('/catalog/regions/:slug', regionHandlers.getRegion);
  app.get('/catalog/regions/:slug/snapshots', regionHandlers.getSnapshots);
  app.get('/cache', getCacheList);
  app.get('/cache/:countryId', getCacheDetail);
  app.post('/cache/:countryId/check-update', (request) =>
    postCacheUpdateCheck(request, updateChecker),
  );
  app.post('/cache/check-updates', postCacheUpdateChecks);
  app.post('/cache/:countryId/public', postCachePublic);
  app.get('/cache/:countryId/versions', getCacheVersions);
  app.post('/cache/:countryId/versions', cacheSpecificVersion);
  app.delete('/cache/:countryId/versions/:versionId', cacheVersionDelete);
  app.get('/cache/:countryId/versions/:versionId/download', cacheVersionDownload);
  app.delete('/cache/:countryId', cacheDelete);
  app.post('/cache/downloads', cacheDownload);
  app.post('/imports', importHandler);
  app.get('/imports/:uploadId', getImportStatus);
  app.get('/intervals', getIntervals);
  app.post('/intervals', postInterval);
  app.patch('/intervals/:id', patchInterval);
  app.delete('/intervals/:id', deleteInterval);
  app.post('/intervals/:id/run', postIntervalRun);
  app.get('/intervals/:id/runs', getIntervalRuns);
  app.get('/interval-runs/:runId', getIntervalRun);
  app.get('/jobs', getJobs);
  app.get('/jobs/:jobId', getJob);
  app.get('/system/status', (request) => getSystemStatus(request, options.config));
  app.get('/system/metrics', (request) => getSystemMetrics(request));
  app.post('/jobs/:jobId/cancel', cancelJob);
};
