/**
 * The SPA's import alias, defined once (`P1-WEB-01`).
 *
 * Three consumers must agree about `@/…`:
 *
 * - `vite.config.ts` — for `vite dev` and `vite build`;
 * - the root `vitest.config.ts` — so a component that compiles in the build compiles in its test;
 * - `apps/web/tsconfig.json` — for the editor and `vue-tsc`, which cannot read TypeScript and so has its own copy in
 *   `paths`. A test compares the two (`tests/bootstrap.spec.ts`) because that third copy is the one that drifts.
 *
 * A plain module rather than a constant inside `vite.config.ts`: a test that imported the config would load it inside
 * jsdom, where `import.meta.url` is the document's URL and `fileURLToPath` throws "The URL must be of scheme file" —
 * measured, before this file existed.
 *
 * @module alias
 */

import { resolve } from 'node:path';

/** `@` → `apps/web/src`, as an absolute path: what Vite's `resolve.alias` expects. */
export const SRC_ALIAS = { '@': resolve(import.meta.dirname, 'src') } as const;
