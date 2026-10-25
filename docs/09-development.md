# 09 — Development guide

Target: from a fresh clone to a running stack in **under 10 minutes**, with hot reload.

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Bun | ≥ 1.2 | runtime + package manager + test host |
| Docker + Compose plugin | ≥ 27 | PostgreSQL locally (or use native Postgres 16) |
| Git | any | — |
| Node.js | *not required* | Bun replaces it; Vite runs through Bun |

```bash
curl -fsSL https://bun.sh/install | bash
docker --version && docker compose version
```

## 2. First run (Docker, production-like)

```bash
git clone <repo> mapirror && cd mapirror
cp .env.example .env
# set a real password (≥ 12 chars)
sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=change-me-please-123/' .env
docker compose up -d --build
docker compose logs -f api
# → "migrations applied", "admin 'admin' created", "listening on 3000"
open http://localhost:8080            # public site
open http://localhost:8080/_auth/login # admin login
```

> **Where we are today:** the API boots and serves its three namespaces (`P1-API-01`), but nothing in this
> section works end to end yet — there is no database, no login and no SPA. `bun run dev:api` starts it on
> `:3000`; every route answers `503 NOT_READY` until its module lands (see `04-api.md` §0.3).
> The rest arrives with `P1-DOCK-04`, `P1-WEB-01` and the database tasks.

## 3. First run (local dev, hot reload)

```bash
bun install
docker compose up -d db                # only PostgreSQL
cp .env.example .env                   # DATABASE_URL points at localhost:5432

bun run db:migrate                     # apply SQL migrations
ADMIN_PASSWORD=dev-password-123 bun run admin:init

bun run dev                            # runs API (:3000) + web (:5173) concurrently
```

- Web dev server on **http://localhost:5173**. Its proxy list must use the API prefixes only —
  `/_auth/api`, `/_admin/api`, `/_public/api`, `/healthz`, `/readyz` → `http://localhost:3000`.
  Proxying bare `/_auth` would send the **login page** request to the API and 404 in dev while working
  in production (where Nginx splits them), which is a classic "works on my machine" trap.
- The API watches `apps/api/src`; the worker and scheduler run in the same process
  (`WORKER_ENABLED=true`).
- Vite HMR for the SPA.

## 4. Repository scripts (root `package.json`)

Scripts marked ✅ exist today; ⬜ are created by the task named in `08-tasks.md`.

| Script | Does | Status |
|---|---|---|
| `bun run typecheck` | `tsc --noEmit` for `scripts/` plus every workspace (`P1-REPO-02`) | ✅ |
| `bun run check:workspaces` | 21 assertions on the workspace wiring (`P1-REPO-01`) | ✅ |
| `bun run check:hygiene` | 54 assertions: ignore matrix, nothing ignored is tracked, credential parity across both ignore files, env-doc parity (names **and** defaults), `.dockerignore` safelist, no orphan tests (`P1-REPO-04/06`) | ✅ |
| `bun run dev` | API + web in watch mode | ⬜ P1-API-01 / P1-WEB-01 |
| `bun run dev:api` | API only, watch mode (`apps/api`: `bun --watch src/server.ts`) | ✅ P1-API-01 |
| `bun run start:api` | API only, no watch (what the container runs) | ✅ P1-API-01 |
| `bun run dev:web` | Web only | ⬜ P1-WEB-01 |
| `bun run build` | Build web bundle | ⬜ P1-DOCK-02 |
| `bun run check` | **The gate**: workspaces → hygiene → typecheck → lint → format:check → test, fail-fast | ✅ P1-REPO-05/06 |
| `bun run check:full` | `check` + coverage with thresholds (slower; used before a phase gate) | ✅ P1-REPO-05 |
| `bun run lint` | ESLint over the whole repo (`--max-warnings=0`) | ✅ P1-REPO-03 |
| `bun run lint:fix` | ESLint with `--fix` | ✅ P1-REPO-03 |
| `bun run format` | Prettier write | ✅ P1-REPO-03 |
| `bun run format:check` | Prettier verify (used by `check`) | ✅ P1-REPO-03 |
| `bun run test` | Vitest, all four projects | ✅ P1-REPO-04 |
| `bun run test:watch` / `test:coverage` | Watch mode / v8 coverage with thresholds | ✅ P1-REPO-04 |
| `bun run test:api` / `test:web` / `test:shared` / `test:scripts` | Single project | ✅ P1-REPO-04 |
| `bun run db:migrate` | Apply migrations | ⬜ P1-DB-01 |
| `bun run db:reset` | Drop + recreate + migrate + seed (dev only, refuses when `NODE_ENV=production`) | ⬜ P1-DB-01 |
| `bun run admin:init` | Create admin from env | ⬜ P1-AUTH-06 |
| `bun run admin:reset` | Reset password (interactive) | ⬜ P1-AUTH-07 |
| `bun run seed:dev` | Dev fixtures | ⬜ P1-DB-01 |
| `bun run sync:catalog` | Manual Geofabrik catalog sync | ⬜ P2-SRC-06 |

