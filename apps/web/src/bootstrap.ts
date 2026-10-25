/**
 * Builds the SPA, without mounting it (`P1-WEB-01`).
 *
 * `main.ts` owns exactly two things: build the app, mount it to `#app`. Everything else is here, because a component
 * test needs the *same* app a browser gets — same plugins, same order — and a test that hand-assembles its own stack
 * proves nothing about the one that ships. This is the seam: one function, called by the entry point and by every
 * mount-based test.
 *
 * Plugin order matters, in the same small way it does for the API's pipeline:
 *
 * 1. **Pinia first.** A store created during another plugin's install, or during a component's setup, must find an
 *    active Pinia; installing it last produces "getActivePinia() was called but there was no active Pinia", which
 *    reads like a bug in the store.
 * 2. **Vuetify before the router.** Route components are rendered after the router is ready, so either order works
 *    today — but a layout that resolves a theme during setup would break if Vuetify came after the router's initial
 *    navigation, and nothing about that failure would point at the order.
 * 3. **Router last**, so the first navigation happens once every provider the pages might reach for is in place.
 * 4. **Theme sync after both**, because it needs the router's current route and Vuetify's theme object; installing it
 *    earlier would leave the first paint in the light theme on an admin deep link (`theme/policy.ts`).
 *
 * @module bootstrap
 */

import { createApp, type App as VueApp } from 'vue';

import App from './App.vue';
import { createAppApiClient, provideApiClient } from './api';
import { createAppPinia } from './plugins/pinia';
import { createAppVuetify } from './plugins/vuetify';
import { createAppRouter } from './router';
import { useNotifications } from './stores/notifications';
import { installThemeSync } from './theme/policy';

/**
 * The element `index.html` provides. Named once, because a typo here is a blank page with no console error.
 */
export const MOUNT_SELECTOR = '#app';

/**
 * Builds the Vue application with every plugin installed, ready to mount.
 *
 * @returns The app instance; the caller mounts it and owns its lifetime.
 */
export function createWebApp(): VueApp<Element> {
  const app = createApp(App);
  const pinia = createAppPinia();
  const vuetify = createAppVuetify();
  const router = createAppRouter();

  app.use(pinia);
  app.use(vuetify);
  app.use(router);

  // The theme follows the route (`P1-WEB-02`): dark for the admin area, light for the public one, the system
  // preference on the login page. One installation, so a page cannot forget.
  installThemeSync(router, vuetify);

  // The API client (`P1-WEB-04`). Provided rather than imported by screens, so a component test hands its own stub to
  // `provideApiClient()` and a store hands its token in — one seam, no module singleton. It is wired after the router
  // because a dead session navigates, and after Pinia because the toast it shows lives in a store.
  provideApiClient(app, createAppApiClient({ router, notifications: useNotifications(pinia) }));

  return app;
}
