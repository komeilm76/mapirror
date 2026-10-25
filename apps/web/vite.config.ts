/**
 * Vite configuration for the SPA (`P1-WEB-01`).
 *
 * Kept deliberately small: the pieces that matter now are the Vue plugin, the `@` alias, and a dev server that a
 * **container or a remote preview** can reach. The proxy to the API is `P1-WEB-08`; the production build is what
 * `P1-DOCK-02` copies into nginx.
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

import { SRC_ALIAS } from './alias';

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
  },
  preview: {
    host: true,
    port: DEV_PORT,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    // A source map in production is a file a visitor can fetch; the API's error handling strips stack traces for the
    // same reason (`P1-API-04`). `P1-DOCK-02` serves `dist/` as-is.
    sourcemap: false,
  },
});
