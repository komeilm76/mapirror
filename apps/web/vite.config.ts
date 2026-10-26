/**
 * Vite configuration for the SPA (`P1-WEB-01`).
 *
 * Kept deliberately small: the pieces that matter are the Vue plugin, the `@` alias, a dev server that a **container or a
 * remote preview** can reach, and the proxy to the API (`P1-WEB-08`, in its own module because the traps in it are all
 * silent — `dev-proxy.ts`). The production build is what `P1-DOCK-02` copies into nginx.
 *
 * The two helper imports carry their `.ts` extension on purpose: Vite 8 warns that extensionless relative imports do
 * not survive its planned `native` config loader, and a config that fails to load is a dev server that does not start
 * (`dev-proxy.ts` records that failure, and `apps/web/tsconfig.json` gains `allowImportingTsExtensions` for it).
 *
 * ## Why `host` is not `localhost`
 *
 * Vite's default binds `127.0.0.1`, which is right for a laptop and wrong for anything else — a dev server inside a
 * container, or one behind a port-forward, is unreachable from the browser while looking perfectly healthy in the
 * terminal ("Local: http://localhost:5173" and nothing loads). `host: true` binds every interface.
 *
 * `allowedHosts: true` follows from the same fact: Vite 6 added a host allow-list to stop DNS-rebinding attacks
 * against a dev server, and its default set is the loopback names. A preview URL is neither loopback nor known in
 * advance, so the check would refuse every request with "Blocked request. This host is not allowed." The risk it
 * guards is a dev server bound to a public interface — which, with `host: true`, is exactly what this is; so the
 * honest statement is that `bun run dev:web` is a development tool and must not be exposed to the internet. The
 * production server is nginx serving static files (`12-deployment.md`), not Vite; nothing here ships.
 *
 * @module vite.config
 */

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import vuetify from 'vite-plugin-vuetify';

import { SRC_ALIAS } from './alias.ts';
import { createDevProxy } from './dev-proxy.ts';

/** The port `09-development.md` §3 documents, and the one the API's CORS allow-list names in dev. */
const DEV_PORT = 5173;

export default defineConfig({
  plugins: [
    vue(),
    // Auto-imports the Vuetify components an SFC actually uses, and the matching CSS with them. Without it the
    // bundler entry of Vuetify registers **no** components: `v-app` compiles to a literal `<v-app>` element and the
    // page renders empty (measured: `<v-app><v-main></v-main></v-app>` in the DOM, and `Failed to resolve component`
    // warnings). The alternative — importing `vuetify/components` and `vuetify/styles` wholesale — ships every
    // component and ~500 kB of CSS the app never renders.
    vuetify({ autoImport: true }),
  ],
  resolve: {
    // `@/pages/HomePage.vue` instead of `../../pages/HomePage.vue`. Defined in `alias.ts`, shared with the tests.
    alias: SRC_ALIAS,
  },
  server: {
    host: true,
    port: DEV_PORT,
    // Fail loudly instead of silently moving to 5174: the API's dev CORS allow-list, the docs and the operator's
    // bookmark all say 5173.
    strictPort: true,
    allowedHosts: true,
    // One entry per API prefix plus the two probes; everything else is a page this server renders. Built from
    // `@mapirror/shared`, so the list cannot drift from the route law, and `PORT` is the API's own variable.
    proxy: createDevProxy(),
  },
  preview: {
    host: true,
    port: DEV_PORT,
    strictPort: true,
    allowedHosts: true,
    // `vite preview` serves the built bundle, and without this a preview build talks to nothing — every API call 404s
    // against the static server, which looks like a broken build rather than a missing proxy.
    proxy: createDevProxy(),
  },
  build: {
    outDir: 'dist',
    // A source map in production is a file a visitor can fetch; the API's error handling strips stack traces for the
    // same reason (`P1-API-04`). `P1-DOCK-02` serves `dist/` as-is.
    sourcemap: false,
  },
});
