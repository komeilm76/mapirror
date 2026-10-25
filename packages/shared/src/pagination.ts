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
 * Converts one raw query value into a bounded positive integer.
 *
 * @param raw - Query value (`string`, number, or `undefined`).
 * @param fallback - Value used when the input is absent or not a finite number.
 * @param min - Smallest legal value.
 * @param max - Largest legal value.
 * @returns The clamped integer.
 */
function bound(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
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
  return { page, limit, offset: (page - 1) * limit };
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
  return {
    page,
    limit,
    total: safeTotal,
    // 0 rows means 0 pages, not 1: the UI shows "no results", never "page 1 of 1" over an empty table.
    totalPages: safeTotal === 0 ? 0 : Math.ceil(safeTotal / limit),
  };
}
