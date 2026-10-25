/**
 * The SPA's router (`P1-WEB-01`, full tree from `P1-WEB-03`).
 *
 * Twelve lines of assembly over three modules that each own one idea:
 *
 * - `routes.ts` — the table, as data, with the screen and owner of each route;
 * - `guards.ts` — the one rule that decides whether a navigation may proceed (admin paths need a session);
 * - `titles.ts` — the browser tab, from `meta.title`.
 *
 * ## History mode, and what it costs
 *
 * `createWebHistory()` with no base, so the SPA's paths are the browser's paths. The alternative — hash routing — would
 * put `#/_site/` in the address bar and make every deep link unshareable, which is the opposite of what `P3-WEB-03`'s
 * copyable `curl` snippets are for. The cost is that nginx must answer unknown paths with `index.html` (`P1-DOCK-03`),
 * and that requirement is stated in `12-deployment.md` rather than discovered in production.
 *
 * @module router/index
 */

import { createRouter, createWebHistory, type Router } from 'vue-router';

import { installAuthGuard } from './guards';
import { APP_ROUTES } from './routes';
import { installRouteTitles } from './titles';

/**
 * Builds the router.
 *
 * A factory, not a singleton: `vue-router` holds the current location in the instance, so a module-level router would
 * make every test start wherever the previous one navigated to.
 *
 * The guard and the title writer are installed here rather than by the caller for one reason: a router that can be
 * built without its guard is a router that can be shipped without its guard. `bootstrap.ts` only has to `app.use()` it.
 *
 * @returns A fresh router, ready for `app.use(...)`.
 */
export function createAppRouter(): Router {
  const router = createRouter({
    history: createWebHistory(),
    routes: [...APP_ROUTES],
    // Back and forward return to where the reader was; a fresh navigation starts at the top. The reduced-motion
    // preference is honoured by `tokens.css` zeroing the motion tokens — the browser's own scroll animation is
    // suppressed there too.
    scrollBehavior: (_to, _from, savedPosition) => savedPosition ?? { left: 0, top: 0 },
  });

  installAuthGuard(router);
  installRouteTitles(router);

  return router;
}
