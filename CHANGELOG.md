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

- **P4-UPD-03 — cached-country update controls:** the cache table and responsive cards now check each cached region through the persisted inline endpoint, display the returned state and checked time, and render an amber `Update available · <version>` badge. The confirmed update dialog reports estimated added snapshot space, estimated cache total when available, and that existing ready versions are retained; confirmed requests queue the identified dated version and appear in the shell job drawer. The cache-page flow test verifies checking, remount/reload persistence, impact copy, and the exact pinned request. `bun run check` passes (1,352 passed; 329 skipped without a fresh PostgreSQL test database); `bun run build:web` passes (489 modules transformed; main app 432.19 kB / 134.41 kB gzip).
- **P4-UPD-02 — update-check endpoints and bulk worker:** added the five-second-bounded inline check (`unknown` for upstream failures), strict selected/all-cached bulk admission, sequential per-country persistence, count-based job progress, and a schema-validated aggregate result allow-list on job details. The jobs UI now renders update checks in country units and shows the completed outcome summary. Shared/API/worker/UI tests pass; PostgreSQL-backed result projection and persistence cases are collected but skipped without a fresh test database. Full `bun run check` passes (1,351 passed; 329 skipped); `bun run build:web` passes (489 modules transformed; main app 425.54 kB / 132.93 kB gzip).
- **P4-UPD-01 — update comparison core:** compares the current Geofabrik snapshot with ready cached source versions using exact snapshot identity, data timestamp and known size; persists `up_to_date`, `update_available` or honest `unknown` results and clears stale offers when a comparison is not available. Successful source details are memoized for ten minutes, concurrent same-region reads are coalesced, and source downloads invalidate old comparisons after installation. Seven deterministic comparison tests pass; two PostgreSQL-backed persistence tests and the download-install invalidation case are collected but skipped without a fresh test database. Full `bun run check` passes (1,339 passed; 328 skipped).

- **P4-INT-09 — interval run history and manual trigger:** extended S9 with a confirmation-gated manual run action that remains available for paused schedules; paginated run history and validated run details; active-run polling; distinct `running`, `succeeded`, `partial`, and `failed` labels; country outcome counts, safe aggregate/country failure details, and separate active-interval versus conflicting-download guidance. Extended the interval UI and run-history tests. Verified by `bun run check` (1,332 passed; 326 skipped, including PostgreSQL-backed integration cases without a fresh test database) and `bun run build:web`. The interval UI suite covers paused-schedule triggers, all four statuses, polling through terminal state, pagination, safe country failures, and distinct run/download conflicts.
- **P4-INT-08 intervals screen:** authenticated interval list and create/edit form with searchable multi-country selection, frequency-specific UTC timing, pause/delete controls, last-run status, and a live next-five preview. The browser preview and API scheduler now use the same shared recurrence helper.
- **P4-INT-08 verification:** `bun run check` passes (1,327 tests passed; 326 skipped, including PostgreSQL-backed cases without a fresh test database). `bun run build:web` passes and emits the lazy-loaded Intervals screen chunk (16.63 kB; 5.33 kB gzip).

### Fixed
- **Pagination could produce a non-integer offset** (review pass 8): `?page=9007199254740991&limit=100`
  gave `900719925474099000`, which is what would have reached SQL as `OFFSET`. The product is now clamped to
  the safe-integer range.
- `buildPageMeta(…, limit: 0, …)` divided by zero and serialised `totalPages` as `null`; `limit` and `page`
  are normalised inside the function.
- Pagination read **any** number JavaScript accepts: `?limit=0x10` meant 16 and `?page=1e3` meant 100. Only
  plain decimals are parsed now; everything else falls back to the default.
- **The admin guard's classification ignored percent-encoding**, so `/_admin/%61pi/...` was not an admin
  path. Classification now decodes first and fails closed (L2), and the reserved `api` segment uses `.every`
  so `/_site/%61pi` cannot pass as a page.
- `apps/api/src/config/prefixes.ts` re-derived `API_PREFIXES` that `@mapirror/shared` already exported.

### Added
- **Fastify bootstrap** (`P1-API-01`): `buildApp()` with the request pipeline as ordered data
  (`plugins/order.ts` → request-context → errors → security → db → rate-limit → auth → routes), one
  encapsulated plugin per API prefix registered from the shared route law, and `server.ts` owning the
  process: port from `PORT`, `SIGTERM`/`SIGINT` shutdown, exit 0 when asked to stop and 1 when it cannot
  start or close. `bun run dev:api` / `start:api` added.
- **L1 is now enforced at boot**, not only by the law test: an `onRoute` hook rejects any route outside the
  three API prefixes or the probes, naming the route and the rule.
- Three temporary `503 NOT_READY` stubs at their real contract paths (`POST /_auth/api/login`,
  `GET /_admin/api/catalog`, `GET /_public/api/countries`), each naming the task that replaces it and
  asserted as a set by test, so a forgotten stub fails the gate rather than shipping.
