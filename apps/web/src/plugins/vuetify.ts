/**
 * The Vuetify instance the SPA boots with (`P1-WEB-01`, themes from `P1-WEB-02`).
 *
 * A **factory**, not a module-level singleton: the component tests mount the app more than once per file, and a
 * shared Vuetify instance would carry the previous case's theme and its registered components into the next one.
 * `main.ts` calls it once; a test calls it per mount.
 *
 * The two themes are built from `styles/tokens.ts`, which is the single implementation of `13-ui-ux.md` §2. Nothing
 * in this file holds a colour: a hex here would be a second place to change when the palette moves, and the test that
 * scans the source for hexes would fail — which is the point.
 *
 * @module plugins/vuetify
 */

import { createVuetify } from 'vuetify';

import { MOBILE_BREAKPOINT } from '@/layouts/adminShell';
import {
  DARK_PALETTE,
  DARK_THEME_NAME,
  LIGHT_PALETTE,
  LIGHT_THEME_NAME,
  themeFrom,
} from '@/styles/tokens';

/**
 * What `createVuetify` returns.
 *
 * Derived rather than imported: Vuetify 3.13 exports no `Vuetify` type (checked in `lib/framework.d.ts`), and
 * `ReturnType` cannot drift from the factory it describes.
 */
export type AppVuetify = ReturnType<typeof createVuetify>;

/**
 * Builds a Vuetify instance with both themes registered.
 *
 * `defaultTheme` is the **light** theme: the public catalog is the site the public arrives at, and the admin panel
 * switches to dark by route (`theme/policy.ts`). A dark default would mean every visitor's first paint is the wrong
 * one.
 *
 * @returns A fresh Vuetify plugin, ready for `app.use(...)`.
 */
export function createAppVuetify(): AppVuetify {
  return createVuetify({
    // `13-ui-ux.md` §3 puts the sidebar's temporary-drawer boundary at 1024 px. Vuetify's default is 1280, which would
    // call a 1100 px laptop a phone — and the drawer, the topbar and any screen that asks `useDisplay()` would all be
    // answering a question the document never asked. One number, in `layouts/adminShell.ts`, used by both.
    display: { mobileBreakpoint: MOBILE_BREAKPOINT },
    icons: { defaultSet: 'mdi' },
    theme: {
      defaultTheme: LIGHT_THEME_NAME,
      themes: {
        [LIGHT_THEME_NAME]: themeFrom(LIGHT_PALETTE, false),
        [DARK_THEME_NAME]: themeFrom(DARK_PALETTE, true),
      },
    },
    defaults: {
      // Vuetify's defaults put a ripple on every button; on a data-dense admin panel that reads as flicker. Off for
      // now so the first components are authored without it and a later opt-in is a deliberate change.
      VBtn: { ripple: false },
      // §2: overlays are the only thing that gets a shadow, and it is the token's, not Vuetify's elevation ramp.
      VMenu: { elevation: 0 },
      VDialog: { elevation: 0 },
    },
  });
}
