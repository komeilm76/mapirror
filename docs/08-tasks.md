# 08 — Tasks

**TL;DR** — 136 tasks across 7 phases, each with requirement ID, dependencies and a testable acceptance criterion; the traceability matrix at the bottom maps every requirement to its tasks.

Single task board for the whole build. Status: ⬜ todo · 🟨 in progress · 🟦 in review · ✅ done ·
⛔ blocked. Update this file at the **start** of a phase (claim) and at the **end** (close).

Legend: `Req` maps back to `PROMPT.md` §6–§16 requirement IDs. `Dep` = must be done first.

---

## Phase 0 — Documentation

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P0-01 | Approve build prompt (v1.1 + D-1…D-17) | — | — | ✅ | Owner confirmed all 16 decisions |
| P0-02 | Overview + architecture docs | — | P0-01 | ✅ | `01`, `02` written and cross-linked |
| P0-03 | Data model + ERD + DDL draft | ENG-2 | P0-02 | ✅ | `03` covers every table and invariant |
| P0-04 | API contract for all three namespaces | AUTH, CACHE, PUB, INT, UPD | P0-03 | ✅ | `04` lists every endpoint with errors |
| P0-05 | Flows + diagrams | — | P0-03 | ✅ | `05`, `06` cover F1–F12 and 11 diagrams |
| P0-06 | Roadmap + tasks | — | P0-02 | ✅ | `07`, `08` complete |
| P0-07 | Dev guide, laws, project tree | ENG-1…8 | P0-02 | ✅ | `09`, `10`, `11` complete |
| P0-08 | Deployment, UI/UX, security, ADRs | DOCK, UX, SEC | P0-04 | ✅ | `12`–`15` complete |
| P0-09 | Owner approves documentation | — | P0-01…08 | ✅ | Approved and released as `v0.1.0` — Phase 1 unblocked |

---

## Phase 1 — Foundation

