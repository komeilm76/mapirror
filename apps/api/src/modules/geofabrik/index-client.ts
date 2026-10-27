/**
 * Geofabrik's machine-readable region catalog (`P2-SRC-02`, GEO-1).
 *
 * The provider publishes a GeoJSON feature collection at `index-v1-nogeom.json`. This client validates the external
 * JSON with Zod before translating its source field names into the `SourceRegion` contract. Extra upstream fields are
 * intentionally ignored: catalog sync consumes only the index identity, hierarchy, names, ISO codes and PBF URL.
 *
 * @module modules/geofabrik/index-client
 */

import { z } from 'zod';

import type { SourceRegion } from './source';

/** The published index resource, relative to the configured Geofabrik base URL. */
export const GEOFABRIK_INDEX_FILENAME = 'index-v1-nogeom.json';

/** One optional ISO-code list in the upstream properties. */
const IsoCodesSchema = z
  .array(z.string().trim().min(1))
  .nullable()
  .optional()
  .transform((codes) => codes ?? []);

/** The subset of a feature's properties this application uses. */
const GeofabrikPropertiesSchema = z
  .object({
    id: z.string().trim().min(1),
    parent: z.string().trim().min(1).nullable().optional().default(null),
    name: z.string().trim().min(1),
    'iso3166-1:alpha2': IsoCodesSchema,
    'iso3166-2': IsoCodesSchema,
    urls: z
      .object({
        pbf: z
          .url({ protocol: /^https?$/, error: 'must be an absolute HTTP(S) URL' })
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** One feature in the no-geometry index. Geometry and unrelated properties are not needed by the catalog. */
const GeofabrikFeatureSchema = z
  .object({
    type: z.literal('Feature'),
    properties: GeofabrikPropertiesSchema,
  })
  .passthrough();

/** The validated subset of Geofabrik's index-v1 feature collection. */
const GeofabrikIndexSchema = z
  .object({
    type: z.literal('FeatureCollection'),
    features: z.array(GeofabrikFeatureSchema),
  })
  .passthrough();

/**
 * Parses and normalizes an upstream index document.
 *
 * Validation happens before mapping so malformed records cannot silently enter the local catalog. Unknown GeoJSON and
 * property members are accepted but discarded; the output is the small contract used by the application.
 *
 * @param input - Parsed JSON from the upstream index (or a test fixture).
 * @returns Regions in the source's order.
 * @throws {z.ZodError} When the document or any required record field has the wrong shape.
 */
export function parseGeofabrikIndex(input: unknown): SourceRegion[] {
  const parsed = GeofabrikIndexSchema.parse(input);

  return parsed.features.map(({ properties }) => ({
    id: properties.id,
    parentId: properties.parent,
    name: properties.name,
    isoAlpha2: properties['iso3166-1:alpha2'],
    isoOther: properties['iso3166-2'],
    pbfUrl: properties.urls?.pbf ?? null,
  }));
}

/** Optional transport controls for one index request. */
export interface GeofabrikIndexOptions {
  /** Fetch implementation; injectable for offline tests. */
  readonly fetchImpl?: (input: URL, init?: RequestInit) => Promise<Response>;
  /** Optional caller cancellation; aborts the active request and body read promptly. */
  readonly signal?: AbortSignal;
  /** Deadline in milliseconds; defaults to 10 seconds and is capped at 30 seconds. */
  readonly timeoutMs?: number;
}

/** Internal marker used to provide a safe timeout diagnostic. */
class IndexTimeoutError extends Error {}

/**
 * Loads and parses the configured Geofabrik index under a bounded deadline.
 *
 * @param baseUrl - Configured source base URL, such as `https://download.geofabrik.de`.
 * @param options - Optional fetch seam, cancellation signal and bounded deadline.
 * @returns The validated source regions.
 * @throws When the request fails, times out, returns a non-2xx status, is canceled, or the response JSON is invalid.
 */
export async function fetchGeofabrikRegions(
  baseUrl: string,
  options: GeofabrikIndexOptions = {},
): Promise<SourceRegion[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError('Geofabrik index timeoutMs must be an integer from 1 to 30000');
  }
  const endpoint = new URL(baseUrl);
  const basePath = endpoint.pathname.replace(/\/+$/u, '');
  endpoint.pathname = `${basePath}/${GEOFABRIK_INDEX_FILENAME}`;
  endpoint.search = '';
  endpoint.hash = '';

  const controller = new AbortController();
  let rejectCaller: ((reason: unknown) => void) | undefined;
  const callerAbort = new Promise<never>((_resolve, reject) => {
    rejectCaller = reject;
  });
  const abortFromCaller = (): void => {
    controller.abort(options.signal?.reason);
    rejectCaller?.(options.signal?.reason ?? new Error('Geofabrik index request was canceled'));
  };
  if (options.signal?.aborted === true) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new IndexTimeoutError());
      controller.abort();
    }, timeoutMs);
  });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const request = Promise.resolve().then(async () => {
    const response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Geofabrik index request failed with HTTP ${String(response.status)}`);
    }
    const payload: unknown = await response.json();
    return parseGeofabrikIndex(payload);
  });

  try {
    const result = await Promise.race(
      options.signal === undefined ? [request, timeout] : [request, timeout, callerAbort],
    );
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new Error('Geofabrik index request was canceled');
    }
    return result;
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason ?? error;
    if (error instanceof IndexTimeoutError) {
      throw new Error('Geofabrik index request timed out');
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
