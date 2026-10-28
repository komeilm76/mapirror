/**
 * The admin panel's navigation, as data (`P1-WEB-07`).
 *
 * `13-ui-ux.md` §3 draws the sidebar and lists its nine entries; this module is that list, and the layout is a `v-for`
 * over it. Two reasons the list is not written in the template:
 *
 * 1. **It can be checked against the router.** `tests/admin-nav.spec.ts` asserts that every admin screen in §4 (S5–S14)
 *    has exactly one entry, that each entry names a route that exists, and that the two agree about the screen id — so a
 *    screen added to the router cannot quietly miss the sidebar, and a sidebar entry cannot point at a path that 404s.
 * 2. **"Where am I?" is a function of the path**, not of each item's own idea of itself. `isNavItemActive` and
 *    `navItemFor` are the one implementation, and the breadcrumbs (`router/breadcrumbs.ts`) use the same two functions.
 *
 * ## What is deliberately not here
 *
 * **The Jobs dot is data-backed in `AdminLayout.vue`.** The shell polls queued/running totals from the authenticated
 * jobs endpoint and renders a dot only after a validated non-zero count; the navigation data stays declarative and does
 * not carry a second, stale copy of the queue count. The Catalog update counter remains with its owning screen task.
 *
 * **Icons.** The Material Design set is not installed (see `ToastHost.vue` and pass 35): an `icon` here would render an
 * empty element. Entries are labelled text.
 *
 * @module router/nav
 */

import { ADMIN_ROOT, adminPagePaths } from './paths';

/** One entry in the sidebar. */
export interface AdminNavItem {
  /** What the reader sees. */
  readonly label: string;
  /** The route this entry navigates to, by name — so a renamed path does not leave a dead link. */
  readonly name: string;
  /** The route's path, used for the active state and the breadcrumbs. */
  readonly path: string;
  /** The `13-ui-ux.md` §4 screen this entry opens. */
  readonly screen: string;
}

/**
 * The sidebar, in the order §3 draws it.
 *
 * S8 (a cached country) is not an entry: it is reached from S7 and is a child of it, which is why the Cache entry stays
 * highlighted while a country is open.
 */
export const ADMIN_NAV: readonly AdminNavItem[] = [
  {
    label: 'Dashboard',
    name: 'admin-dashboard',
    path: adminPagePaths.dashboard(),
    screen: 'S5',
  },
  { label: 'Catalog', name: 'admin-catalog', path: adminPagePaths.catalog(), screen: 'S6' },
  { label: 'Cache', name: 'admin-cache', path: adminPagePaths.cache(), screen: 'S7' },
  {
    label: 'Intervals',
    name: 'admin-intervals',
    path: adminPagePaths.intervals(),
    screen: 'S9',
  },
  { label: 'Import', name: 'admin-import', path: adminPagePaths.import(), screen: 'S10' },
  { label: 'Jobs', name: 'admin-jobs', path: adminPagePaths.jobs(), screen: 'S11' },
  { label: 'System', name: 'admin-system', path: adminPagePaths.system(), screen: 'S12' },
  { label: 'Settings', name: 'admin-settings', path: adminPagePaths.settings(), screen: 'S13' },
  { label: 'Audit', name: 'admin-audit', path: adminPagePaths.audit(), screen: 'S14' },
] as const;

/** The dashboard's path, which is the admin root with a trailing slash. */
const DASHBOARD_PATH = adminPagePaths.dashboard();

/**
 * Strips a query string and a fragment.
 *
 * @param path - A route path or `fullPath`.
 * @returns The path alone.
 */
function pathOnly(path: string): string {
  const cut = path.search(/[?#]/u);
  return cut === -1 ? path : path.slice(0, cut);
}

/**
 * Whether an entry is the one the reader is on.
 *
 * Segment-aware for the same reason `areaForPath` is (`theme/policy.ts`): `/_site/admin/cache` must not light up for
 * `/_site/admin/calendar`, a path nobody has written yet. The dashboard is matched **exactly**, because every admin path
 * is under `/_site/admin/` and a prefix match would make it permanently active.
 *
 * @param item - The sidebar entry.
 * @param path - The current route path, with or without a query string.
 * @returns `true` when the reader is on this entry's screen or one of its children.
 */
export function isNavItemActive(item: AdminNavItem, path: string): boolean {
  const clean = pathOnly(path);
  if (item.path === DASHBOARD_PATH) return clean === ADMIN_ROOT || clean === DASHBOARD_PATH;
  return clean === item.path || clean.startsWith(`${item.path}/`);
}

/**
 * The entry that owns a path.
 *
 * @param path - The current route path.
 * @returns The entry, or `undefined` for a path outside the admin area.
 */
export function navItemFor(path: string): AdminNavItem | undefined {
  return ADMIN_NAV.find((item) => isNavItemActive(item, path));
}
