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
 * The three stylesheets are the exception, and they are imported here rather than in `bootstrap.ts` for one reason: they
 * are the *application's* CSS, so they must load whichever component renders first, and `main.ts` is the only module a
 * browser is guaranteed to evaluate before any component exists. Tokens first (`tokens.css`), then the type system
 * (`typography.css`), then the shell rules that use both (`shell.css`, `P1-WEB-07`).
 *
 * @module main
 */

import './styles/tokens.css';
import './styles/typography.css';
import './styles/shell.css';

import { createWebApp, MOUNT_SELECTOR } from './bootstrap';

createWebApp().mount(MOUNT_SELECTOR);
