/**
 * Ambient types for code that runs through Vite (`P1-WEB-01`).
 *
 * The web `tsconfig.json` sets `"types": []` — the API's `bun` types must not leak into a browser build — which also
 * removes Vite's own ambient declarations (`import.meta.env`, `?raw` and asset imports). The triple-slash reference
 * below re-adds exactly those and nothing more.
 *
 * `.vue` files need no entry here: `vue-tsc` resolves an SFC on its own, and plain `tsc` stopped being the web
 * typecheck in this same task (see `apps/web/tsconfig.json`).
 */

/// <reference types="vite/client" />
