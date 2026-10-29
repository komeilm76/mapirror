/**
 * Which theme a page wears (`P1-WEB-02`).
 *
 * `13-ui-ux.md` §1 gives three areas three answers, and the third is the one that needs a rule rather than a constant:
 *
 * | Area | Theme |
 * |---|---|
 * | Admin (`/_site/admin…`) | dark, always — a control room at 02:00 is not a place for a white page |
 * | Public (`/_site/…`) | light by default, with a per-visitor override (`P3-WEB-01`) |
 * | Auth (`/_auth/login`) | follows the operating system |
 *
 * The mapping is a **function of the path**, not a flag set by each page: a page that forgets to set a theme would be
 * the one nobody notices until a screenshot in review, and the app has fourteen of them. `installThemeSync` applies it
 * after every navigation, so a deep link, a back button and an in-app click all land on the same answer.
 *
 * ## Why "follows the system" is not a third theme
 *
 * Vuetify can be told `name = 'system'`, but that names a *mode*, not a palette, and this app has exactly two
 * palettes. Reading `prefersDark` and choosing between them keeps the decision in one place and makes it testable
 * with a plain `ref(false)` instead of a jsdom media-query stub.
 *
 * @module theme/policy
 */

import { usePreferredDark } from '@vueuse/core';
import { watch, type Ref } from 'vue';
import type { Router } from 'vue-router';

import type { AppVuetify } from '@/plugins/vuetify';
import { ADMIN_ROOT, LOGIN_PAGE } from '@/router/paths';
import { DARK_THEME_NAME, LIGHT_THEME_NAME } from '@/styles/tokens';

/** A theme name Vuetify knows. */
export type ThemeName = typeof LIGHT_THEME_NAME | typeof DARK_THEME_NAME;

/** The three areas of the app that get a theme of their own. */
export type Area = 'admin' | 'auth' | 'public';

/**
 * Classifies a path into one of the three areas.
 *
 * Segment-boundary aware on purpose: `/_site/administrators` is a public page whose slug happens to start with
 * "admin", and a `startsWith('/_site/admin')` test would paint it dark. The same mistake in the API's prefix law was
 * made and fixed in `P1-REPO-07`, which is why `isPathUnder` exists in `@mapirror/shared`.
 *
 * @param path - The route path, with or without a query string.
 * @returns The area the path belongs to.
 */
export function areaForPath(path: string): Area {
  const clean = path.split(/[?#]/u)[0] ?? '';
  if (clean === LOGIN_PAGE) return 'auth';
  if (clean === ADMIN_ROOT || clean.startsWith(`${ADMIN_ROOT}/`)) return 'admin';
  return 'public';
}

/**
 * The theme a path wears.
 *
 * @param path - The route path.
 * @param options - `prefersDark` decides the auth area; it is the system preference, injected so a test needs no
 * media-query stub.
 * @returns `dark` or `light`.
 */
export function themeForPath(path: string, options: { readonly prefersDark: boolean }): ThemeName {
  switch (areaForPath(path)) {
    case 'admin':
      return DARK_THEME_NAME;
    case 'auth':
      return options.prefersDark ? DARK_THEME_NAME : LIGHT_THEME_NAME;
    case 'public':
      return LIGHT_THEME_NAME;
  }
}

/** What {@link installThemeSync} needs from the app. */
export interface ThemeSyncOptions {
  /** The system preference; defaults to VueUse's live media query. */
  readonly prefersDark?: Ref<boolean>;
}

/**
 * Keeps the active theme in step with the route — and with the operating system, while an auth page is on screen.
 *
 * Called once by `bootstrap.ts`. It applies the theme immediately (so the first paint is right, before any
 * navigation) and then after every navigation.
 *
 * @param router - The app's router.
 * @param vuetify - The Vuetify instance whose `theme.global.name` is switched.
 * @param options - Only for tests; production passes nothing.
 * @returns A function that stops the synchronisation, for a test that unmounts and for the app's own teardown.
 */
export function installThemeSync(
  router: Router,
  vuetify: AppVuetify,
  options: ThemeSyncOptions = {},
): () => void {
  const prefersDark = options.prefersDark ?? usePreferredDark();
  const active = () => router.currentRoute.value.path;

  const apply = (path: string): void => {
    vuetify.theme.change(themeForPath(path, { prefersDark: prefersDark.value }));
  };

  // Before the first navigation: `main.ts` mounts immediately, and waiting for `afterEach` would paint one frame in
  // the light theme whatever the route is.
  apply(active());

  // The system preference only matters on the auth area, but watching it unconditionally costs one watcher and
  // removes a class of bug: switching the OS theme while the login page is open must repaint it, and switching it on
  // a public page must not touch anything (`themeForPath` already ignores it there).
  const stopWatching = watch(prefersDark, () => {
    apply(active());
  });

  const removeHook = router.afterEach((to) => {
    apply(to.path);
  });

  return () => {
    stopWatching();
    removeHook();
  };
}
