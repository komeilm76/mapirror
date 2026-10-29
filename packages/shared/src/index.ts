/**
 * `@mapirror/shared` — the single source of truth for contracts between the API and the web app.
 *
 * Imported by both applications and bundled for the browser, so this package touches no globals: no
 * `Bun.*`, no `process`, no `window`, no `node:*`. Its **only runtime dependency is `zod`** — pure JavaScript,
 * itself dependency-free, and the contract requires it: ADR-021 makes these schemas the contract, and a schema the
 * SPA cannot run is not a contract. (Until `P1-AUTH-03` the package had none at all; that is now one, not several.)
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
 * | `auth` | login request/response shapes and their bounds (`P1-AUTH-03`) |
 * | `catalog` | admin catalog query, row and sync response contracts (`P2-API-01`) |
 * | `cache` | admin cache-list/detail and publication toggle contracts (`P2-API-05`, `P3-API-02`) |
 * | `public-catalog` | public country-list query and response contract (`P3-API-03`) |
 * | `jobs` | admin job list/detail/cancel contracts (`P2-API-10`) |
 *
 * Request/response schemas are added alongside their owning API contract tasks, so each implemented endpoint exports
 * one strict, reusable Zod shape instead of a prose-only or server-private contract.
 *
 * @module
 */

export * from './auth';
export * from './catalog';
export * from './cache-download';
export * from './cache';
export * from './cache-versions';
export * from './catalog-region';
export * from './constants';
export * from './errors';
export * from './license';
export * from './jobs';
export * from './pagination';
export * from './public-catalog';
export * from './public-country';
export * from './routes';
