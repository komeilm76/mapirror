/** Start a source-backed cache download after source and disk preflights (`P2-API-04`). */

import {
  CacheDownloadRequestSchema,
  CacheDownloadResponseSchema,
  type CacheDownloadResponse,
} from '@mapirror/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mkdir } from 'node:fs/promises';

import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import { findCountryById } from '../../db/repositories/catalog';
import { findMapVersionByLabel } from '../../db/repositories/map-versions';
import type { MapSource } from '../geofabrik/source';
import { GeofabrikSnapshotGoneError } from '../geofabrik/map-source';
import { enqueueDownloadJob } from '../jobs/enqueue-download';
import { preflightDownloadSpace } from '../system/disk';

/** Dependencies for the download admission handler. */
export interface CacheDownloadRouteOptions {
  readonly config: AppConfig;
  readonly source: Pick<MapSource, 'resolveDownload'>;
}

/** Creates the authenticated download-admission handler. */
export function createCacheDownloadHandler(options: CacheDownloadRouteOptions) {
  return async function postCacheDownload(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<CacheDownloadResponse> {
    const parsed = CacheDownloadRequestSchema.safeParse(request.body);
    if (!parsed.success) throw parsed.error;

    const admin = request.authenticatedAdmin;
    if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

    const database = request.server.db.db;
    const country = await findCountryById(database, parsed.data.countryId);
    if (country === null || country.source !== 'geofabrik') {
      throw new AppError('NOT_FOUND', 'The requested catalog region does not exist.');
    }

    // An explicit snapshot is already a stable local key, so cached rejection must not depend on source uptime.
    if (parsed.data.version !== 'latest') {
      await rejectIfReadyCached(database, country.id, parsed.data.version);
    }

    let resolved;
    try {
      resolved = await options.source.resolveDownload(country.source_id, parsed.data.version);
    } catch (error) {
      if (error instanceof GeofabrikSnapshotGoneError) {
        throw new AppError(
          'SOURCE_VERSION_GONE',
          'The requested dated snapshot is no longer available from the source. Choose latest or another offered snapshot.',
          { countryId: country.id, version: error.version },
          { cause: error },
        );
      }
      throw new AppError(
        'SOURCE_UNAVAILABLE',
        'The map source could not be reached. Try again shortly.',
        { countryId: country.id },
        { cause: error },
      );
    }

    const resolvedVersion =
      parsed.data.version === 'latest' ? resolved.version : parsed.data.version;
    if (parsed.data.version === 'latest' && resolved.dataTimestamp !== null) {
      await rejectIfReadyCached(database, country.id, latestVersionLabel(resolved.dataTimestamp));
    }

    // A cache root may not exist on first run. Create only the operator-configured root; the storage boundary still
    // canonicalizes it and rejects unsafe paths before any artifact is installed.
    await mkdir(options.config.cacheDir, { recursive: true, mode: 0o700 });
    await preflightDownloadSpace(
      options.config.cacheDir,
      resolved.sizeBytes,
      options.config.diskReserveBytes,
    );

    const jobId = await enqueueDownloadJob(database, {
      countryId: country.id,
      version: parsed.data.version,
      origin: parsed.data.version === 'latest' ? 'geofabrik_latest' : 'geofabrik_snapshot',
      createdBy: admin.id,
    });
    const response = CacheDownloadResponseSchema.parse({ jobId, resolvedVersion });
    reply.code(202);
    return response;
  };
}

/** Rejects a ready local row with this source identity, without confusing pending/failed rows with cached files. */
async function rejectIfReadyCached(
  database: FastifyRequest['server']['db']['db'],
  countryId: string,
  version: string,
): Promise<void> {
  const existing = await findMapVersionByLabel(database, countryId, version);
  if (existing?.status === 'ready') {
    throw new AppError(
      'VERSION_ALREADY_CACHED',
      'This source version is already cached for the requested region.',
      { countryId, version },
    );
  }
}

/** Mirrors the download worker's stable moving-latest identity for cached-version detection. */
function latestVersionLabel(dataTimestamp: Date): string {
  return `latest@${dataTimestamp
    .toISOString()
    .replace(/:/gu, '-')
    .replace(/\.\d{3}Z$/u, 'Z')}`;
}
