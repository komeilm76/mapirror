/**
 * Placeholder entry point for `@mapirror/api`.
 *
 * It exists so `tsc` has an input to check while the workspace is being assembled (`P1-REPO-02`).
 * The real bootstrap — `app.ts` (plugin registry, route registration) and `server.ts` (listen,
 * signals, worker start) — replaces this file in `P1-API-01`. Until then it exports the route
 * classification built in `P1-REPO-07`, which the admin guard will be keyed on.
 *
 * @module
 */

export * from './config/prefixes';