- **P4-IMP-03 import worker + status API:** accepted `import` jobs now stream staged PBF bytes into a cache part while computing MD5, atomically install before marking the version ready, and finalize the upload session/cache totals transactionally. Cancellation and terminal failure clean artifacts first and do not leave a ready version; queued import cancellation removes staging before the job becomes terminal. Added authenticated `GET /_admin/api/imports/:uploadId` with strict safe status/error projection and no-follow staging reads.
- **P4-IMP-04 explicit version replacement:** a duplicate now reports whether replacement is allowed; `replace=true` confirms an atomic row replacement after the new artifact installs. Failed replacements preserve the previous version/file, and download enqueue serializes against active imports and rechecks ready versions.

### Fixed
- `readPort` accepted `0x10` and `30e3` as ports (16 and 30000) because it used `Number()`; it now reads
  digits only — the same defect class as `parsePagination`, caught by the test written for it.

### Added
- **Shared contracts** (`P1-REPO-07`), the first code both apps depend on: `@mapirror/shared` now owns the
  route law (`routes`), the error vocabulary (`errors`), pagination (`pagination`), the ODbL attribution
  (`license`) and the shared enums (`constants`). Zero runtime dependencies, no globals, importable by the
  browser bundle. Consumed in real code by `apps/api/src/config/prefixes.ts` (the deny-by-default guard
  classification) and `apps/web/src/router/paths.ts` (the page table) — 96 tests over 11 files, 100 %
  statements/branches/functions/lines on every module that has code.
- `scripts/tests/docs-contract.spec.ts` parses `04-api.md` and `03-data-model.md` and compares them with the
  constants in **both** directions, so a code, status, prefix or enum value added on one side only fails the
  gate. Probes: six injected defects (changed prefix, undocumented code, wrong status, extra enum value, a
  page mounted under `/_admin/api`, changed token length) each fail the intended test.
- `check:workspaces` proves `@mapirror/shared` resolves into `packages/shared` from **both** apps (22 checks,
  was 21).

### Fixed
- **Tests could be silently skipped** (review pass 6). Vitest collected only `tests/**/*.spec.ts`, so the
  two route-law tests the specification names `*.test.ts` — and the `scripts/tests/*.spec.ts` promised for
  the launch script — would have passed by never running. Projects now live in `vitest.projects.ts`,
  collect both suffixes, include a fourth `scripts` project, and `check:hygiene` fails if any test file
  sits outside a declared project. Probes: a failing `law-routes.test.ts` went from exit 0 to exit 1.
- **`cp .env.example .env` was not enough for Docker.** The template carried `DATABASE_URL` pointing at
  `localhost` plus a second copy of the database password, while `12` tells operators to change that
  password. Compose now derives the DSN from `POSTGRES_PASSWORD` (acceptance criterion of `P1-DOCK-05`),
  and the template's storage paths are relative so native dev no longer needs write access to `/`.
- **`.gitignore` missed `*.pem` / `*.key` / `*.p12` / `secrets/`** that `.dockerignore` already blocked,
  and the hygiene check now requires both files to cover the same credential shapes.
- `check:hygiene` compared env **names** only (a changed default passed), matched `.dockerignore` without
  honouring `!` re-inclusion, and checked tracked-and-ignored files against a copied rule list instead of
  asking git. All three now do what the file claims.

### Added
- Repository hygiene (`P1-REPO-06`): `.env.example` (32 documented variables, `*_FILE` secret
  variants commented out), `.dockerignore` (secrets and build junk out, build inputs explicitly kept),
  and `bun run check:hygiene` — 54 assertions covering the git ignore matrix, "nothing ignored is
  tracked", `.env.example` ↔ `docs/09` §5 parity (names and defaults, both directions), credential parity
  across both ignore files, `.dockerignore` safe-listing, and orphan-test detection.
  It is now stage 2 of `bun run check`, so a leaked secret or a template that forgot a variable fails
  the gate instead of surviving review. Verified by probe: dropping `.env` from `.gitignore`, deleting
  `WORKER_CONCURRENCY` from the template, adding `packages` to `.dockerignore`, and force-adding a
  tracked `.env` each exit 1 with a named `FAIL` line; the clean tree exits 0.
- Bun workspace skeleton (`P1-REPO-01`): root `package.json` (`0.2.0-dev`, `packageManager bun@1.4.4`),
  `apps/api`, `apps/web`, `packages/shared`, `bun.lock`, `.gitignore`.
- `bun run check:workspaces` — 12 assertions covering workspace declaration, privacy, naming,
  `workspace:*` wiring and real package resolution from a consumer.
- The quality gate (`P1-REPO-05`): `bun run check` runs workspaces → hygiene → typecheck → lint →
  format:check → test, fail-fast; `bun run check:full` adds coverage thresholds. Each stage was verified
  to fail the gate on its own.
- Test infrastructure (`P1-REPO-04`): one `vitest.config.ts` with a project table in
  `vitest.projects.ts` — four projects (`shared`/`api`/`scripts` in node, `web` in jsdom — no deprecated
  `vitest.workspace.ts`), v8 coverage with thresholds, and scripts `test`, `test:watch`, `test:coverage`,
  `test:api`, `test:web`, `test:shared`, `test:scripts`.
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
