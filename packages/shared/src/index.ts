/**
 * `@mapirror/shared` — the single source of truth for contracts between the API and the web app.
 *
 * Imported by both applications and bundled for the browser, so this package has **no runtime
 * dependencies** and touches no globals: no `Bun.*`, no `process`, no `window`, no `node:*`.
 *
 * What lives here and why it is one copy:
 *
 * | Module | Contract it pins |
 * |---|---|
 * | `routes` | L1/D-18/D-19 — which namespace every path belongs to |
 * | `errors` | `04-api.md` §0.2 — error codes, their HTTP status, the envelope |
 * | `pagination` | D-16 — `{ data, meta }`, defaults and the `limit` ceiling |
 * | `license` | ODbL attribution that must appear on every public surface |
 * | `constants` | token format, sort fields and the enums the DB `CHECK`s mirror |
 *
 * Zod schemas for request/response bodies build on these and land with the API contract tasks; they are
 * additive, so nothing here changes shape when they arrive.
 *
 * @module
 */

export * from './constants';
export * from './errors';
export * from './license';
export * from './pagination';
export * from './routes';