### Repo & tooling

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P1-REPO-01 | Bun workspaces (`apps/api`, `apps/web`, `packages/shared`) | ENG-1 | P0-09 | ✅ | `bun install` links all three; `bun run check:workspaces` asserts private + named + naming convention + `workspace:*` + per-workspace typecheck + real resolution from **both** apps (22 checks; failure paths verified) |
| P1-REPO-02 | `tsconfig.base.json` strict + per-package extends | ENG-2 | P1-REPO-01 | ✅ | `bun run typecheck` passes (root scripts + 3 packages); strictness proved by probes: `noUncheckedIndexedAccess` caught `items[0]`, `noImplicitAny` caught an untyped param, web correctly excludes Bun types, api resolves `@mapirror/shared`, and `packages/shared` has no runtime types so a stray `Bun.*` cannot leak into the browser bundle |
| P1-REPO-03 | ESLint flat + Prettier + Vue plugin | ENG-3 | P1-REPO-01 | ✅ | `bun run lint` (zero warnings) and `format:check` clean; probes confirmed `.ts` and `.vue` are both linted — floating promise, loose `==`, unused var and `v-html` each fail with exit 1 — and template-only variables are **not** false-flagged |
| P1-REPO-04 | Vitest workspace (api/web/shared) | ENG-4 | P1-REPO-01 | ✅ | `bun run test` runs 4 projects (3 files / 7 tests green) — `shared`/`api`/`scripts` in node, `web` in jsdom; both `*.spec.ts` and `*.test.ts` are collected, so the specification's `law-*.test.ts` names cannot be skipped; per-project scripts work; coverage thresholds verified to fail an uncovered file; the empty-report trap fixed (barrel files were excluded) |
| P1-REPO-05 | `bun run check` aggregate script | ENG-3 | P1-REPO-02/03/04 | ✅ | One command = workspaces+hygiene+typecheck+lint+format:check+test, fail-fast; each of the six stages verified to fail the gate on its own (exit 1/2) and the clean tree exits 0 |
| P1-REPO-06 | `.gitignore`, `.dockerignore`, `.editorconfig`, `.env.example` | DOCK-3 | P1-REPO-01 | ✅ | No `node_modules`, `data/`, `.env`, `dist/` in git — enforced, not promised: `check:hygiene` (54 assertions) proves 10 paths ignored / 10 kept, that zero ignored artefacts are tracked (asked of git, not of a copied rule list), that `.env.example` ↔ `docs/09` §5 match on **names and defaults** in both directions (32 vars), that both ignore files cover the same credential shapes, that `.dockerignore` drops secrets but keeps `package.json`, `bun.lock`, `tsconfig*.json`, `apps/`, `packages/`, `scripts/`, `docker/` (last-match-wins, so a `!` line cannot fake it), and that no test file escapes the Vitest projects; wired into `check` as stage 2 |
| P1-REPO-07 | `packages/shared` primitives (prefixes, error codes, pagination, license) | L1, ENG-2 | P1-REPO-02 | ✅ | Consumed by both apps, unit-tested: `routes` (segment-aware prefix law + reserved `api` segment), `errors` (25 codes → statuses, plus 4 internal codes), `pagination` (defaults, clamping, `meta`), `license` (ODbL attribution), `constants` (token format + 9 vocabularies). Both apps consume it in real code — `apps/api/src/config/prefixes.ts` (the guard's classification) and `apps/web/src/router/paths.ts` (the page table) — and both declare `workspace:*`; `check:workspaces` proves resolution from each consumer. 96 tests / 11 files, 100 % statements+branches+functions+lines on every module that has code. Probes: changing a prefix, adding an undocumented code, changing a status, adding an enum value, mounting a page under `/_admin/api` and altering the token length each fail at the intended test |

### API foundation

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P1-API-01 | Fastify bootstrap (`app.ts`, `server.ts`) with plugin order | ENG-5 | P1-REPO-01 | ✅ | Server starts, routes registered under 3 prefixes — proven end to end (real process on an ephemeral port: `503` at the three contract paths, `404` at `/`, `/healthz`, `/_site/`; `SIGTERM` and `SIGINT` exit 0). The pipeline is an ordered array (`plugins/order.ts`) iterated by `buildApp`, so order cannot drift; empty slots name the task that fills them. The build returns a **booted** app (`registerPipeline` queues every slot, then awaits `ready()` once — awaiting per plugin would boot the instance and throw on the second plugin). L1 is enforced at boot: an `onRoute` hook records offending routes and the boot is refused after `ready()` (probed end to end: `/_site/leak` + `/api/also-leak` registered by a plugin → exit 1 in 0 s, both named; throwing from the hook would hang `ready()` forever, and both are covered by tests rather than a probe: `buildApp` takes a tests-only `slots` override so the guard is exercised through the real build path). Shutdown is bounded at 8 s (< Docker's 10 s grace) and a second signal is ignored. Stubs live at their **real** contract paths and are asserted as a set, so one cannot be forgotten. 150 tests / 14 files, coverage 93.8%; port parsing was later folded into the validated config (`P1-API-02`) |
| P1-API-02 | Zod env validation + typed config | ENG-2, L5 | P1-API-01 | ✅ | `apps/api/src/config/env.ts` is the only reader of `process.env`: one Zod schema for all 32 documented variables, transformed into a frozen, typed, camelCase `AppConfig`. Probed on the real process — `NODE_ENV=production` without `DATABASE_URL` → exit 1, `PORT=0x10` → exit 1, three bad values → one message listing all three — and the valid path still boots, serves `503`, and exits 0 on SIGTERM. Rules that the code states rather than inherits: **absent → documented default, present but unusable → stop** (the old `readPort` silently bound 3000 for `PORT=0x10`); digits-only numbers, so `30e3` and hex never become ports or pool sizes; flags accept exactly `true`/`false`, never `yes`/`1`; `CORS_ORIGINS` splits to a list and refuses `*`; `ADMIN_PASSWORD`/`POSTGRES_PASSWORD` and their `_FILE` twins are mutually exclusive; `DATABASE_URL` is required only in production. Errors name variables, never values, and `toJSON` masks the DSN password and the admin password, so a `console.log(config)` cannot leak them. A test keeps the schema, `.env.example` and the §5 table describing the same variable set. 180 tests / 14 files, coverage 94.5% |
| P1-API-03 | Pino logger with secret redaction + request ids | ENG-5, L9 | P1-API-01 | ✅ | Redaction is applied at the logger level (`lib/logger.ts`), so no call site can opt out: `authorization`, `password`, `token`, `cookie` and the header-shaped variants (`*.headers.*`, `req.headers.*`, `*.headers.set-cookie`) are censored at depths 0–2, and `withRedaction` re-adds the list to any logger a caller configures — including a bare `logger: true`, the one setting that would otherwise log without it. Proven by capturing real output, not by inspecting config: a logged `{password}`, `{data:{user:{token}}}` and a header dump contain `[redacted]` and none of the values, while a harmless sibling field survives. Request ids: UUIDv4 from `genReqId`, validated inbound `x-request-id` (8–64 chars of `[A-Za-z0-9._-]`) so a caller cannot inject newlines or megabytes into the log, `requestIdHeader` disabled so there is no second unvalidated path. Probed on the real process: header id = envelope id = `reqId` in every log line, and a request carrying `Authorization`, `Cookie` and a password body left **0** secrets in the log. **Found while implementing it:** pipeline stages were registered as plugins, so their hooks were encapsulated away — slot 1's header was missing from every response (see `16-changelog.md` pass 10). 207 tests / 16 files, coverage 94.7% |
| P1-API-04 | Error taxonomy + JSON envelope + 404/500 handlers | ENG-5 | P1-API-01 | ✅ | Slot 2 installs `setErrorHandler`/`setNotFoundHandler` on the root instance, so no route can answer in Fastify's default shape. `lib/errors.ts` owns `AppError` and the mapping: **every** code in `ERROR_STATUS` is swept by a test that asserts the documented status, and the client-caused cases map from codes read off a running instance rather than guessed (`FST_ERR_CTP_INVALID_JSON_BODY`/`EMPTY_JSON_BODY`→`BAD_REQUEST`, `INVALID_MEDIA_TYPE`→`UNSUPPORTED_FORMAT`, `BODY_TOO_LARGE`→`FILE_TOO_LARGE`, unknown 4xx→`BAD_REQUEST`, everything else→`INTERNAL_ERROR`). A `ZodError` becomes `VALIDATION_ERROR` with `details.issues[{path,message}]`; an unknown path or a wrong method is `404 NOT_FOUND` with no route-table hint. A `500` says one fixed sentence — no stack, no driver text — while the exception goes to the log. Probed on the real process: 500/404/415 all returned the envelope with `x-request-id`, and **0** occurrences of the DSN password that the throwing handler's message contained (see `16-changelog.md` pass 11). 229 tests / 17 files, coverage 95.1% |
| P1-API-05 | Security plugin (headers, CORS, body limit) | ENG-6 | P1-API-01 | ✅ | Slot 3 sets the six headers of `14-security.md` §6 on **every** response — a test parses that document and asserts the values are identical, so the code cannot drift from what a reviewer signed off. `script-src` has no `unsafe-inline`/`unsafe-eval` (`style-src` is the documented Vuetify relaxation); HSTS is left to the TLS proxy, as the document says. CORS: same-origin by default, allow-list from `CORS_ORIGINS`, `*` filtered twice (config refuses it, the stage filters it), `Vary: Origin` always. Preflight from an unlisted origin → `403 FORBIDDEN`; an actual request is served without ACAO. The preflight is a hook, not a route, because an `OPTIONS /*` route would violate L1. JSON body limit 1 MB as an instance option → `413 FILE_TOO_LARGE` with the envelope and headers intact. Probed on the real process: all headers present, allowed preflight `204`, foreign preflight `403`, foreign request `503` with no ACAO, 1.5 MB body `413`. **Found by probe:** the first version refused unlisted origins on *actual* requests too, which `403`d the SPA's own login POST (browsers send `Origin` on same-origin POSTs) — see `16-changelog.md` pass 12. **Pass 13 added the client-identity boundary this stage depends on:** `TRUST_PROXY` (default `loopback`) is handed to Fastify, because without it every client behind the documented proxy shares the proxy's address — per-IP limits would become one global bucket and hashed download IPs identical; hop counts and `true` are refused at boot because Fastify silently trusts nothing for a number. Also from pass 13: `access-control-expose-headers: x-request-id`, and a socket-level `clientErrorHandler` so a malformed request answers the documented envelope instead of Fastify's `{"error":"Bad Request"}`. 260 tests / 19 files, coverage 95.6% |
| P1-API-06 | DB plugin (Kysely) + graceful shutdown | ENG-5 | P1-API-01 | ✅ | Slot 4 decorates the instance with `app.db` — a `SqlDatabase` (`Kysely<Database>` + `close()` + `check()`), created from `config.databaseUrl` or adopted when the build was handed one — and pings it **once, in `onReady`**, so a server that starts and then 500s is impossible: an unreachable database exits `1` with `DB_UNAVAILABLE` (`pg` connects lazily, so a DSN typo surfaces at the first query and nowhere else). Verified against a **real PostgreSQL 16.2** (8 integration tests, skipped with a stated reason when no server answers; `DATABASE_URL_TEST`): `select 1` round-trip, a scratch table's `23505` unique violation, a rolled-back transaction, a full-pipeline boot, and a killed backend socket that the pool survives — without the pool's `error` listener that arrives as an unhandled `57P01` that would end the process on any database restart (mutation-checked). Shutdown: `onClose` closes the pool, exactly once even if `close()` is called twice, and only after in-flight requests drain. Probed on the real process with a live database: connections `0 → 1 → 0` across `SIGTERM` (exit 0); DSN on a dead port → exit 1, `DB_UNAVAILABLE`, no host or password in the client-facing message. **Found before commit:** `buildApp` accepted a `database` option and dropped it (the stage opened a real pool against the default DSN instead — invisible to every test that passed its own handle), and a failed boot never closed the pool it had opened, leaking `DB_POOL_MAX` connections per supervisor retry (see `16-changelog.md` pass 14). 277 tests / 21 files, coverage 95.7% |
| P1-API-07 | `/healthz` + `/readyz` | DOCK-1 | P1-API-06 | ✅ | Two probes with two jobs, and the split is the deliverable: `/healthz` answers `200 {"status":"ok"}` and touches **nothing** — a liveness check that pings Postgres restarts a healthy API every time the database blinks — while `/readyz` runs `select 1` and a real `CACHE_DIR` write (create, write, remove; the directory is created if missing) concurrently, each bounded at 2 s, and answers `503` naming the failing checks. Probed end to end against a real PostgreSQL: with the database up `200 {database:ok,cache:ok}`; `pg_ctl stop` → `/healthz` still `200` and `/readyz` `503 {database:fail}`; `pg_ctl start` → `200` again **without a process restart**; `CACHE_DIR` pointing at a file → `503 {cache:fail}` while the database stays `ok`. Bodies name checks only (a driver message can carry the DSN); the reason is logged at `warn` with the request id, one line per failing check. `cache-control: no-store` so a proxy cannot replay a stale `200`; no credentials and no rate limit by design (`14-security.md` §7); `GET`/`HEAD` only, and `/healthz/` is `404` — the route-law allow-list already covered the exact paths. **Two defects found and fixed here** (see `16-changelog.md` pass 15): a check that reported failure by *returning* `'fail'` was read as success, so an unwritable cache volume reported healthy; and a check that threw synchronously (a closed pool does) escaped the timeout race and answered `500 INTERNAL_ERROR` instead of `503`. Review pass 16 then fixed three follow-ups of the same family: a boot refused by the route law leaked the pool (the pass-14 cleanup guard covered only a failed `onReady`), a connection lost while idle was discarded with no log line, and a killed probe could leave a uniquely named file in `CACHE_DIR` forever. 292 tests / 22 files, coverage 96.0% |
| P1-API-08 | Route-law test (L1, L2, L3) | L1…L3 | P1-API-04 | ⬜ | Fails if an API escapes its prefix, a page escapes `/_site/`, or an admin API is unauthenticated |
| P1-API-09 | Rate-limit plugin (login + public) | ENG-6 | P1-API-01 | ⬜ | 429 with `retry-after` after threshold |

### Database

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P1-DB-01 | Kysely migrator + `0001_init.sql` (admins, tokens, settings, audit) | ENG-2 | P1-API-06 | ✅ | Fresh database → `bun run db:migrate` → `0001_init` applied, `admins`, `admin_tokens`, `settings`, `audit_logs` and the five documented indexes present, `pg_trgm` installed. Migrations are plain `NNNN_name.sql` files driven by Kysely's migrator (`db/migrator.ts`), so ordering and the one-transaction-per-migration guarantee come from a library; the file name is a rule — `init.sql`, `1_init.sql`, a duplicate `0001` or a directory named like a migration stop the run and name the file, because a silently skipped migration is a schema missing tables and nobody noticing. `0001_init.sql` creates `pg_trgm` (mandatory: the phase-2 trigram search index needs it) and `unaccent` inside a `DO` block, so a server without that contrib module warns instead of refusing to migrate. **Verified on a database created for each test** (the suite makes its own `CREATE DATABASE`, so "fresh" is real, and skips with a reason where the role lacks `CREATEDB`): objects created, second run a no-op, `--reset` re-applies, case-insensitive username uniqueness, the 32-byte `token_hash` CHECK, `ON DELETE CASCADE` to tokens against `SET NULL` on the audit actor, and a failing migration that is **not** recorded as applied so a fixed rerun retries it. Two corrections to assumption, both measured: Kysely does **not** throw on `migrateDown()` for an up-only migration (it reports `NotExecuted` and changes nothing — pinned by a test), and a migration file is executed as one raw batch, so `DO $$ … $$` blocks survive. `bun run db:migrate` / `db:reset` (refuses `NODE_ENV=production` before opening a connection); a test parses `03-data-model.md` §2.1/§2.2/§2.11 in **both** directions so the SQL and the document cannot drift. 322 tests / 25 files, coverage 96.3% |
| P1-DB-02 | `schema.ts` Kysely types for phase-1 tables | ENG-2 | P1-DB-01 | ✅ | `apps/api/src/db/schema.ts` declares `Admins`, `AdminTokens`, `Settings` and `AuditLogs` and the `Database` map `client.ts` now re-exports, so the empty interface from `P1-API-06` is gone. **Every select type was measured against the driver, not inferred from the SQL type** — the table is in the module comment: `bigserial`/`bigint` arrive as **string** (`pg` returns int8 as text), `timestamptz` as `Date`, `bytea` as `Buffer`, `jsonb` parsed, `inet` as `string`. `audit_logs.id` is therefore `string`, which is the one a hand-written type gets wrong and then compares numerically; the runtime round-trip test asserts `typeof id === 'string'` against a real server. Ids are `GeneratedAlways` (insert type `never`), because supplying a serial id is how a sequence desyncs and the collision surfaces later, elsewhere. Guarantees: an unknown table or column is a compile error (`@ts-expect-error`-pinned), and a scan with comments stripped proves no `any` anywhere under `src/db` — where `repositories/` will live. Three-way check on a freshly migrated database: `information_schema` columns and nullability equal `03-data-model.md` §2.1/§2.2/§2.11, and the interface properties equal the database columns **in both directions**, so a column added in SQL only or in TypeScript only fails. Mutation-verified: `user_agent text NOT NULL` in SQL only fails 3 tests, an interface-only column fails 1, a renamed property fails 1, an `any` fails 1, and `id: Generated<number>` fails `tsc`. Counts: 334 tests / 27 files, coverage 96.3% |
| P1-DB-03 | Pool settings + transaction helper | ENG-5 | P1-API-06 | ⬜ | Rollback test passes |
| P1-DB-04 | Migration-on-boot + count check | ENG-5 | P1-DB-01 | ⬜ | Skew detected and logged at startup |

### Auth

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P1-AUTH-01 | Argon2id hashing + password policy | AUTH-5 | P1-DB-01 | ⬜ | ≥12 chars enforced; hash verified |
| P1-AUTH-02 | Token service (issue/hash/verify/revoke) | AUTH-3, D-3 | P1-DB-01 | ⬜ | Only hash stored; constant-time compare |
| P1-AUTH-03 | `POST /_auth/api/login` + throttling + audit | AUTH-2 | P1-AUTH-01/02 | ⬜ | Generic 401, lockout after N failures |
| P1-AUTH-04 | `GET /_auth/api/me`, `POST /_auth/api/logout` | AUTH-3 | P1-AUTH-02 | ⬜ | Logout revokes only presented token |
| P1-AUTH-05 | Bearer guard plugin for `/_admin/api/*` | AUTH-3, L2 | P1-AUTH-02 | ⬜ | Deny by default, no opt-out |
| P1-AUTH-06 | `init-admin.ts` launch script | AUTH-1 | P1-AUTH-01 | ⬜ | Idempotent; env/file/prompt; never echoes |
| P1-AUTH-07 | `reset-admin-password.ts` (incl. `--generate`) | AUTH-4 | P1-AUTH-01/02 | ⬜ | Revokes all tokens; audit row written |
| P1-AUTH-08 | Auth tests (positive + negative matrix) | AUTH-1…5 | P1-AUTH-03…07 | ⬜ | Expired/revoked/cookie/query-token all rejected |

### Docker

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P1-DOCK-01 | `api.Dockerfile` multi-stage, non-root | DOCK-3 | P1-API-01 | ⬜ | Image builds; runs as non-root |
| P1-DOCK-02 | `web.Dockerfile` (Vite build → nginx) | DOCK-1 | P1-REPO-01 | ⬜ | Static build served by nginx |
| P1-DOCK-03 | `nginx.conf` (SPA fallback, proxy, timeouts) | DOCK-4 | P1-DOCK-02 | ⬜ | Deep links work; API proxied |
| P1-DOCK-04 | `entrypoint.api.sh` (wait → migrate → init-admin → start) | DOCK-2 | P1-AUTH-06, P1-DB-01 | ⬜ | Clean start needs zero manual steps |
| P1-DOCK-05 | `compose.yaml` (db, api, web, volumes, healthchecks) | DOCK-1/2 | P1-DOCK-01…04 | ⬜ | `docker compose up -d` green on Ubuntu 24.04; `DATABASE_URL` **derived** from `POSTGRES_PASSWORD` + `db` (changing the password alone must still connect — no second copy of the DSN), `CACHE_DIR`/`TMP_DIR` bound to the `/data` volumes, `cp .env.example .env` works untouched |
| P1-DOCK-06 | `Makefile` (up/down/logs/migrate/test/reset-admin) | DOCK-5 | P1-DOCK-05 | ⬜ | Each target documented and working |

### Web foundation

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P1-WEB-01 | Vite + Vue + Vuetify + Pinia + VueUse wiring | stack | P1-REPO-01 | ⬜ | App boots, HMR works |
| P1-WEB-02 | Design tokens + Vuetify themes (dark admin / light public) | UX-1/2 | P1-WEB-01 | ⬜ | No hardcoded hex in components |
| P1-WEB-03 | Router tree + auth guard | L1, D-13 | P1-WEB-01 | ⬜ | Unauthenticated `/_site/admin/*` → `/_auth/login` |
| P1-WEB-04 | `useApi` composable (Bearer, envelope, 401 handling) | D-13 | P1-WEB-03 | ⬜ | Single error path; toast + redirect |
| P1-WEB-05 | Auth store (sessionStorage) | D-13 | P1-WEB-04 | ⬜ | Refresh keeps session; logout clears |
| P1-WEB-06 | Login page (validated form, show/hide, error state) | AUTH-2, UX-3 | P1-WEB-05 | ⬜ | Keyboard + Enter works, error is human |
| P1-WEB-07 | Admin layout shell (sidebar, topbar, user menu, breadcrumbs) | UX-1/5 | P1-WEB-03 | ⬜ | Responsive to 360 px (drawer) |
| P1-WEB-08 | Dev proxy config for `/_auth`, `/_admin`, `/_public` | ENG-1 | P1-WEB-01 | ⬜ | `bun run dev` talks to local API |

**Phase 1 gate:** clean-machine `docker compose up`, login, empty dashboard, `check` green, law tests
prove L1–L3.

---

## Phase 2 — Catalog, cache, versions

### Source adapter

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P2-SRC-01 | `MapSource` interface (4 methods, JSDoc) | D-1 | P1-API-01 | ⬜ | No speculative abstraction |
| P2-SRC-02 | Geofabrik index client (`index-v1-nogeom.json`) | GEO-1 | P2-SRC-01 | ⬜ | Parses id/parent/name/iso/pbf; Zod-validated |
| P2-SRC-03 | Region page parser (dated snapshots, sizes, "data up to") | GEO-4, UPD-1 | P2-SRC-02 | ⬜ | Fixtures: 3 regions, incl. region with no sub-regions |
| P2-SRC-04 | `HEAD` metadata (size, etag, last-modified) + `.md5` fetch | CACHE-1 | P2-SRC-02 | ⬜ | Timeouts + retries bounded |
| P2-SRC-05 | Slug derivation + collision resolution | ENG-6, L6 | P2-SRC-02 | ⬜ | `europe/finland`→`finland`; collisions tested |
| P2-SRC-06 | Catalog sync job (upsert countries, TTL, audit) | GEO-1 | P2-SRC-02, P2-JOB-01 | ⬜ | Re-sync is idempotent; removals don't delete cache |

### DB & jobs

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P2-DB-01 | `0002_*` migration: countries, country_cache, map_versions, jobs | ENG-2 | P1-DB-01 | ⬜ | All indexes from `03` present |
| P2-DB-02 | Repositories for catalog/cache/versions | ENG-2 | P2-DB-01 | ⬜ | Pagination + search pushdown to SQL |
| P2-JOB-01 | Queue (`FOR UPDATE SKIP LOCKED`) + worker loop | D-11 | P2-DB-01 | ⬜ | Two workers never claim the same job |
| P2-JOB-02 | Heartbeat + advisory-lock reaper + retry/backoff | D-11 | P2-JOB-01 | ⬜ | Killed worker → job requeued within 5 min; a slow job holding its lock is never stolen |
| P2-JOB-03 | Progress reporting + cancellation | CACHE-1 | P2-JOB-01 | ⬜ | Cancel ≤ 2 s, `.part` removed |
| P2-JOB-04 | Disk preflight + reserve | CACHE-1 | P2-JOB-01 | ⬜ | `503 DISK_FULL` with required/free |
| P2-JOB-05 | Download handler (stream, Range resume, md5 verify, atomic rename) | CACHE-1 | P2-SRC-04, P2-JOB-03 | ⬜ | Byte-identical file; mismatch aborts cleanly |
| P2-JOB-06 | Storage module (paths, `.part`, unlink safety) | L6 | P2-DB-01 | ⬜ | Path traversal attempts impossible (test) |
| P2-JOB-07 | Uniqueness guard: one active download per (country, version) | CACHE-1 | P2-JOB-01 | ⬜ | Second request → 409 |

### Admin API

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P2-API-01 | `GET /_admin/api/catalog` (search/filters/pagination) | GEO-1/2 | P2-DB-02 | ⬜ | <300 ms at 400 rows; ISO + name search |
| P2-API-02 | `POST /_admin/api/catalog/sync` | GEO-1 | P2-SRC-06 | ⬜ | Idempotent job creation |
| P2-API-03 | `GET /catalog/regions/:slug` + `/snapshots` | GEO-4 | P2-SRC-03 | ⬜ | Unreachable source → `sourceReachable:false` |
| P2-API-04 | `POST /_admin/api/cache/downloads` (latest or explicit) | GEO-3/4 | P2-JOB-05 | ⬜ | 202 + jobId; 409 duplicates; 410 gone |
| P2-API-05 | `GET /_admin/api/cache` + `/:countryId` | CACHE-2 | P2-DB-02 | ⬜ | Includes active jobs + update state |
| P2-API-06 | `DELETE /_admin/api/cache/:countryId` (typed confirm) | CACHE-3 | P2-JOB-06 | ⬜ | 409 if job active; files removed; audited |
| P2-API-07 | Version list + `POST .../versions` (specific version) | CACHE-1/4 | P2-JOB-05 | ⬜ | Rejects `latest`, accepts only offered snapshots |
| P2-API-08 | `DELETE .../versions/:versionId` | CACHE-4 | P2-API-07 | ⬜ | Last version → cache row removed |
| P2-API-09 | Admin version download stream | CACHE-1 | P2-JOB-06 | ⬜ | Same headers as public; admin channel logged |
| P2-API-10 | Jobs endpoints (list/detail/cancel) | CACHE-1 | P2-JOB-03 | ⬜ | Progress monotonic, ETA sane |

### Admin UI

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P2-WEB-01 | Catalog page: search, continent filter, cache filter, table/cards | GEO-1 | P2-API-01 | ⬜ | Empty/loading/error states present |
| P2-WEB-02 | Download button only when uncached + source version picker | GEO-3/4 | P2-API-03/04 | ⬜ | Button hidden/disabled correctly; size/date shown |
| P2-WEB-03 | Cache table (size, versions, public state, updated) | CACHE-2 | P2-API-05 | ⬜ | Sortable, responsive |
| P2-WEB-04 | Country detail: versions table with download/delete | CACHE-2/4 | P2-API-07/08 | ⬜ | Confirm dialogs; optimistic refresh |
| P2-WEB-05 | Delete country dialog (type slug) | CACHE-3, L10 | P2-API-06 | ⬜ | Button disabled until slug matches |
| P2-WEB-06 | Job progress drawer (poll 2s, cancel, error detail) | CACHE-1 | P2-API-10 | ⬜ | Survives navigation; shows speed/ETA |
| P2-WEB-07 | Toasts + error mapping for documented codes | UX-3/6 | P1-WEB-04 | ⬜ | Every error code has human copy |

### Tests

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P2-TST-01 | Fixture HTTP server (serves pbf + md5 + region pages) | ENG-4 | P2-SRC-03 | ⬜ | No live network in CI |
| P2-TST-02 | Download suite (happy/resume/checksum/cancel/disk-full) | CACHE-1 | P2-JOB-05 | ⬜ | All five green |
| P2-TST-03 | Delete + uniqueness semantics | CACHE-3/4 | P2-API-06/08 | ⬜ | Invariants from `03` §3 hold |
| P2-TST-04 | Catalog/search query tests | GEO-1 | P2-API-01 | ⬜ | ISO, accent, partial matches |

**Phase 2 gate:** live country cached + verified, versions deletable, admin download works, tests green.

---

## Phase 3 — Public portal

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P3-API-01 | Public read model + `is_public` guard in one place | L8 | P2-API-05 | ⬜ | No public query bypasses the guard |
| P3-API-02 | `POST /_admin/api/cache/:countryId/public` + audit | PUB-1/2/4 | P3-API-01 | ⬜ | 422 without ready version |
| P3-API-03 | `GET /_public/api/countries` (+search/filter/pagination) | WEB-3a | P3-API-01 | ⬜ | Only published, only ready versions |
| P3-API-04 | `GET /_public/api/countries/:slug` + `/versions` | WEB-3b | P3-API-01 | ⬜ | No internal fields leaked |
| P3-API-05 | Public streaming download (Range/ETag/304/410) | WEB-3c | P2-API-09 | ⬜ | All header cases tested |
| P3-API-06 | `GET /_public/api/stats` + `download_events` recording | WEB-3d | P3-API-05 | ⬜ | Hashed IPs only |
| P3-API-07 | Public rate limiting | ENG-6 | P3-API-05 | ⬜ | 429 per IP per minute at request start |
| P3-WEB-01 | Public home: hero-free catalog, search, continent filter, cards | WEB-1 | P3-API-03 | ⬜ | LCP < 2.5 s, light theme |
| P3-WEB-02 | Country detail: versions, size, md5, license/attribution | WEB-2 | P3-API-04 | ⬜ | ODbL + Geofabrik attribution visible |
| P3-WEB-03 | Download button + copyable `curl` snippet | WEB-1/4 | P3-API-05 | ⬜ | Copy works, snippet verified |
| P3-WEB-04 | API docs page (endpoints, examples, error codes) | WEB-4 | P3-API-03…06 | ⬜ | Examples copy-paste runnable |
| P3-WEB-05 | Empty state (nothing published yet) + 404 page | UX-3 | P3-WEB-01 | ⬜ | Helpful, on-brand, no dead end |
| P3-WEB-06 | Public switch UI in admin (with immediate feedback) | PUB-1 | P3-API-02 | ⬜ | Optimistic + rollback on error |
| P3-TST-01 | Public visibility matrix tests | L8, D-9 | P3-API-03…05 | ⬜ | Unpublished ⇒ 404 everywhere |
| P3-TST-02 | Range/ETag/HEAD/304 tests | WEB-3c | P3-API-05 | ⬜ | RFC-correct responses |

**Phase 3 gate:** anonymous download works in browser + curl; unpublished is invisible; no leaks.

---

## Phase 4 — Import, intervals, updates

### Import

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P4-IMP-01 | `upload_sessions` table + staging in `/data/tmp` | §12 | P2-DB-01 | ⬜ | 24 h expiry cleanup |
| P4-IMP-02 | Multipart endpoint with validation (ext/magic/size/version) | §12 | P4-IMP-01 | ⬜ | 415/413/400 correct |
| P4-IMP-03 | Import job (checksum → install → ready) | §12 | P4-IMP-02, P2-JOB-06 | ⬜ | No `ready` row on failure |
| P4-IMP-04 | Duplicate rejection + explicit replace | D-10 | P4-IMP-03 | ⬜ | 409 then replace-with-confirm succeeds |
| P4-IMP-05 | Import form UI: file dropzone / country picker / version | §12, UX-3 | P4-IMP-02 | ⬜ | Exactly 3 fields; upload progress; job follow |

### Intervals

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P4-INT-01 | Schema: intervals, interval_countries, runs, run_items | INT-1 | P2-DB-01 | ⬜ | CHECK constraints from `03` |
| P4-INT-02 | Schedule math (`nextRunAt`, UTC, month-end) + unit tests | INT-4 | P4-INT-01 | ⬜ | Table-driven cases incl. Feb 28, leap year |
| P4-INT-03 | Scheduler loop: claim + run row + enqueue + `next_run_at` in one tx | INT-4 | P4-INT-02, P2-JOB-01 | ⬜ | Concurrent ticks never double-fire; a failed enqueue rolls back; an active previous run skips the occurrence |
| P4-INT-04 | Interval CRUD API + validation | INT-1 | P4-INT-01 | ⬜ | 422 on wrong shape (weekday for daily, etc.) |
| P4-INT-05 | Run-now + run history + per-country items | INT-3 | P4-INT-03 | ⬜ | `partial` state visible |
| P4-INT-06 | `only_if_changed` skip logic | INT-2 | P4-INT-05 | ⬜ | Unchanged source → skipped, no download |
| P4-INT-07 | Retention prune after successful update | D-7 | P2-API-07 | ⬜ | Keeps newest N, never 0 |
| P4-INT-08 | Intervals UI: list, form (frequency + multi-country), preview | INT-1, UX-3 | P4-INT-04 | ⬜ | Next 5 runs preview correct |
| P4-INT-09 | Run history UI + manual trigger | INT-3 | P4-INT-05 | ⬜ | Statuses + failure details readable |

### Update detection

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P4-UPD-01 | Compare source vs cached; persist state | UPD-1/4 | P2-SRC-03 | ⬜ | Three states, `unknown` honest |
| P4-UPD-02 | `POST .../check-update` + bulk job | UPD-1/3 | P4-UPD-01 | ⬜ | Bulk aggregates results |
| P4-UPD-03 | UI: check button per cached country + badge + update action | UPD-1/2 | P4-UPD-02 | ⬜ | Badge persists after reload |
| P4-UPD-04 | "Check all" action + dashboard counter | UPD-3 | P4-UPD-02 | ⬜ | Counter matches DB |
| P4-UPD-05 | Tests: newer/unchanged/unreachable/already-cached | UPD-1 | P4-UPD-01 | ⬜ | No false `up_to_date` |

**Phase 4 gate:** upload → version; interval fires with mocked clock; update badge + one-click update.

---

## Phase 5 — Monitoring, UI/UX, tests

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P5-MON-01 | Sampler (CPU/load/RAM/disk/cache size) every 10 s | MON-1 | P2-DB-01 | ⬜ | Growth bounded; failure tolerated |
| P5-MON-02 | `/system/metrics` with downsampling + `/system/status` | MON-1/2 | P5-MON-01 | ⬜ | Windows 5m/1h/24h/7d |
| P5-MON-03 | Charts: CPU, memory, disk, cache growth + window selector | MON-1 | P5-MON-02 | ⬜ | No-data state; accessible colors |
| P5-MON-04 | Dashboard widgets (counts, updates, jobs, disk headroom) | MON-2 | P5-MON-02 | ⬜ | Each widget links to its page |
| P5-MON-05 | Retention cleanup + orphan report | MON-1, L6 | P5-MON-01 | ⬜ | 7-day rollover verified |
| P5-UX-01 | State coverage audit (loading/empty/error/success) all screens | UX-3 | P2/P3/P4 UI | ⬜ | Checklist signed per screen |
| P5-UX-02 | Skeletons, spinners, optimistic updates, toasts | UX-3 | P5-UX-01 | ⬜ | No layout shift on load |
| P5-UX-03 | Responsive pass (360/768/1440), tables→cards | UX-5 | P2/P3 UI | ⬜ | Usable at 390 px |
| P5-UX-04 | A11y pass (contrast, focus, labels, keyboard, reduced motion) | UX-2 | P5-UX-01 | ⬜ | axe: 0 serious violations |
| P5-UX-05 | Typography/spacing consistency + icon audit (no emoji icons) | UX-1/4 | P1-WEB-02 | ⬜ | Tokens only |
| P5-UX-06 | Copy pass (human, actionable, error guidance) | UX-6 | all UI | ⬜ | Reviewed string by string |
| P5-UX-07 | Screenshot review + rubric scoring (light/dark × 2 sizes) | UX-7/9 | P5-UX-01…06 | ⬜ | ≥45/50 documented |
| P5-TST-01 | Core coverage ≥ 80 % (api services + shared + stores) | ENG-4 | all | ⬜ | Coverage report attached |
| P5-TST-02 | Component tests: catalog, cache table, dialogs, import, intervals | ENG-4 | all UI | ⬜ | Critical flows covered |
| P5-UX-08 | Performance pass (route lazy-load, bundle split, LCP) | UX-8 | P5-UX-02 | ⬜ | Public LCP < 2.5 s; budget documented |

**Phase 5 gate:** rubric ≥ 45/50, coverage ≥ 80 %, `check` green, screenshots attached.

---

## Phase 6 — Hardening & release

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P6-OPS-01 | Backup/restore script + drill (DB + cache manifest) | DOCK-5 | P1-DOCK-05 | ⬜ | Restore reproduces a working mirror |
| P6-OPS-02 | Upgrade path documented + tested (migrations forward) | DOCK-5 | all | ⬜ | vN → vN+1 without data loss |
| P6-OPS-03 | Disk-full + restart drills | DOCK-5 | P2-JOB-04 | ⬜ | Documented outcomes match behavior |
| P6-SEC-01 | Security checklist sign-off (`14-security.md`) | ENG-6 | all | ⬜ | Every item checked |
| P6-SEC-02 | Dependency audit + headers + rate-limit verification | ENG-6 | P1-API-05 | ⬜ | No high/critical |
| P6-PERF-01 | Load check: 1 GB+ download throughput, memory flat | UX-8 | P2-JOB-05 | ⬜ | No memory growth over 3 GB transfer |
| P6-DOC-01 | README quick start + deployment runbook verified on fresh VM | DOCK-2 | P6-OPS-01 | ⬜ | Zero undocumented steps |
| P6-DOC-02 | API examples re-verified, diagrams refreshed | L12 | all | ⬜ | Docs match code |
| P6-REL-01 | Version tag + changelog | L12 | P6-* | ⬜ | Tag on `arena/5a1becdd-mapirror` |

**Phase 6 gate:** clean Ubuntu 24.04 install from docs alone; backup/restore proven; security signed off.

---

## Traceability matrix (requirement → task)

| Req | Tasks |
|---|---|
| AUTH-1 | P1-AUTH-06, P1-DOCK-04 |
| AUTH-2 | P1-AUTH-03, P1-WEB-06 |
| AUTH-3 | P1-AUTH-02/05, P1-API-08 |
| AUTH-4 | P1-AUTH-07 |
| AUTH-5 | P1-AUTH-01/03, P6-SEC-01 |
| GEO-1 | P2-SRC-02/06, P2-API-01/02, P2-WEB-01 |
| GEO-2 | P2-API-01, P2-WEB-01 |
| GEO-3 | P2-API-04, P2-WEB-02 |
| GEO-4 | P2-SRC-03, P2-API-03/04/07, P2-WEB-02 |
| CACHE-1 | P2-JOB-03/04/05, P2-API-04/07/09/10, P2-WEB-06 |
| CACHE-2 | P2-API-05, P2-WEB-03/04 |
| CACHE-3 | P2-API-06, P2-WEB-05 |
| CACHE-4 | P2-API-07/08, P2-WEB-04 |
| CACHE-5 | P2-JOB-06, P5-MON-05 |
| PUB-1…4 | P3-API-02, P3-WEB-06 |
| INT-1…5 | P4-INT-01…09 |
| UPD-1…4 | P4-UPD-01…05 |
| §12 Import | P4-IMP-01…05 |
| WEB-1…4 | P3-API-03…07, P3-WEB-01…05 |
| MON-1…3 | P5-MON-01…05 |
| UX-1…9 | P1-WEB-02, P5-UX-01…08 |
| DOCK-1…5 | P1-DOCK-01…06, P6-OPS-01/02 |
| ENG-1…8 | P1-REPO-*, P1-API-*, P5-TST-*, P6-DOC-* |
