/**
 * Pagination (D-16, `04-api.md` §0.2).
 *
 * One envelope shape for every list endpoint: `{ data, meta: { page, limit, total, totalPages } }`.
 *
 * **Out-of-range values are clamped, not rejected.** `?limit=100000` is not a client bug worth a 400 —
 * it is a request for more rows than the server will ever send, and the difference between "you asked for
 * 100000 and got 100" and "you asked wrong" is invisible to the caller. Clamping also means a hostile
 * query cannot make the process allocate: the bound is enforced before any SQL is built. Non-numeric
 * values fall back to the defaults for the same reason — a list endpoint that 400s on `?page=abc` breaks
 * links that a crawler or a hand-typed URL produces, and no data is at risk.
 *
 * @module pagination
 */

/** Default page size when `limit` is absent (`04-api.md` §0.2). */
export const DEFAULT_PAGE_SIZE = 25;

/** Hard ceiling for `limit`; larger requests are clamped to this. */
export const MAX_PAGE_SIZE = 100;

/** Default page number; pages are 1-based, because that is what the URL shows and what users report. */
export const DEFAULT_PAGE = 1;

/** The `meta` object returned with every paginated response. */
export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** A paginated response body. `Extra` carries endpoint-specific siblings (e.g. `license`). */
export type Paginated<Item, Extra = Record<string, never>> = {
  data: Item[];
  meta: PageMeta;
} & Extra;

/** Options for {@link parsePagination}. */
export interface PaginationOptions {
  /** Page size used when the request has none. Endpoints may default higher (catalog uses 50). */
  defaultLimit?: number;
  /** Ceiling for this endpoint; never above {@link MAX_PAGE_SIZE}. */
  maxLimit?: number;
}

/**
 * Plain decimal with an optional sign and fraction. Deliberately **not** `Number(raw)`.
 *
 * `Number()` also accepts `0x10`, `1e3`, `Infinity` and `[]`, so `?limit=0x10` would quietly mean 16 and
 * `?page=1e3` 100 — inputs no client sends, interpreted rather than ignored. Only the form a URL is
 * documented to carry is accepted; anything else falls back to the default, which is also what a
 * hand-edited or crawler-generated link deserves.
 */
const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Converts one raw query value into a bounded positive integer.
 *
 * @param raw - Query value (`string`, number, or `undefined`).
 * @param fallback - Value used when the input is absent or not a decimal number.
 * @param min - Smallest legal value.
 * @param max - Largest legal value.
 * @returns The clamped integer.
 */
function bound(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseDecimal(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

/**
 * Reads a finite decimal from a query value.
 *
 * @param raw - Candidate value: a number from internal callers, a string from a query string, or absent.
 * @returns The number, or `NaN` when the input is not a decimal.
 */
function parseDecimal(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : Number.NaN;
  if (typeof raw !== 'string') return Number.NaN;
  const trimmed = raw.trim();
  return DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * Reads `page` and `limit` from a query object, clamping both to their legal ranges.
 *
 * @param query - Raw query values, typically `request.query`.
 * @param options - Per-endpoint defaults and ceiling.
 * @returns The normalised `page`, `limit` and the SQL `offset` they imply.
 */
export function parsePagination(
  query: { page?: unknown; limit?: unknown },
  options: PaginationOptions = {},
): { page: number; limit: number; offset: number } {
  const maxLimit = Math.min(options.maxLimit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const defaultLimit = Math.min(options.defaultLimit ?? DEFAULT_PAGE_SIZE, maxLimit);
  const page = bound(query.page, DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER);
  const limit = bound(query.limit, defaultLimit, 1, maxLimit);
  // `(page - 1) * limit` leaves the safe-integer range long before `page` does: with `limit=100` the
  // product is already inexact at `page ≈ 9e13`, and an inexact float offset is sent to SQL as
  // `900719925474099000` — a number that never equals what the caller asked for. Clamping keeps the
  // bound an integer; such an offset returns an empty page either way, which is the honest answer.
  const offset = Math.min((page - 1) * limit, Number.MAX_SAFE_INTEGER);
  return { page, limit, offset };
}

/**
 * Builds the `meta` block for a page of results.
 *
 * @param page - 1-based page number, as returned by {@link parsePagination}.
 * @param limit - Page size, as returned by {@link parsePagination}.
 * @param total - Total number of matching rows (`COUNT(*)`, not the length of the page).
 * @returns The `meta` object.
 */
export function buildPageMeta(page: number, limit: number, total: number): PageMeta {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  // `limit` normally comes from `parsePagination` and is ≥ 1, but this function is exported and a caller
  // passing 0 divided by zero: `totalPages` became `Infinity`, which `JSON.stringify` turns into `null`,
  // so the contract's integer field would have shipped as `"totalPages": null`.
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_PAGE_SIZE;
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : DEFAULT_PAGE;
  return {
    page: safePage,
    limit: safeLimit,
    total: safeTotal,
    // 0 rows means 0 pages, not 1: the UI shows "no results", never "page 1 of 1" over an empty table.
    totalPages: safeTotal === 0 ? 0 : Math.ceil(safeTotal / safeLimit),
  };
}
