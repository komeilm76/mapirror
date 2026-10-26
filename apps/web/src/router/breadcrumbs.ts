/**
 * Breadcrumbs, as a function of the path (`P1-WEB-07`).
 *
 * `13-ui-ux.md` §3 puts breadcrumbs in the admin topbar — "Dashboard › Cache" — and §7 asks for landmark regions and one
 * `h1` per page, which is why the topbar carries the trail and the *page* carries the title: two headings for the same
 * screen is the most common way an admin panel ends up with an ambiguous document outline.
 *
 * ## Where the trail comes from
 *
 * The sidebar (`router/nav.ts`) — not from each route's own meta. A screen's place in the hierarchy is the same fact in
 * both places, and deriving the trail from the navigation means the two cannot disagree: if `Cache` is under `Dashboard`
 * in the sidebar, it is under it in the trail. The tail — the part below a sidebar entry, e.g. the country in
 * `/_site/admin/cache/finland` — comes from the URL, because that is what a reader can check against the address bar.
 *
 * ## The last crumb is not a link
 *
 * A link to the page you are on is a control that reloads the screen without saying so, and screen readers announce the
 * last item with `aria-current="page"` (the layout does that, from this list's shape: every crumb but the last has a
 * `to`).
 *
 * @module router/breadcrumbs
 */

import { ADMIN_ROOT } from './paths';
import { navItemFor } from './nav';

/** One step in the trail. */
export interface Crumb {
  /** What the reader sees. */
  readonly label: string;
  /** Where it goes, or `null` for the page that is already open. */
  readonly to: string | null;
}

/**
 * What this module needs from a route.
 *
 * Narrower than `RouteLocationNormalizedLoaded` on purpose: the layout passes the real route (which satisfies this), and
 * a test passes a literal.
 */
export interface CrumbRoute {
  /** `route.path`, without a query string. */
  readonly path: string;
  /** `route.meta`, whose `title` every route in this app carries (`types/vue-router.d.ts`). */
  readonly meta: { readonly title: string };
}

/** The admin root as the sidebar spells it, and as a browser may spell it. */
const DASHBOARD_PATHS = new Set([ADMIN_ROOT, `${ADMIN_ROOT}/`]);

/**
 * Decodes one path segment without ever throwing.
 *
 * A `%` that is not an escape (a hand-typed URL, a proxy that re-encoded) makes `decodeURIComponent` throw, and a
 * breadcrumb is not a place to fail a render: the raw segment is what the reader typed, which is the honest fallback.
 *
 * @param segment - One URL path segment.
 * @returns The decoded segment, or the input when it is not decodable.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Builds the trail for a route.
 *
 * @param route - The current route.
 * @returns The trail, oldest first. Empty for a path that is not in the admin area — the public shell has its own
 * header (`P3-WEB-01`), and a trail that invents a parent for it would be wrong there.
 */
export function breadcrumbsFor(route: CrumbRoute): Crumb[] {
  const path = route.path;

  if (!DASHBOARD_PATHS.has(path) && !path.startsWith(`${ADMIN_ROOT}/`)) return [];

  const onDashboard = DASHBOARD_PATHS.has(path);
  const crumbs: Crumb[] = [{ label: 'Dashboard', to: onDashboard ? null : `${ADMIN_ROOT}/` }];
  if (onDashboard) return crumbs;

  const item = navItemFor(path);
  if (item === undefined) {
    // An admin path with no sidebar entry — today that is the not-found page at an admin URL (`/_site/admin/nope` renders
    // S15 inside the shell, so the reader keeps the navigation and can see that the URL was wrong). The route's own title
    // is the only fact available.
    //
    // There is deliberately no `item.screen === 'S5'` branch below this: the Dashboard entry matches the admin root
    // **exactly** (`router/nav.ts`), so `navItemFor` can never return it for a deeper path, and the case that would have
    // needed the branch is the one above. The first version of this function had that branch; coverage said it could not
    // run, which is how it was found (pass 36).
    crumbs.push({ label: route.meta.title, to: null });
    return crumbs;
  }

  const deeper = path.slice(item.path.length).replace(/^\//u, '');
  crumbs.push({ label: item.label, to: deeper === '' ? null : item.path });

  if (deeper !== '') {
    // The tail is the URL's own last segment(s), decoded. A country's display name arrives with the API (`P2-WEB-04`),
    // and until then the slug in the address bar is the one label a reader can verify.
    crumbs.push({ label: decodeSegment(deeper), to: null });
  }

  return crumbs;
}