## 5. Environment variables

`.env.example` is the canonical list and this table is its documentation; `bun run check:hygiene`
asserts the two stay in sync in **both** directions, so adding a variable in one place only fails the
gate. Every variable is validated at boot with Zod (`apps/api/src/config/env.ts`); a required value that
is missing, or any value that is unusable, stops the process with exit 1 and a list of every problem at
once — the variable names, never the values, so a `DATABASE_URL` password cannot reach the container log.
A test asserts the schema and this table describe the same set of variables.

Alternatives such as `ADMIN_PASSWORD_FILE` are shipped **commented out** — a value and its `_FILE`
sibling are mutually exclusive, and the hygiene check counts commented declarations as documented.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `NODE_ENV` | `development` | ✅ | `development` / `production` / `test` |
| `PORT` | `3000` | — | API port, 1–65535. Absent → 3000; **present and unusable → the boot stops** naming it (`0x10`, `30e3`, `3000.5`), because binding a port the operator did not ask for looks healthy and is unreachable |
| `HOST` | `0.0.0.0` | — | Bind address |
| `DATABASE_URL` | `postgres://mapirror:mapirror@localhost:5432/mapirror` | ✅ in production | DSN the API boots with; **compose derives its own** from `POSTGRES_PASSWORD` + `db`, so `.env`'s copy serves native dev/tests. The default covers native dev and tests; `NODE_ENV=production` requires the variable — a production container must not guess a database |
| `DATABASE_URL_TEST` | `postgres://mapirror:mapirror@localhost:5432/mapirror_test` | — | Test DB (integration tests create/truncate) |
| `DB_POOL_MAX` | `10` | — | Pool size |
| `CORS_ORIGINS` | *(empty = same-origin)* | — | Comma-separated allow-list; never `*` |
| `IP_HASH_SALT` | *(generated on first boot, stored in `settings`)* | — | Salt for hashed download IPs |
| `TRUST_PROXY` | `loopback` | — | Which peers may assert a client address in `X-Forwarded-For`: an address, CIDR block or comma-separated list (`loopback`/`linklocal`/`uniquelocal`), or `none`. Every per-IP behaviour (rate limits, hashed download IPs) depends on it — without it every client behind the proxy shares the proxy's address. A **hop count is refused** (Fastify silently trusts nothing for a number) and so is `true` (trusts every peer) |
| `POSTGRES_PASSWORD` | `mapirror` | ✅ (compose) | Password for the `db` container — the one place it is written |
| `POSTGRES_PASSWORD_FILE` | — | — | Docker-secret alternative to `POSTGRES_PASSWORD` |
| `CACHE_DIR` | `./data/cache` | ✅ | Artifact storage root (compose: `/data/cache` volume) |
| `TMP_DIR` | `./data/tmp` | ✅ | Uploads + `.part` files (compose: `/data/tmp` volume) |
| `ADMIN_USERNAME` | `admin` | — | Bootstrap username |
| `ADMIN_PASSWORD` | — | ✅ (first boot) | Bootstrap password (never logged) |
| `ADMIN_PASSWORD_FILE` | — | — | Alternative to env (Docker secret) |
| `AUTH_TOKEN_TTL_HOURS` | `12` | — | Bearer token lifetime |
| `AUTH_MAX_LOGIN_ATTEMPTS` | `10` | — | Before lockout |
| `AUTH_LOCKOUT_MINUTES` | `15` | — | Lockout window |
| `WORKER_ENABLED` | `true` | — | Run queue worker + scheduler |
| `WORKER_CONCURRENCY` | `2` | — | Parallel jobs |
| `MAX_UPLOAD_BYTES` | `8589934592` (8 GiB) | — | Import limit |
| `DISK_RESERVE_BYTES` | `2147483648` (2 GiB) | — | Preflight reserve |
| `PUBLIC_DOWNLOADS_PER_MINUTE` | `10` | — | Per-IP limit |
| `GEOFABRIK_BASE_URL` | `https://download.geofabrik.de` | — | Source base (test override) |
| `CATALOG_TTL_MINUTES` | `360` | — | Catalog cache freshness |
| `METRICS_INTERVAL_SECONDS` | `10` | — | Sampler period |
| `METRICS_RETENTION_DAYS` | `7` | — | Sample retention |
| `JOB_RETENTION_DAYS` | `30` | — | Finished job retention |
| `LOG_LEVEL` | `info` | — | Pino level |
| `APP_VERSION` | from package | — | Shown in UI |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | — | Used in generated download links |
| `BRANDING_DISPLAY_NAME` | `MapMirror` | — | Default display name |

