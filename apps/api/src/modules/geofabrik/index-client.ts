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

/**
 * Loads and parses the configured Geofabrik index.
 *
 * This method fetches the JSON only; caching, catalog writes and retries belong to their job/source tasks. It does not
 * include the full URL in HTTP-status errors, keeping custom mirror credentials or query data out of logs.
 *
 * @param baseUrl - Configured source base URL, such as `https://download.geofabrik.de`.
 * @param fetchImpl - Fetch implementation; injectable for offline tests.
 * @returns The validated source regions.
 * @throws When the request fails, returns a non-2xx status, or the response JSON does not satisfy the index schema.
 */
export async function fetchGeofabrikRegions(
  baseUrl: string,
  fetchImpl: (input: URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<SourceRegion[]> {
  const endpoint = new URL(baseUrl);
  const basePath = endpoint.pathname.replace(/\/+$/u, '');
  endpoint.pathname = `${basePath}/${GEOFABRIK_INDEX_FILENAME}`;
  endpoint.search = '';
  endpoint.hash = '';

  const response = await fetchImpl(endpoint, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Geofabrik index request failed with HTTP ${String(response.status)}`);
  }

  const payload: unknown = await response.json();
  return parseGeofabrikIndex(payload);
}
