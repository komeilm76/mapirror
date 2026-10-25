/**
 * The document title, per route (`P1-WEB-03`).
 *
 * `13-ui-ux.md` §9 asks for copy that says where you are, and the tab is the first place a user looks for it: fifteen
 * pages all titled "MapMirror" is a browser full of identical tabs. Each route carries a `title` in its `meta` (the
 * `RouteMeta` augmentation in `src/types/vue-router.d.ts` makes it required, so a new route cannot omit it), and this
 * sets it after every navigation.
 *
 * `document.title` is written through a narrow interface rather than read from the global: jsdom's title is shared by
 * every test in a file, and a test that runs before another's navigation would otherwise assert on the wrong string.
 *
 * @module router/titles
 */

import type { Router } from 'vue-router';

/** The suffix every title carries. The product name, not the branding setting — that arrives with the settings API. */
export const TITLE_SUFFIX = 'MapMirror';

/**
 * Builds the title for a route name.
 *
 * @param routeTitle - The route's own title, from `meta.title`.
 * @returns `"Cache · MapMirror"`.
 */
export function pageTitle(routeTitle: string): string {
  return `${routeTitle} · ${TITLE_SUFFIX}`;
}

/**
 * Follows the router, writing `document.title` after each navigation.
 *
 * @param router - The app's router.
 * @param target - Where to write; defaults to the real document.
 * @returns A function that stops following the router.
 */
export function installRouteTitles(
  router: Router,
  target: { title: string } = document,
): () => void {
  const apply = (title: string | undefined): void => {
    // A route without a title is a route without a `meta` entry; the augmentation makes that a type error, and the law
    // test asserts it for every registered route, so the fallback exists only so an un-navigated router or a
    // redirect-only record (which never becomes current) cannot produce `"undefined"`.
    //
    // The fallback is the suffix alone, **not** `pageTitle(TITLE_SUFFIX)`: the first version of this line read
    // `pageTitle(title ?? TITLE_SUFFIX)` and rendered the tab as "MapMirror · MapMirror", which is the kind of thing
    // only a test that reaches the branch can see — and `tests/titles.spec.ts` does.
    target.title = title === undefined ? TITLE_SUFFIX : pageTitle(title);
  };

  apply(router.currentRoute.value.meta.title);
  return router.afterEach((to) => {
    apply(to.meta.title);
  });
}
