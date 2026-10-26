/**
 * The shell's measurements, in one place (`P1-WEB-07`).
 *
 * `13-ui-ux.md` §3 states three numbers — a 248 px sidebar, a 64 px topbar, and a 1024 px boundary under which the
 * sidebar becomes a temporary drawer — and this module is where they live, because a `<script setup>` block cannot
 * export anything: a constant a test wants to assert against the document has to have a module of its own.
 *
 * They are **not** CSS custom properties (`styles/tokens.css` holds those). The sidebar width and the breakpoint are
 * read by TypeScript — the drawer's `:width`, Vuetify's `display.mobileBreakpoint` — so a CSS variable would have to be
 * read back out of the DOM to make the same decision in two places.
 *
 * @module layouts/adminShell
 */

/** Sidebar width in `13-ui-ux.md` §3, in pixels. */
export const SIDEBAR_WIDTH = 248;

/** Topbar height in §3's diagram, in pixels. */
export const TOPBAR_HEIGHT = 64;

/**
 * The width below which §3 says the sidebar becomes a temporary drawer.
 *
 * Also handed to Vuetify as `display.mobileBreakpoint` (`plugins/vuetify.ts`), so `useDisplay().mobile` means *this*
 * boundary rather than Vuetify's default 1280 px — which would call a 1100 px laptop a phone.
 */
export const MOBILE_BREAKPOINT = 1024;

/** The id the skip link points at, and the `<main>` the admin shell renders. */
export const MAIN_ID = 'mm-main';
