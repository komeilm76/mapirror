/**
 * `@mapirror/shared` — the single source of truth for contracts between the API and the web app.
 *
 * The workspace is created in `P1-REPO-01`; its contents land in `P1-REPO-07`:
 *
 * - `schemas/`   Zod schemas for every request, response and error envelope (`04-api.md`)
 * - `types/`     `z.infer` exports — no hand-written duplicates
 * - `constants`  route prefixes, error codes, interval frequencies, size limits
 *
 * Keep this file free of runtime dependencies so both the API and the browser bundle can import it.
 *
 * @module
 */

export {};
