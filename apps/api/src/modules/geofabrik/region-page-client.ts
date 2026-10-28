/** Bounded HTTP adapter for Geofabrik region pages (`P2-API-03`).
 *
 * @module modules/geofabrik/region-page-client
 */

import type { MapSource, SourceRegionDetail, SourceSnapshot } from './source';
import { parseGeofabrikRegionPage, type ParsedGeofabrikRegionPage } from './region-page';

/** Injectable HTTP seam and resource bounds for region-page reads. */
export interface GeofabrikRegionPageOptions {
  /** Fetch implementation; injectable for deterministic offline tests. */
  readonly fetchImpl?: (input: URL, init?: RequestInit) => Promise<Response>;
  /** Deadline in milliseconds; defaults to 10 seconds and is capped at 30 seconds. */
  readonly timeoutMs?: number;
  /** Maximum decoded HTML body size; defaults to 2 MiB and is capped at 8 MiB. */
  readonly maxBytes?: number;
  /** Optional caller cancellation, honored during both the request and bounded body read. */
  readonly signal?: AbortSignal;
}

/** A non-success status returned by a Geofabrik region page. */
export class GeofabrikRegionPageHttpError extends Error {
  constructor(readonly status: number) {
    super(`Geofabrik region page returned HTTP ${String(status)}`);
    this.name = 'GeofabrikRegionPageHttpError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_MAX_BYTES = 8 * 1024 * 1024;

/** Builds a source page URL without allowing a database identity to escape the configured base path. */
export function geofabrikRegionPageUrl(baseUrl: string, regionId: string): URL {
  const segments = sourceIdSegments(regionId);
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('Geofabrik base URL must use HTTP or HTTPS');
  }
  const basePath = base.pathname.replace(/\/+$/u, '');
  const leaf = `${segments.pop()}.html`;
  base.pathname = `${basePath}/${[...segments, leaf].map(encodeURIComponent).join('/')}`;
  base.search = '';
  base.hash = '';
  return base;
}

/** Builds the normal or moving-latest extract URL from a Geofabrik source id. */
export function geofabrikRegionPbfUrl(baseUrl: string, regionId: string, version: string): URL {
  const segments = sourceIdSegments(regionId);
  if (version !== 'latest' && !/^\d{6}$/u.test(version)) {
    throw new TypeError('Geofabrik snapshot version must be a six-digit date or latest');
  }
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('Geofabrik base URL must use HTTP or HTTPS');
  }
  const basePath = base.pathname.replace(/\/+$/u, '');
  const leaf = `${segments.pop()}-${version}.osm.pbf`;
  base.pathname = `${basePath}/${[...segments, leaf].map(encodeURIComponent).join('/')}`;
  base.search = '';
  base.hash = '';
  return base;
}

/** Loads, bounds, and parses one upstream HTML page. */
export async function fetchGeofabrikRegionPage(
  baseUrl: string,
  regionId: string,
  options: GeofabrikRegionPageOptions = {},
): Promise<ParsedGeofabrikRegionPage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `Geofabrik region-page timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`,
    );
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MAX_BYTES) {
    throw new RangeError(
      `Geofabrik region-page maxBytes must be an integer from 1 to ${MAX_MAX_BYTES}`,
    );
  }

  const url = geofabrikRegionPageUrl(baseUrl, regionId);
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Geofabrik region page timed out')),
    timeoutMs,
  );
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { accept: 'text/html' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GeofabrikRegionPageHttpError(response.status);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && /^(?:0|[1-9]\d*)$/u.test(contentLength.trim())) {
      if (BigInt(contentLength.trim()) > BigInt(maxBytes)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Geofabrik region page exceeded its response size limit');
      }
    }
    if (response.body === null) throw new Error('Geofabrik region page returned an empty body');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) {
          throw new Error('Geofabrik region page returned an invalid response chunk');
        }
        totalBytes += result.value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error('Geofabrik region page exceeded its response size limit');
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseGeofabrikRegionPage(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Creates the Geofabrik region-page methods consumed by the admin catalog endpoints. */
export function createGeofabrikRegionPageSource(
  baseUrl: string,
  options: GeofabrikRegionPageOptions = {},
): Pick<MapSource, 'getRegionDetail' | 'listSnapshots'> {
  return {
    async getRegionDetail(regionId: string): Promise<SourceRegionDetail> {
      const page = await fetchGeofabrikRegionPage(baseUrl, regionId, options);
      const newest = page.snapshots[0];
      return {
        version: newest?.version ?? null,
        dataTimestamp: page.dataTimestamp,
        sizeBytes: newest?.sizeBytes ?? null,
        etag: null,
        lastModified: null,
      };
    },
    async listSnapshots(regionId: string): Promise<SourceSnapshot[]> {
      return (await fetchGeofabrikRegionPage(baseUrl, regionId, options)).snapshots;
    },
  };
}

/** Checks for URL and HTTP path control characters without embedding them in a regular-expression literal. */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
}

/** Validates source path components before encoding them into a URL. */
function sourceIdSegments(regionId: string): string[] {
  const segments = regionId.split('/');
  if (
    regionId.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..' || hasControlCharacter(segment),
    )
  ) {
    throw new TypeError('Geofabrik region id is not a safe path');
  }
  return segments;
}
