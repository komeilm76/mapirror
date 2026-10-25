/**
 * Vitest root configuration (task `P1-REPO-04`).
 *
 * One root config, four projects — `shared`, `api`, `web`, `scripts` — so a single `bun run test`
 * exercises every workspace with the right environment, and `bun run test:api` / `test:web` can target
 * one. The project table itself lives in `vitest.projects.ts`, because `scripts/check-hygiene.ts`
 * asserts that no test file escapes it.
 *
 * Environment choices:
 * - `shared` and `api`: Node. They run on the server; a DOM would hide accidental browser assumptions.
 * - `web`: jsdom, because the SPA's tests touch `document`, `sessionStorage` and (from `P1-WEB-01`)
 *   mounted components.
 *
 * Coverage thresholds are set here (not per project) and start at a low floor that rises with the phase
 * gates in `docs/07-roadmap.md` — a threshold nobody can meet is worse than none, and one that never
 * moves is worse still.
 *
 * @module vitest.config
 */

import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';
import { defineConfig } from 'vitest/config';

import { SRC_ALIAS } from './apps/web/alias';

import { TEST_INCLUDE, TEST_PROJECTS } from './vitest.projects';

export default defineConfig({
  test: {
    projects: TEST_PROJECTS.map((project) => ({
      // The SPA's tests mount single-file components, which nothing but the Vue plugin can compile. Registered per
      // project rather than globally so the API's tests keep failing if they ever grow a `.vue` import by mistake.
      // The SPA's two build plugins, for the same reason the alias is shared: a component that compiles in the build
      // must compile in its test, and Vuetify's components only exist once the plugin has imported them.
      plugins: project.name === 'web' ? [vue(), vuetify({ autoImport: true })] : [],
      // The same alias `vite build` uses, imported from the SPA's own config rather than re-spelled here: an import
      // that resolves in the editor and the build but not in the tests is a test suite that cannot fail usefully.
      resolve: project.name === 'web' ? { alias: SRC_ALIAS } : {},
      test: {
        name: project.name,
        root: project.root,
        environment: project.environment,
        include: [...TEST_INCLUDE],
        // jsdom has no layout engine; Vuetify and VueUse ask for the pieces they need. See the file's own note.
        setupFiles: project.name === 'web' ? ['./tests/setup.ts'] : [],
        // Vuetify ships its component CSS next to the component, and the auto-import plugin injects those imports. The
        // externalised (node-resolved) path cannot load a `.css` file — `Unknown file extension ".css"` — so the
        // package goes through Vite's pipeline like it does in the build.
        server: { deps: { inline: ['vuetify'] } },
      },
    })),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['packages/shared/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/web/src/**/*.ts'],
      // Only declarations are excluded. Barrel files (`index.ts`) are NOT: excluding them silently
      // dropped every source file in Phase 1, so the report said "All files 0" and the thresholds
      // passed on nothing. An empty coverage table means the globs are wrong — not that the code is
      // perfect.
      exclude: ['**/*.d.ts'],
      // Phase 1 floor. `docs/08-tasks.md` P5-TST-01 raises this to 80 %.
      thresholds: {
        lines: 20,
        functions: 20,
        branches: 20,
        statements: 20,
      },
    },
  },
});
