/**
 * What a route in this app must carry (`P1-WEB-03`).
 *
 * Vue Router lets a route's `meta` be any object, which is why a route can reach production with no title and no
 * record of which screen it is. Declaring the three fields **required** turns that into a typecheck failure at the
 * point the route is written:
 *
 * - `title` — the browser tab (`router/titles.ts`) and the page heading;
 * - `screen` — the row of `13-ui-ux.md` §4 this route implements, so the law test can compare the two tables;
 * - `owner` — the task in `08-tasks.md` that builds the real thing, which is what every placeholder page displays.
 *
 * `placeholder` is optional and marks the routes whose component is still `PlaceholderPage`.
 *
 * Augmenting `RouteMeta` rather than defining a new interface is what makes `to.meta.title` typed everywhere — in the
 * router, in guards, in components — with no cast.
 *
 * @module types/vue-router
 */

import 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    /** Page title without the product suffix, e.g. `Cache`. */
    readonly title: string;
    /** The `13-ui-ux.md` §4 screen this route is, e.g. `S7`. */
    readonly screen: string;
    /** The `08-tasks.md` task that builds this screen, e.g. `P2-WEB-03`. */
    readonly owner: string;
    /** `true` while the route renders `PlaceholderPage`. */
    readonly placeholder?: boolean;
    /** A data-loaded child label for breadcrumbs, e.g. the country name returned by S8. */
    readonly breadcrumbLabel?: string;
  }
}