**Never** commit `.env`. In production prefer `ADMIN_PASSWORD_FILE` mounted as a Docker secret.

Two guard rails back that sentence up: `.env` and `.env.*` are ignored while `.env.example` is
negated back in (`.gitignore`, `.dockerignore` both do this — get the negation order wrong and the
template either vanishes from git or leaks into the image), and `check:hygiene` fails if any ignored
path is *tracked*, because an ignore rule never untracks a file added earlier.

## 6. Working with the database

```bash
docker compose exec db psql -U mapirror -d mapirror          # shell
bun run db:migrate                                            # apply
bun run db:reset                                              # dev only
```

- Migrations: `apps/api/src/db/migrations/NNNN_name.sql`, forward-only. Add the Kysely type change in
  `schema.ts` in the same commit.
- `0001_init.sql` creates the `pg_trgm` extension (required by the country search index). `unaccent`
  is created when available; the search works without it (see `03-data-model.md`).
- Never edit an applied migration; write a new one.
- Transactions in services, not repositories; repositories accept a `Kysely` instance / `tx`.

## 7. Testing

| Layer | Where | What |
|---|---|---|
| Unit | `apps/api/tests/unit/**` | schedule math, slugs, checksum, storage paths, validators |
| Integration | `apps/api/tests/integration/**` | routes + real Postgres (`DATABASE_URL_TEST`), guards, law tests |
| Contract | `packages/shared/tests/**` | Zod schemas accept/reject the documented shapes |
| Component | `apps/web/tests/**` | tables, dialogs, forms, stores (Vitest + jsdom/VTU) |
| Fixtures | `apps/api/tests/fixtures/**` | saved Geofabrik index + region HTML; a local HTTP server serves pbf/md5 |

### Projects

`vitest.config.ts` defines four projects in one config — no `vitest.workspace.ts` (deprecated in
Vitest 3.2+). The project table lives in **`vitest.projects.ts`** so the config and the hygiene check
read the same list:

| Project | Root | Environment | Why |
|---|---|---|---|
| `shared` | `packages/shared` | node | Contract tests; must stay DOM-free because it is bundled for the browser |
| `api` | `apps/api` | node | Services, schedulers, storage, route handler tests |
| `web` | `apps/web` | jsdom | Stores and components (`sessionStorage`, `document`) |
| `scripts` | `scripts` | node | Operator CLI (`05-flows`: `scripts/tests/init-admin.spec.ts`) |

Test files are collected as `tests/**/*.{spec,test}.ts` — **both suffixes**, so the law tests keep the
names the specification gives them. `check:hygiene` fails if any test file in the repository sits
outside a declared project: a test that is never collected passes by not running, which is the most
expensive kind of green.

```bash
bun run test            # all four projects
bun run test:api        # one project
bun run test:web
bun run test:shared
bun run test:watch      # watch mode
bun run test:coverage   # v8 coverage + thresholds
```

