/**
 * The Vuetify instance the SPA boots with (`P1-WEB-01`).
 *
 * A **factory**, not a module-level singleton: the component tests mount the app more than once per file, and a
 * shared Vuetify instance would carry the previous case's theme and its registered components into the next one.
 * `main.ts` calls it once; a test calls it per mount.
 *
 * ## What is deliberately absent
 *
 * The two themes of `13-ui-ux.md` §2 — light for the public site, dark for the admin panel — and the typography
 * scale are `P1-WEB-02`'s deliverable, together with the rule that no component may hold a hex colour. This module
 * therefore sets defaults only, and the boot is what it proves: Vue + Vuetify compile, the CSS loads, and the
 * `v-app` wrapper of `App.vue` renders. Nothing here is a design decision, so nothing here has to be undone.
 *
 * No `import 'vuetify/styles'` here on purpose: with `vite-plugin-vuetify` (`../vite.config.ts`) Vuetify's CSS arrives
 * with the components that need it, and importing the stylesheet as well would ship the whole framework's CSS twice.
 *
 * @module plugins/vuetify
 */

import { createVuetify } from 'vuetify';

/**
 * What `createVuetify` returns.
 *
 * Derived rather than imported: Vuetify 3.13 exports no `Vuetify` type (checked in `lib/framework.d.ts`), and
 * `ReturnType` cannot drift from the factory it describes.
 */
export type AppVuetify = ReturnType<typeof createVuetify>;

/**
 * Builds a Vuetify instance.
 *
 * @returns A fresh Vuetify plugin, ready for `app.use(...)`.
 */
export function createAppVuetify(): AppVuetify {
  return createVuetify({
    defaults: {
      // Vuetify's defaults put a ripple on every button; on a data-dense admin panel that reads as flicker. Off for
      // now so the first components are authored without it and a later opt-in is a deliberate change.
      VBtn: { ripple: false },
    },
  });
}
