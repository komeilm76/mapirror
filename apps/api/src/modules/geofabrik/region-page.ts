/**
 * Extracts source snapshots and freshness metadata from a Geofabrik region page (`P2-SRC-03`).
 *
 * The HTML is an upstream boundary, so it is parsed with an HTML5 parser rather than regular expressions over tags.
 * Only dated `.osm.pbf` links in table rows are snapshots; subregion links and the moving `latest` link are not
 * mistaken for dated versions. Human-readable file sizes are converted to byte estimates, while absent page data is
 * represented as `null` rather than guessed.
 *
 * @module modules/geofabrik/region-page
 */

import { parse, type DefaultTreeAdapterTypes } from 'parse5';

import type { SourceSnapshot } from './source';

/** A parsed region page's source facts. */
export interface ParsedGeofabrikRegionPage {
  /** Page-level OSM freshness timestamp (“data up to”), when the page states one. */
  readonly dataTimestamp: Date | null;
  /** Dated PBF snapshots, newest first. */
  readonly snapshots: SourceSnapshot[];
}

/** The HTML node type from parse5's default adapter. */
type HtmlNode = DefaultTreeAdapterTypes.Node;

/** The HTML element type from parse5's default adapter. */
type HtmlElement = DefaultTreeAdapterTypes.Element;

/** Dated PBF names offered in region history tables use a six-digit YYMMDD version. */
const DATED_PBF_FILENAME = /-(\d{6})\.osm\.pbf$/iu;

/** Numeric size with an explicit byte unit, e.g. `773.5 MB` or `742 MiB`. */
const SIZE_WITH_UNIT =
  /^((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)\s*(bytes?|B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/iu;

/** A raw integer byte size may be rendered with comma thousands separators. */
const GROUPED_BYTE_COUNT = /^\d{1,3}(?:,\d{3})+$/u;

/** Multipliers for decimal and binary byte units. */
const BYTE_UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1_024,
  mib: 1_048_576,
  gib: 1_073_741_824,
  tib: 1_099_511_627_776,
};

/** Whether a parse5 node is an element (and therefore has a tag name and attributes). */
function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

/** All descendant elements of a node, including the node itself when it is an element. */
function descendants(root: HtmlNode): HtmlElement[] {
  const found: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (isElement(node)) found.push(node);
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(root);
  return found;
}

/** Text content of one node and its descendants, with whitespace collapsed. */
function textContent(node: HtmlNode): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if (!('childNodes' in node)) return '';
  return node.childNodes.map(textContent).join(' ');
}

/** Direct child cells of a table row, preserving their column order. */
function rowCells(row: HtmlElement): HtmlElement[] {
  return row.childNodes.filter(
    (node): node is HtmlElement =>
      isElement(node) && (node.tagName === 'td' || node.tagName === 'th'),
  );
}

/** Attribute lookup; parse5 retains source attribute names in lower case for HTML. */
function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((item) => item.name === name)?.value;
}

/**
 * Converts a Geofabrik page's displayed size into bytes.
 *
 * Decimal units use SI multipliers, binary units use powers of 1024, and a comma-grouped bare number is interpreted as
 * bytes. Unlabelled short numbers are not sizes — they are commonly snapshot ids and dates.
 *
 * @param value - Text from a file-size cell.
 * @returns Rounded byte count, or `null` when the cell is not a supported size.
 */
export function parseDisplayedSize(value: string): number | null {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  const withUnit = SIZE_WITH_UNIT.exec(normalized);
  let bytes: number;

  if (withUnit !== null) {
    const amountText = withUnit[1];
    const unit = withUnit[2]?.toLowerCase();
    if (amountText === undefined || unit === undefined) return null;
    const amount = Number(amountText.replaceAll(',', ''));
    const multiplier = BYTE_UNIT_MULTIPLIERS[unit];
    if (!Number.isFinite(amount) || multiplier === undefined) return null;
    bytes = Math.round(amount * multiplier);
  } else if (GROUPED_BYTE_COUNT.test(normalized)) {
    bytes = Number(normalized.replaceAll(',', ''));
  } else if (/^\d{8,}$/u.test(normalized)) {
    bytes = Number(normalized);
  } else {
    return null;
  }

  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

/**
 * Parses the page's “data up to” statement into a UTC instant.
 *
 * Upstream pages commonly render `YYYY-MM-DD HH:mm UTC`; when a valid date/time has no explicit zone, UTC is applied
 * because Geofabrik timestamps describe UTC extract builds.
 *
 * @param text - Visible page or row text.
 * @returns Parsed instant, or `null` if no supported statement is present.
 */
function dataTimestampFromText(text: string): Date | null {
  const match =
    /(?:data\s+up\s+to|contains\s+data\s+up\s+to|updated\s+(?:until|up\s+to))\s*[:–—]?\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?(?:\s*(?:UTC|GMT|Z|[+-]\d{2}:?\d{2}))?)/iu.exec(
      text.replace(/\s+/gu, ' '),
    );
  const captured = match?.[1];
  if (captured === undefined) return null;

  let normalized = captured.trim().replace(/\s+(UTC|GMT)$/iu, 'Z');
  normalized = normalized.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/u, '$1T$2');
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(normalized)) normalized += 'Z';

  const dateParts = /^(\d{4})-(\d{2})-(\d{2})/u.exec(normalized);
  const year = Number(dateParts?.[1]);
  const month = Number(dateParts?.[2]);
  const day = Number(dateParts?.[3]);
  if (dateParts === null || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return null;
  }

  const timeParts = /T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?/u.exec(normalized);
  if (
    timeParts !== null &&
    (Number(timeParts[1]) > 23 || Number(timeParts[2]) > 59 || Number(timeParts[3] ?? 0) > 59)
  ) {
    return null;
  }

  const instant = new Date(normalized);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** Basename of a source link, without query or fragment. */
