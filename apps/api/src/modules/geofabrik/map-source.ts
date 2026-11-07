/**
 * Concrete Geofabrik {@link MapSource} composition for catalog reads and queued downloads (`P2-API-04`).
 *
 * Page and file metadata remain bounded by their dedicated clients; this module connects them to the small provider
 * contract and resolves raw index IDs to their hierarchical paths from the index PBF URLs. It never downloads or stores
 * the PBF body.
 *
 * @module modules/geofabrik/map-source
 */

import { fetchGeofabrikRegions } from './index-client';
import {
  fetchGeofabrikHeadMetadata,
  GeofabrikMetadataHttpError,
  type GeofabrikFetch,
} from './file-metadata';
import {
  fetchGeofabrikRegionPage,
  geofabrikRegionPathFromPbfUrl,
  geofabrikRegionPbfUrl,
  createGeofabrikRegionPageSource,
  GeofabrikRegionPageHttpError,
} from './region-page-client';
import type { MapSource, ResolvedDownload, SourceRegion } from './source';

/** An explicit dated source version that Geofabrik no longer offers. */
export class GeofabrikSnapshotGoneError extends Error {
  constructor(readonly version: string) {
    super(`Geofabrik no longer offers snapshot ${version}`);
    this.name = 'GeofabrikSnapshotGoneError';
  }
}

/** Optional offline-test seam for all Geofabrik HTTP operations. */
export interface GeofabrikMapSourceOptions {
  /** Fetch implementation shared by the index, HTML page, HEAD, and checksum clients. */
  readonly fetchImpl?: GeofabrikFetch;
  /** Per-request deadline for region-page reads and index-based path lookups; defaults and maximum follow their clients. */
  readonly pageTimeoutMs?: number;
  /** Per-request deadline for HEAD metadata; defaults and maximum follow the metadata client. */
  readonly metadataTimeoutMs?: number;
  /** Maximum attempts for HEAD metadata; defaults and maximum follow the metadata client. */
  readonly metadataMaxAttempts?: number;
  /** Retry delay for HEAD metadata; defaults and maximum follow the metadata client. */
  readonly metadataRetryDelayMs?: number;
}

/**
 * Composes the concrete Geofabrik source used by production catalog and download workers.
 *
 * The API resolves the mutable `latest` name to the page's newest dated snapshot and independently probes the matching
 * PBF alias for the current size and validators. A deleted explicit version is distinguishable from a transient source
 * outage; all other upstream failures remain ordinary errors for the HTTP route to map to `SOURCE_UNAVAILABLE`.
 *
 * @param baseUrl - Validated configured Geofabrik base URL.
 * @param options - Optional HTTP seam and bounded-client controls.
 * @returns The complete provider used by the catalog and download handler.
 */
