/**
 * Data licence and attribution (`01-overview.md`, `04-api.md` §3.1).
 *
 * OSM data is ODbL 1.0: attribution to OpenStreetMap and Geofabrik is a **legal requirement** of serving
 * it, not a design choice. Keeping the strings here — rather than in each page and each response builder —
 * means the public API, the country page and the footer cannot disagree, and a typo in the attribution
 * cannot ship. The strings are asserted by test against the values in the docs.
 *
 * @module license
 */

/** The licence on the data itself. */
export const DATA_LICENSE = {
  name: 'ODbL 1.0',
  attribution: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright',
} as const;

/** The upstream mirror the extracts come from; required attribution on any page showing the data. */
export const DATA_SOURCE = {
  name: 'Geofabrik GmbH',
  url: 'https://download.geofabrik.de',
} as const;

/** Shape of the `license` object in public API responses. */
export interface LicenseInfo {
  name: string;
  attribution: string;
  url: string;
  /** Present where the upstream source is named (country detail), absent in list responses. */
  source?: string;
  sourceUrl?: string;
}

/**
 * The `license` block for list responses: licence + attribution, no upstream source.
 *
 * @returns A fresh object, so a caller mutating it cannot corrupt the constant.
 */
export function listLicense(): LicenseInfo {
  return { ...DATA_LICENSE };
}

/**
 * The `license` block for detail responses, which also names Geofabrik.
 *
 * @returns A fresh object including the source fields.
 */
export function detailLicense(): LicenseInfo {
  return { ...DATA_LICENSE, source: DATA_SOURCE.name, sourceUrl: DATA_SOURCE.url };
}

/**
 * The attribution line rendered in the UI footer and on every page that shows data.
 *
 * @returns A human-readable one-liner.
 */
export function attributionLine(): string {
  return `${DATA_LICENSE.attribution} — data ${DATA_LICENSE.name}, via ${DATA_SOURCE.name}`;
}
