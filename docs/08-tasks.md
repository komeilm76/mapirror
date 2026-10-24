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
| P1-REPO-01 | Bun workspaces (`apps/api`, `apps/web`, `packages/shared`) | ENG-1 | P0-09 | ✅ | `bun install` links all three; `bun run check:workspaces` asserts private + named + naming convention + `workspace:*` + per-workspace typecheck + real resolution (20 checks; failure paths verified) |
| P1-REPO-02 | `tsconfig.base.json` strict + per-package extends | ENG-2 | P1-REPO-01 | ✅ | `bun run typecheck` passes (root scripts + 3 packages); strictness proved by probes: `noUncheckedIndexedAccess` caught `items[0]`, `noImplicitAny` caught an untyped param, web correctly excludes Bun types, api resolves `@mapirror/shared`, and `packages/shared` has no runtime types so a stray `Bun.*` cannot leak into the browser bundle |
| P1-REPO-03 | ESLint flat + Prettier + Vue plugin | ENG-3 | P1-REPO-01 | ✅ | `bun run lint` (zero warnings) and `format:check` clean; probes confirmed `.ts` and `.vue` are both linted — floating promise, loose `==`, unused var and `v-html` each fail with exit 1 — and template-only variables are **not** false-flagged |
| P1-REPO-04 | Vitest workspace (api/web/shared) | ENG-4 | P1-REPO-01 | ⬜ | `bun run test` runs 3 projects |
| P1-REPO-05 | `bun run check` aggregate script | ENG-3 | P1-REPO-02/03/04 | ⬜ | One command = typecheck+lint+format+test |
| P1-REPO-06 | `.gitignore`, `.dockerignore`, `.editorconfig`, `.env.example` | DOCK-3 | P1-REPO-01 | ⬜ | No `node_modules`, `data/`, `.env`, `dist/` in git |
| P1-REPO-07 | `packages/shared` primitives (prefixes, error codes, pagination, license) | L1, ENG-2 | P1-REPO-02 | ⬜ | Consumed by both apps, unit-tested |

### API foundation

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P1-API-01 | Fastify bootstrap (`app.ts`, `server.ts`) with plugin order | ENG-5 | P1-REPO-01 | ⬜ | Server starts, routes registered under 3 prefixes |
| P1-API-02 | Zod env validation + typed config | ENG-2, L5 | P1-API-01 | ⬜ | Missing/invalid env → clear startup error, exit 1 |
| P1-API-03 | Pino logger with secret redaction + request ids | ENG-5, L9 | P1-API-01 | ⬜ | `authorization`/`password` never appear in logs (test) |
| P1-API-04 | Error taxonomy + JSON envelope + 404/500 handlers | ENG-5 | P1-API-01 | ⬜ | Every handler error maps to documented code |
| P1-API-05 | Security plugin (headers, CORS, body limit) | ENG-6 | P1-API-01 | ⬜ | Headers asserted in test; no `*` CORS in prod |
| P1-API-06 | DB plugin (Kysely) + graceful shutdown | ENG-5 | P1-API-01 | ⬜ | SIGTERM drains requests, closes pool |
| P1-API-07 | `/healthz` + `/readyz` | DOCK-1 | P1-API-06 | ⬜ | readyz fails when DB unreachable |
| P1-API-08 | Route-law test (L1, L2, L3) | L1…L3 | P1-API-04 | ⬜ | Fails if an API escapes its prefix, a page escapes `/_site/`, or an admin API is unauthenticated |
| P1-API-09 | Rate-limit plugin (login + public) | ENG-6 | P1-API-01 | ⬜ | 429 with `retry-after` after threshold |

### Database

| ID | Task | Req | Dep | Status | Acceptance |
|---|---|---|---|---|---|
| P1-DB-01 | Kysely migrator + `0001_init.sql` (admins, tokens, settings, audit) | ENG-2 | P1-API-06 | ⬜ | Fresh DB → migrate → tables + indexes exist |
| P1-DB-02 | `schema.ts` Kysely types for phase-1 tables | ENG-2 | P1-DB-01 | ⬜ | No `any` in repositories |
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
| P1-DOCK-05 | `compose.yaml` (db, api, web, volumes, healthchecks) | DOCK-1/2 | P1-DOCK-01…04 | ⬜ | `docker compose up -d` green on Ubuntu 24.04 |
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