export function createGeofabrikMapSource(
  baseUrl: string,
  options: GeofabrikMapSourceOptions = {},
): MapSource {
  const pageOptions = {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.pageTimeoutMs === undefined ? {} : { timeoutMs: options.pageTimeoutMs }),
  };
  const indexOptions = {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.pageTimeoutMs === undefined ? {} : { timeoutMs: options.pageTimeoutMs }),
  };
  let regionPaths: ReadonlyMap<string, string> | undefined;
  let regionPathsExpiresAt = 0;
  let regionPathsRequest: Promise<ReadonlyMap<string, string>> | undefined;

  const rememberRegionPaths = (regions: readonly SourceRegion[]): ReadonlyMap<string, string> => {
    const paths = new Map<string, string>();
    for (const region of regions) {
      if (region.pbfUrl === null) continue;
      try {
        paths.set(region.id, geofabrikRegionPathFromPbfUrl(region.pbfUrl, baseUrl));
      } catch {
        // A region with a non-standard or malformed PBF URL cannot be used for page or extract requests.
      }
    }
    regionPaths = paths;
    regionPathsExpiresAt = Date.now() + 5 * 60_000;
    return paths;
  };

  const getRegionPaths = async (signal?: AbortSignal): Promise<ReadonlyMap<string, string>> => {
    if (regionPaths !== undefined && Date.now() < regionPathsExpiresAt) return regionPaths;
    if (signal !== undefined) {
      return fetchGeofabrikRegions(baseUrl, { ...indexOptions, signal }).then(rememberRegionPaths);
    }
    if (regionPathsRequest !== undefined) return regionPathsRequest;
    regionPathsRequest = fetchGeofabrikRegions(baseUrl, indexOptions)
      .then(rememberRegionPaths)
      .finally(() => {
        regionPathsRequest = undefined;
      });
    return regionPathsRequest;
  };

  const resolveRegionPath = async (regionId: string, signal?: AbortSignal): Promise<string> => {
    // Keep compatibility with callers that already have the full path from an older catalog or explicit source ID.
    if (regionId.includes('/')) return regionId;
    const regionPath = (await getRegionPaths(signal)).get(regionId);
    if (regionPath === undefined) {
      throw new Error('Geofabrik index does not provide a PBF path for this region');
    }
    return regionPath;
  };

  const pageSource = createGeofabrikRegionPageSource(baseUrl, pageOptions, resolveRegionPath);

  return {
    id: 'geofabrik',
    listRegions: async (signal) => {
      const regions = await fetchGeofabrikRegions(baseUrl, {
        ...indexOptions,
        ...(signal === undefined ? {} : { signal }),
      });
      rememberRegionPaths(regions);
      return regions;
    },

    getRegionDetail: pageSource.getRegionDetail,
    listSnapshots: pageSource.listSnapshots,
    async resolveDownload(regionId, requestedVersion, signal): Promise<ResolvedDownload> {
      if (requestedVersion !== 'latest' && !/^\d{6}$/u.test(requestedVersion)) {
        throw new TypeError('Geofabrik snapshot version must be a six-digit date or latest');
      }

      const regionPath = await resolveRegionPath(regionId, signal);
      let page;
      try {
        page = await fetchGeofabrikRegionPage(baseUrl, regionPath, {
          ...pageOptions,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (requestedVersion !== 'latest' && isNotFound(error)) {
          throw new GeofabrikSnapshotGoneError(requestedVersion);
        }
        throw error;
      }

      const snapshot =
        requestedVersion === 'latest'
          ? page.snapshots[0]
          : page.snapshots.find(({ version }) => version === requestedVersion);
      if (requestedVersion !== 'latest' && snapshot === undefined) {
        throw new GeofabrikSnapshotGoneError(requestedVersion);
      }

      const url = geofabrikRegionPbfUrl(baseUrl, regionPath, requestedVersion).href;
      let metadata;
      try {
        metadata = await fetchGeofabrikHeadMetadata(url, {
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.metadataTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.metadataTimeoutMs }),
          ...(options.metadataMaxAttempts === undefined
            ? {}
            : { maxAttempts: options.metadataMaxAttempts }),
          ...(options.metadataRetryDelayMs === undefined
            ? {}
            : { retryDelayMs: options.metadataRetryDelayMs }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (
          requestedVersion !== 'latest' &&
          error instanceof GeofabrikMetadataHttpError &&
          error.status === 404
        ) {
          throw new GeofabrikSnapshotGoneError(requestedVersion);
        }
        throw error;
      }

      return {
        version: snapshot?.version ?? null,
        url,
        sizeBytes: metadata.sizeBytes ?? snapshot?.sizeBytes ?? null,
        dataTimestamp: snapshot?.dataTimestamp ?? page.dataTimestamp,
        // The worker obtains and validates the bounded .md5 sidecar before it commits a file.
        checksumMd5: null,
        etag: metadata.etag,
        lastModified: metadata.lastModified,
      };
    },
  };
}

/** Whether a page or PBF metadata request definitively returned HTTP 404. */
function isNotFound(error: unknown): boolean {
  return (
    (error instanceof GeofabrikRegionPageHttpError ||
      error instanceof GeofabrikMetadataHttpError) &&
    error.status === 404
  );
}