### The gate

`bun run check` is the single command every task and phase gate uses (L13). It runs six stages in
order and stops at the first failure, so the output always names the stage that broke:

```
check:workspaces → check:hygiene → typecheck → lint → format:check → test
```

Hygiene sits second on purpose: it is the cheapest stage (~0.2 s) and a leaked secret or a broken
`.dockerignore` invalidates everything after it.

Behaviour verified by deliberately breaking one stage at a time:

| Broken stage | Result |
|---|---|
| workspace wiring | exit 1, `FAIL …` lines |
| hygiene (dropped env var) | exit 1, `every documented variable is in .env.example …` |
| hygiene (`.dockerignore` exclusion) | exit 1, `.dockerignore keeps … in the build context` |
| hygiene (ignored file tracked) | exit 1, `no ignored artefacts are tracked: .env` |
| hygiene (orphan test file) | exit 1, `every test file is collected by a vitest project: …` |
| hygiene (default drifts from docs) | exit 1, `documented defaults match .env.example: DB_POOL_MAX: …` |
| TypeScript | exit 2, `error TS####` |
| ESLint | exit 1 — warnings also fail, because lint runs with `--max-warnings=0` |
| Prettier | exit 1, `Code style issues found` |
| a test | exit 1, `FAIL … AssertionError` |

`check:full` adds coverage thresholds. Keep the fast gate fast: it is meant to run on every task.

Rules:

- **No live network in tests.** If a test needs Geofabrik, point `GEOFABRIK_BASE_URL` at the fixture
  server.
- A test database is created per run (`mapirror_test`), migrated, truncated between suites.
- Law tests (`law-routes.test.ts`, `law-router.test.ts`) are non-negotiable and must never be skipped.
- **Coverage floor:** 20 % today, raised to 80 % on the core modules at `P5-TST-01`. Thresholds are
  global and *do* fail the run (verified: an uncovered file exits 1).
- **An empty coverage table is a bug, not a win.** It means the `include` globs missed every file —
  which is exactly what happened when `**/index.ts` was excluded and nothing else existed yet.
- **Coverage of the primitives is 100 %** (`packages/shared`, `apps/*/src`) as of `P1-REPO-07`. Barrel
  `index.ts` files report `0 | 0 | 0 | 0` because a re-export has no statements to execute; they are
  deliberately **not** excluded, since excluding barrels is what emptied the report once already.
- **Tests read the spec.** `scripts/tests/docs-contract.spec.ts` parses `04-api.md` (error table, route
  table) and `03-data-model.md` (`CREATE TYPE`/`CHECK`) and compares both directions with
  `@mapirror/shared`. A code, status, prefix or enum value added on one side alone fails the gate —
  that is what makes "the document and the code cannot drift silently" a fact rather than a promise.

## 8. Debugging

| Need | How |
|---|---|
| Follow a request | `x-request-id` in the response, same id in logs |
| Inspect a job | `GET /_admin/api/jobs/:jobId` or `docker compose exec db psql -c "select * from jobs order by created_at desc limit 5"` |
| Simulate a slow/failed source | `GEOFABRIK_BASE_URL=http://localhost:4010` fixture server with fault flags |
| Check disk math | `GET /_admin/api/system/status` → `storage` |
| Reset everything | `docker compose down -v && docker compose up -d` (destroys data) |
| Re-run admin bootstrap | `docker compose exec api bun run scripts/init-admin.ts` (idempotent) |
| Forgot admin password | `docker compose exec api bun run scripts/reset-admin-password.ts` |

### Shared contracts (`@mapirror/shared`)

The one place a contract is written. **No runtime dependencies and no globals** — it is bundled for the
browser, so `Bun.*`, `process`, `window` and `node:*` are compile errors there; `types: []` in the package
`tsconfig` is what enforces it, verified by injecting each of the four (all exit 2 at `typecheck`).

