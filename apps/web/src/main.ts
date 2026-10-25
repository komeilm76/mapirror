/**
 * The SPA entry point (`P1-WEB-01`).
 *
 * Two lines, and both are load-bearing:
 *
 * - `createWebApp()` — the app and its plugins, in `bootstrap.ts`, so a test can build the same thing without mounting
 *   it into a page that does not exist.
 * - `.mount(MOUNT_SELECTOR)` — `index.html`'s `<div id="app">`. A mismatch between the two is not an error anywhere:
 *   Vue logs a warning, the page stays empty, and the HTML still returns `200`.
 *
 * Nothing else belongs here. Anything a reader might want to test goes in `bootstrap.ts`; anything a reader might want
 * to configure goes in `plugins/`.
 *
 * @module main
 */

import { createWebApp, MOUNT_SELECTOR } from './bootstrap';

createWebApp().mount(MOUNT_SELECTOR);
