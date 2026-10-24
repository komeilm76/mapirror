# Changelog

All notable changes to MapMirror. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning

| Version | Phase | Meaning |
|---|---|---|
| `0.1.x` | 0 — Documentation | The specification set. No application code. |
| `0.2.x` | 1 — Foundation | Workspace, Docker, Postgres, auth, admin shell |
| `0.3.x` | 2 — Cache engine | Catalog, downloads, versions |
| `0.4.x` | 3 — Public portal | Publishing, public site + API |
| `0.5.x` | 4 — Automation | Import, intervals, update detection |
| `0.6.x` | 5 — Polish | Monitoring, UI/UX, test depth |
| `1.0.0` | 6 — Release | Hardened, documented, verified deployment |

While `0.2.0` is in development the package version is `0.2.0-dev`; the tag is cut when the phase gate
passes. Patch releases (`0.1.1`, …) are corrections to an already-tagged phase.

---

## [Unreleased] — 0.2.0-dev (Phase 1)

### Added
- Bun workspace skeleton (`P1-REPO-01`): root `package.json` (`0.2.0-dev`, `packageManager bun@1.4.4`),
  `apps/api`, `apps/web`, `packages/shared`, `bun.lock`, `.gitignore`.
- `bun run check:workspaces` — 12 assertions covering workspace declaration, privacy, naming,
  `workspace:*` wiring and real package resolution from a consumer.
- The quality gate (`P1-REPO-05`): `bun run check` runs workspaces → typecheck → lint → format:check →
  test, fail-fast; `bun run check:full` adds coverage thresholds. Each stage was verified to fail the
  gate on its own.
- Test infrastructure (`P1-REPO-04`): one `vitest.config.ts` with three projects (`shared`/`api` in
  node, `web` in jsdom — no deprecated `vitest.workspace.ts`), v8 coverage with thresholds, and
  scripts `test`, `test:watch`, `test:coverage`, `test:api`, `test:web`, `test:shared`.
  First tests pin the project environments themselves (DOM absence on the server, `sessionStorage` in
  the browser project, workspace resolution under both runners).
- Code quality toolchain (`P1-REPO-03`): ESLint 9 flat config (JS + type-aware TypeScript via the
  project service + `eslint-plugin-vue` + `eslint-config-prettier` last), Prettier with markdown
  excluded, `.prettierignore`, `.editorconfig`; scripts `lint`, `lint:fix`, `format`, `format:check`.
  Project rules encode the laws: no floating promises, no `any`, `v-html` banned, `script setup` only.
- Strict TypeScript baseline (`P1-REPO-02`): `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax`, `isolatedModules`,
  `module: preserve`, `noEmit`) extended by the root (scripts), `apps/api`, `apps/web` (DOM libs, no Bun
  types) and `packages/shared`. `bun run typecheck` runs the root project then every workspace.
- Tooling pinned at the root: `typescript@5.9.3`, `@types/bun@1.4.4`.
- `README.md` gains a repository-layout section and the current phase status.

---

## [0.1.0] — 2026-10-24 — Phase 0: Documentation

The complete specification, approved by the owner, before any application code exists.

### Added

- **`PROMPT.md`** — the standardized build prompt: vision, mandatory stack, actors, hard route law,
  authentication, cache/version management, public access, intervals, update detection, import form,
  public API, monitoring, UI/UX goals, Docker deployment, engineering standards, Phase 0 deliverable
  list, target tree, roadmap, definition of done, and the owner's decision log (**D-1 … D-19**), with
  the original request preserved verbatim in Appendix A.
- **`docs/00-index.md`** — route map (memorize-this table), document table, reading paths, status.
- **`docs/01-overview.md`** — personas, scope, out-of-scope, product rules, verified source facts.
- **`docs/02-architecture.md`** — containers, module boundaries, request path, job queue (advisory-lock
  ownership, reaper, cancellation), scheduler, download pipeline, failure matrix, performance envelope.
- **`docs/03-data-model.md`** — 15 tables with DDL, indexes, constraints, invariants, migration
  strategy, sizing.
- **`docs/04-api.md`** — normative route map plus every endpoint in `/_auth/api/*`, `/_admin/api/*`,
  `/_public/api/*` with bodies, errors, job/internal codes, download headers and `curl` examples.
- **`docs/05-flows.md`** — 12 end-to-end sequences with invariants and the tests that pin them.
- **`docs/06-diagrams.md`** — 11 Mermaid diagrams (context, containers, deployment, namespaces, ERD,
  state machines, lifecycle, scheduling, SPA navigation).
- **`docs/07-roadmap.md`** — 7 phases with exit gates.
- **`docs/08-tasks.md`** — 136 tasks with requirement IDs, dependencies and acceptance criteria, plus a
  requirement → task traceability matrix.
- **`docs/09-development.md`** — setup, scripts, env vars, database workflow, testing layers, debugging,
  conventions, troubleshooting.
- **`docs/10-laws.md`** — 14 non-negotiable laws (route law, deny-by-default, bearer-only, stack,
  boundary validation, storage safety, immutable versions, publish-means-visible, secrets, destructive
  confirmation, honest status, docs-in-sync, verification, branch/scope discipline).
- **`docs/11-project-tree.md`** — target repository tree, storage layout, naming rules.
- **`docs/12-deployment.md`** — Ubuntu 24.04 + Docker runbook, TLS, internal Nginx routing, backups,
  restore, upgrades, troubleshooting.
- **`docs/13-ui-ux.md`** — design tokens, layouts, 14 screens, component rules, a11y, responsive rules
  and the 10-criterion 5/5 rubric.
- **`docs/14-security.md`** — threat model, auth, input/file safety, headers, rate limits, privacy,
  and a 20-item sign-off checklist.
- **`docs/15-decisions.md`** — 24 ADRs recording the reasoning behind the architecture.
- **`docs/16-changelog.md`** — the three documentation review passes (54 defects found and fixed).
- **`README.md`** — project summary, route map, stack, quick start.

### Decisions recorded

D-1 Geofabrik behind a thin `MapSource` · D-2 `.osm.pbf` only · D-3 opaque DB tokens (no JWT) ·
D-4 one admin, multi-admin schema · D-5 local `/data/cache` volume · D-6 daily/weekly/monthly in UTC ·
D-7 keep newest 3 versions · D-7b hard delete · D-8 MapMirror · D-9 opt-in per country ·
D-10 reject duplicates · D-11 Postgres job queue · D-12 SQL + Kysely + Zod · D-13 `sessionStorage` ·
D-14 dark admin / light public · D-15 Nginx :8080 · D-16 English only · D-17 API namespaces ·
D-18 pages under `/_site/*` · D-19 login under `/_auth/*`.

### Notes

- No application code, no dependencies, no build in this release — deliberately. The phase gate is
  documentation approval.

---

## Release checklist (Phase 6 → 1.0.0)

- [ ] Clean Ubuntu 24.04 install from `docs/12-deployment.md` alone
- [ ] Backup + restore drill including the missing-artifact path
- [ ] Security checklist (`docs/14-security.md`) signed off
- [ ] UI rubric ≥ 45/50 with screenshots
- [ ] `bun run check` green, coverage ≥ 80 %