| Module | Owns |
|---|---|
| `routes` | L1 prefixes, the single login page, probes, segment-aware `isPathUnder`, and the reserved `api` segment as the first segment below a prefix (`/_site/api` is not a page; `/_site/api-docs` is). Percent-escapes are decoded before classification, so an encoded prefix fails closed |
| `errors` | 25 HTTP codes with their statuses + 4 internal (job/startup) codes + `ErrorEnvelope` |
| `pagination` | `parsePagination` / `buildPageMeta` — page 1, limit 25, ceiling 100; out-of-range **clamped**, non-decimal input ignored, offset always a safe integer |
| `license` | ODbL 1.0 + "© OpenStreetMap contributors" + Geofabrik, and the list/detail response blocks |
| `constants` | `mm_` token format, sort fields, and the 9 vocabularies the DB types mirror |

Both apps consume it in real code, not in a re-export: `apps/api/src/config/prefixes.ts` is what
`requiresAdminToken` will key the L2 guard on, and `apps/web/src/router/paths.ts` is the table the router
law test walks. Zod schemas are **additive** and arrive with the API contract tasks.

## 9. Code conventions

Formatting and linting are enforced by configuration, not by review comments:

| Tool | Config | What it enforces |
|---|---|---|
| Prettier | `prettier.config.js` | 100 columns, single quotes, trailing commas, LF. Markdown is **excluded** (`.prettierignore`): hand-authored tables would be rewritten into padded columns for no rendering benefit |
| ESLint | `eslint.config.js` | `js` + `typescript-eslint` type-checked (`projectService`) + `eslint-plugin-vue`, then `eslint-config-prettier` last so the two never disagree |
| Editor | `.editorconfig` | UTF-8, LF, 2-space indent, final newline |

Project-specific lint rules that encode the laws: `@typescript-eslint/no-floating-promises` and
`no-misused-promises` (09 §9), `consistent-type-imports`, `switch-exhaustiveness-check`,
`no-explicit-any` (ENG-2), `vue/no-v-html` (D-13), `vue/component-api-style: script-setup` (09 §9)
and `vue/define-{props,emits}-declaration: type-based`.

`.vue` files are linted but **not type-checked** until `vue-tsc` replaces the web `typecheck` script in
`P1-WEB-01`; the reason is in `apps/web/tsconfig.json`.


- **Layering:** route handler → service → repository. No SQL in handlers, no HTTP in services.
- **Validation:** Zod schema in `packages/shared` → Fastify `schema` → handler receives typed input.
- **Errors:** throw `AppError` subclasses; never `throw new Error` for expected failures.
- **Async:** no floating promises; use the shared `withTimeout` helper for network calls.
- **Logging:** structured fields (`{ countryId, jobId, bytes }`), no string interpolation of user input.
- **JSDoc:** every exported function/type has a one-line summary + `@throws` where relevant.
- **Vue:** `<script setup lang="ts">`, composables over mixins, Pinia stores per domain, Vuetify
  components only (no raw HTML styling beyond layout), tokens from the theme.
- **Commits:** conventional (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), one logical change each.

## 10. Adding a feature (checklist)

1. Read the relevant requirement IDs in `PROMPT.md` and the task in `08-tasks.md`.
2. Update `04-api.md` with the endpoint/fields (docs first).
3. Add/extend the Zod schema in `packages/shared`.
4. Implement service + repository + route; add the guard-sensitive test.
5. Update `03-data-model.md` if the schema changes; write a migration.
6. Build the UI states: loading / empty / error / success.
7. Add tests (unit + integration + component as applicable).
8. `bun run check`; update docs; tick the task; commit.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| API exits at boot with `INVALID_ENV` | Missing/invalid env var | Read the message; check `.env` |
| `401` on every admin call | Token expired (`AUTH_TOKEN_TTL_HOURS`) | Log in again |
| `503 DISK_FULL` | Free space < reserve | Free space or lower `DISK_RESERVE_BYTES` |
| Download stalls at 0 bytes | Source unreachable / proxy blocks egress | `curl -I` the Geofabrik URL from the container |
| Catalog empty | Never synced | `POST /_admin/api/catalog/sync` or `bun run sync:catalog` |
| Public page shows nothing | No country published | Publish a cached country |
| `readyz` 503 | DB unreachable | `docker compose ps`, check `db` health |
| Port 8080 busy | Another service | Change the host port mapping in `compose.yaml` |
