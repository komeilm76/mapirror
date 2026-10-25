/**
 * The `*.vue` module declaration (`P1-WEB-01`).
 *
 * Two compilers read the SPA's TypeScript, and they do not resolve an SFC the same way:
 *
 * - **`vue-tsc`** (the web `typecheck` script) understands `.vue` natively and resolves the *real* component, so this
 *   declaration does not apply to it. Verified by probe, not assumed: a `h(Counter, { count: 'x' })` misuse still
 *   fails the typecheck with "Type 'string' is not assignable to type 'number'" **with** this file present.
 * - **plain `tsc`** — which is what ESLint's type-aware service and most editors' TS server use — cannot open an SFC,
 *   so an `import X from './X.vue'` became an "error typed" value and every rule that touches it reported
 *   `no-unsafe-assignment`. That is a lint error about the toolchain, not about the code.
 *
 * `DefineComponent` with no type arguments, deliberately: filling them in here would be a second, weaker description
 * of every component's props, and a reader would have to know which of the two the compiler believed.
 *
 * @module shims-vue
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent;
  export default component;
}
