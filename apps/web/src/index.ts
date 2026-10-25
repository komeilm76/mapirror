/**
 * Placeholder entry point for `@mapirror/web`.
 *
 * It exists so `tsc` has an input to check while the workspace is being assembled (`P1-REPO-02`).
 * The real SPA bootstrap (`main.ts`, `App.vue`, router, Pinia, Vuetify theme) replaces this file in
 * `P1-WEB-01`. Until then it exports the route path table from `P1-REPO-07`, which the router law test
 * walks. `.vue` files are type-checked by `vue-tsc`, which is added with the web toolchain —
 * plain `tsc` covers the TypeScript half of the package until then.
 *
 * @module
 */

export * from './router/paths';
