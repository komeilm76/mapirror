/**
 * The SPA's router (`P1-WEB-01`).
 *
 * **Two routes, on purpose.** The full tree — the public pages, the admin shell and its ten children, the login page
 * and the guards that decide who may see them — is `P1-WEB-03`. What this module has to prove now is that the wiring
 * boots: the history mode resolves a real URL, the `/` redirect lands where L1 says the site begins, and an SFC
 * reaches the screen through `App.vue`'s `router-view`.
 *
 * The one structural decision made here is the one every later route inherits: **`createWebHistory()` with no base**,
 * so the SPA's paths are the browser's paths. The alternative — hash routing — would put `#/_site/` in the address
 * bar and make every deep link unshareable, which is the opposite of what `P3-WEB-03`'s copyable `curl` snippets are
 * for. It also means nginx has to answer unknown paths with `index.html` (`P1-DOCK-03`), and that requirement is
 * stated in `12-deployment.md` rather than discovered in production.
 *
 * @module router/index
 */

import { createRouter, createWebHistory, type Router } from 'vue-router';

import HomePage from '@/pages/public/HomePage.vue';
import { SITE_ROOT } from './paths';

/**
 * Builds the router.
 *
 * A factory, not a singleton: `vue-router` holds the current location in the instance, so a module-level router
 * would make every test start wherever the previous one navigated to.
 *
 * @returns A fresh router, ready for `app.use(...)`.
 */
export function createAppRouter(): Router {
  return createRouter({
    history: createWebHistory(),
    routes: [
      // `GET /` is a redirect, not a page (`12-deployment.md` §5: `curl -sI /` expects `302 → /_site/`). Keeping the
      // home page at exactly one URL means a shared link and the canonical one are the same string.
      { path: '/', redirect: SITE_ROOT },
      { path: SITE_ROOT, name: 'home', component: HomePage },
    ],
    scrollBehavior: () => ({ left: 0, top: 0 }),
  });
}
