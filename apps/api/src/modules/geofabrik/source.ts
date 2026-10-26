/**
 * Thin contract for the configured map-data source (`P2-SRC-01`, D-1 / ADR-002).
 *
 * The product currently has one implementation, Geofabrik. This interface contains only the four source operations
 * the catalog, snapshot picker and download worker need; it deliberately does not add a provider registry, lifecycle
 * hooks, generic transport layer or plugin mechanism. A later provider can implement this contract when there is a
 * concrete need for one.
 *
 * All identifiers are source identifiers (for example `europe/finland`), never local catalog slugs. Dates are parsed
 * instants, and byte sizes are non-negative safe integers when known; unavailable upstream metadata is `null` rather
 * than a guessed value.
 *
 * @module modules/geofabrik/source
 */

/** One region in the upstream source index. */
export interface SourceRegion {
  /** Upstream identifier, such as `europe/finland`. */
  readonly id: string;
  /** Upstream parent identifier, or `null` for a top-level region. */
  readonly parentId: string | null;
  /** Human-readable region name from the source. */
  readonly name: string;
  /** ISO 3166-1 alpha-2 codes, when the source provides them. */
  readonly isoAlpha2: readonly string[];
  /** Other ISO codes (for example ISO 3166-2), when provided. */
  readonly isoOther: readonly string[];
  /** Source PBF URL, or `null` when the index has no extract for this region. */
  readonly pbfUrl: string | null;
}

/** Current source identity and available metadata for one region's extract. */
export interface SourceRegionDetail {
  /** Current offered source version identifier, commonly a dated snapshot such as `261024`. */
  readonly version: string;
  /** OSM data freshness timestamp (“data up to”), or `null` when the page does not state one. */
  readonly dataTimestamp: Date | null;
  /** Extract length in bytes, or `null` until known from source metadata. */
  readonly sizeBytes: number | null;
  /** Upstream entity tag, preserved as received, or `null` when unavailable. */
  readonly etag: string | null;
  /** Upstream last-modified instant, or `null` when unavailable. */
  readonly lastModified: Date | null;
}

/** One dated version offered by the source for a region. */
export interface SourceSnapshot {
  /** Stable source version identifier, such as `261023`. */
  readonly version: string;
  /** OSM data freshness timestamp (“data up to”), or `null` when unavailable. */
  readonly dataTimestamp: Date | null;
  /** Extract length in bytes, or `null` until obtained from source metadata. */
  readonly sizeBytes: number | null;
  /** MD5 advertised by the source, or `null` when it has not been fetched or is unavailable. */
  readonly checksumMd5: string | null;
}

/** A download location resolved for a region and requested source version. */
export interface ResolvedDownload {
  /** Resolved dated version; `null` only when the source cannot identify the moving `latest` alias. */
  readonly version: string | null;
  /** Absolute source URL to stream. */
  readonly url: string;
  /** Content length in bytes, or `null` when the source did not provide it. */
  readonly sizeBytes: number | null;
  /** OSM data freshness timestamp, or `null` when unavailable. */
  readonly dataTimestamp: Date | null;
  /** MD5 advertised by the source, or `null` when unavailable. */
  readonly checksumMd5: string | null;
  /** Upstream entity tag, preserved as received, or `null` when unavailable. */
  readonly etag: string | null;
  /** Upstream last-modified instant, or `null` when unavailable. */
  readonly lastModified: Date | null;
}

/** A map data provider. Only the four operations the product needs. */
export interface MapSource {
  /** Provider identifier persisted with catalog rows. */
  readonly id: 'geofabrik';

  /**
   * Lists the regions in the upstream catalog index.
   *
   * @returns The parsed catalog records; performs no database or filesystem writes.
   */
  listRegions(): Promise<SourceRegion[]>;

  /**
   * Reads the current detail page and source identity for one region.
   *
   * @param regionId - Raw upstream region identifier, not a local slug.
   * @returns Current version and available freshness/HTTP metadata.
   */
  getRegionDetail(regionId: string): Promise<SourceRegionDetail>;

  /**
   * Lists the dated source snapshots currently offered for one region.
   *
   * @param regionId - Raw upstream region identifier, not a local slug.
   * @returns Available source versions, newest first.
   */
  listSnapshots(regionId: string): Promise<SourceSnapshot[]>;

  /**
   * Resolves a requested version to its PBF download URL and available metadata.
   *
   * @param regionId - Raw upstream region identifier, not a local slug.
   * @param version - A dated source version or the moving `latest` alias.
   * @returns The resolved URL and metadata; never downloads or stores the artifact itself.
   */
  resolveDownload(regionId: string, version: string): Promise<ResolvedDownload>;
}