function basename(href: string): string {
  const path = href.split(/[?#]/u, 1)[0] ?? '';
  const last = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Parent table for a row, used to identify a size column from its header. */
function closestTable(row: HtmlElement): HtmlElement | null {
  let parent = row.parentNode;
  while (parent !== null) {
    if ('tagName' in parent && parent.tagName === 'table') return parent;
    parent = 'parentNode' in parent ? parent.parentNode : null;
  }
  return null;
}

/** Finds the zero-based `Size`/`File size` column in a table, if it has a header row. */
function sizeColumnIndex(table: HtmlElement): number | null {
  for (const row of descendants(table).filter((element) => element.tagName === 'tr')) {
    const cells = rowCells(row);
    const index = cells.findIndex((cell) => /\b(?:file\s+)?size\b|bytes/iu.test(textContent(cell)));
    if (index !== -1 && cells.some((cell) => cell.tagName === 'th')) return index;
  }
  return null;
}

/** Size for one row, preferring the documented size column over other numeric cell text. */
function rowSizeBytes(row: HtmlElement): number | null {
  const cells = rowCells(row);
  const table = closestTable(row);
  const index = table === null ? null : sizeColumnIndex(table);
  if (index !== null) {
    const size = cells[index];
    return size === undefined ? null : parseDisplayedSize(textContent(size));
  }

  // Some upstream layouts omit a `<thead>`; a size unit is still unambiguous in a data cell.
  for (const cell of cells) {
    const parsed = parseDisplayedSize(textContent(cell));
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Parses a Geofabrik region page into its dated snapshots and current data timestamp.
 *
 * Rows with only a subregion `.html` link or a moving `latest` PBF link are ignored. Snapshot ids are taken from the
 * dated PBF filename, deduplicated, and sorted descending. The page-level “data up to” value belongs to the newest
 * dated snapshot only; older rows remain `null` unless they carry their own such statement.
 *
 * @param html - Raw HTML received for one region page.
 * @returns Snapshot metadata and page-level freshness, with unknown values represented as `null`.
 */
export function parseGeofabrikRegionPage(html: string): ParsedGeofabrikRegionPage {
  const document = parse(html);
  const pageText = textContent(document).replace(/\s+/gu, ' ').trim();
  const dataTimestamp = dataTimestampFromText(pageText);
  const byVersion = new Map<string, SourceSnapshot>();

  for (const row of descendants(document).filter((element) => element.tagName === 'tr')) {
    const links = descendants(row).filter((element) => element.tagName === 'a');
    const matching = links
      .map((link) => attribute(link, 'href'))
      .filter((href): href is string => href !== undefined)
      .map((href) => ({ href, match: DATED_PBF_FILENAME.exec(basename(href)) }))
      .find(({ match }) => match !== null);
    const version = matching?.match?.[1];
    if (version === undefined) continue;

    const rowTimestamp = dataTimestampFromText(textContent(row));
    byVersion.set(version, {
      version,
      dataTimestamp: rowTimestamp,
      sizeBytes: rowSizeBytes(row),
      checksumMd5: null,
    });
  }

  const snapshots = [...byVersion.values()].sort((left, right) =>
    right.version.localeCompare(left.version),
  );
  const newest = snapshots[0];
  if (newest !== undefined && newest.dataTimestamp === null && dataTimestamp !== null) {
    snapshots[0] = { ...newest, dataTimestamp };
  }

  return { dataTimestamp, snapshots };
}
