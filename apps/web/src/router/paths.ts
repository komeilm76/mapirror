/**
 * Router path builders for the SPA.
 *
 * Every page the Vue router serves is built here, from the prefixes in `@mapirror/shared`, so the law
 * test (`apps/web/tests/law-router.spec.ts`) can walk the table and assert `isLegalPath` for each one
 * without hard-coding strings on either side. The login page is the only exception to `/_site/*` (D-19),
 * and it is not built here — it is the single literal imported straight from shared.
 *
 * @module router/paths
 */

import { LOGIN_PAGE_PATH, ROUTE_PREFIXES } from '@mapirror/shared';

/** `/_site/` — the public home. `GET /` redirects here. */
export const SITE_ROOT = `${ROUTE_PREFIXES.site}/`;

/** `/_auth/login` — the only page outside `/_site` (D-19). */
export const LOGIN_PAGE = LOGIN_PAGE_PATH;

/** `/_site/admin` — root of the admin panel shell. */
export const ADMIN_ROOT = `${ROUTE_PREFIXES.site}/admin`;

/** Public pages, as path builders. Slugs are validated by the API; the router only builds the URL. */
export const pagePaths = {
  home: () => SITE_ROOT,
  countries: () => `${ROUTE_PREFIXES.site}/countries`,
  country: (slug: string) => `${ROUTE_PREFIXES.site}/countries/${encodeURIComponent(slug)}`,
  apiDocs: () => `${ROUTE_PREFIXES.site}/api-docs`,
  notFound: () => `${ROUTE_PREFIXES.site}/not-found`,
} as const;

/** Admin pages, all children of {@link ADMIN_ROOT}. */
export const adminPagePaths = {
  dashboard: () => `${ADMIN_ROOT}/`,
  catalog: () => `${ADMIN_ROOT}/catalog`,
  cache: () => `${ADMIN_ROOT}/cache`,
  cacheCountry: (countryId: string) => `${ADMIN_ROOT}/cache/${encodeURIComponent(countryId)}`,
  intervals: () => `${ADMIN_ROOT}/intervals`,
  import: () => `${ADMIN_ROOT}/import`,
  jobs: () => `${ADMIN_ROOT}/jobs`,
  system: () => `${ADMIN_ROOT}/system`,
  settings: () => `${ADMIN_ROOT}/settings`,
  audit: () => `${ADMIN_ROOT}/audit`,
} as const;
