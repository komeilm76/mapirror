# 07 — Roadmap

Seven phases from empty repository to a verified deployment. Each phase has an **exit gate**: the
next phase does not start until the gate passes and you have reviewed the report.

| Phase | Scope | Gate |
|---|---|---|
| 0 | Documentation | Docs approved |
| 1 | Skeleton, Docker, auth, admin shell | Login works from a clean `compose up` |
| 2 | Catalog, cache engine, versions | A real country cached, verified, deletable |
| 3 | Public portal | Anonymous download works; nothing leaks |
| 4 | Import, intervals, update detection | Upload, scheduled run, update badge |
| 5 | Monitoring, UI/UX, tests | Rubric ≥ 45/50, coverage ≥ 80 % |
| 6 | Hardening & release | Fresh Ubuntu 24.04 deploy + restore drill |

---

## Phase 0 — Documentation ✅ released `v0.1.0`

**Goal:** agree on the plan before writing code.

**Deliverables:** this `docs/` set — overview, architecture, data model, API contract, flows,
diagrams, roadmap, tasks, dev guide, laws, tree, deployment, UI/UX, security, ADRs.

**Exit gate:** you approve the docs (or request changes). Nothing is implemented before that.

---

## Phase 1 — Foundation: repo, Docker, auth, admin shell 🟨 in progress (`0.2.0-dev`)

**Goal:** `docker compose up` on a clean machine → login page → authenticated empty admin panel.

| Area | Work |
|---|---|
| Repo | Bun workspaces, tsconfig, ESLint/Prettier, Vitest workspace, `.gitignore`, `.editorconfig` |
| Shared | Zod primitives, prefixes, error codes, pagination schemas |
| API | Fastify app, config/env validation, logger with redaction, error envelope, security headers, DB plugin, `/healthz`, `/readyz` |
| DB | `0001_init.sql` (admins, tokens, settings, audit), Kysely setup + migrate script |
| Auth | login/logout/me, Argon2id, token issue/verify/revoke, throttling, audit, guard plugin |
| Scripts | `init-admin.ts` (launch), `reset-admin-password.ts` |
| Docker | `api.Dockerfile`, `web.Dockerfile`, `nginx.conf`, entrypoint (wait→migrate→init→start), compose with volumes + healthchecks |
| Web | Vite + Vue + Vuetify theme tokens, router with guards, login page, admin layout shell, Pinia auth store, `useApi` |
| Tests | route-law, auth happy/negative, init-admin, login throttle |

**Exit gate:** fresh `docker compose up -d` with `ADMIN_PASSWORD` → login works → `/healthz` and
`/readyz` green → `bun run check` passes → route-law test proves L1/L2/L3.

---

## Phase 2 — Catalog, cache engine, versions

**Goal:** search Geofabrik, download a country (latest or a dated snapshot), see and delete versions.

| Area | Work |
|---|---|
| Source | `MapSource` interface, Geofabrik index sync (`index-v1-nogeom.json`) with TTL, stable slugs and audit, region-page parser (dated snapshots + "data up to"), fixture-based tests |
| DB | countries, country_cache, map_versions, jobs, `0002_*` migration |
| Jobs | queue (SKIP LOCKED), worker loop, heartbeat + reaper, cancel, progress, disk preflight, streamed download with Range resume + md5 verification |
| Admin API | catalog list/detail/snapshots, cache list/detail, download latest/specific, delete version, delete country, admin file download, jobs endpoints |
| Web | Catalog page (search, continent filter, cache filter, Download button only when uncached), cache table, country detail with versions, delete dialogs with typed confirmation, job progress drawer |
| Tests | download happy/resume/checksum/cancel/disk-full, delete semantics, duplicate guard, law tests for new routes |

**Exit gate:** a real country is cached with a verified md5, visible in the UI, downloadable by the
admin, deletable per version and entirely — verified against live Geofabrik and in automated tests
with fixtures.

---

## Phase 3 — Public portal

**Goal:** publish a country; anyone can find and download it without an account.

| Area | Work |
|---|---|
| Admin | public toggle (with `422` guard), audit, immediate visibility |
| Public API | countries, country detail, versions, streaming download (Range/ETag/304), stats, rate limit |
| Public web | light-theme catalog page (search + continent filter + cards), country page (versions, size, checksum, license/attribution), API docs page with copy-paste curl, 404/empty states |
| Tests | 404 for unpublished, 206 range, 304 etag, 410 missing file, rate limit, no admin data leaks |

**Exit gate:** an anonymous browser and `curl` both download a published country; an unpublished
country is indistinguishable from a nonexistent one; public payloads contain no internal fields.

---

## Phase 4 — Import, intervals, update detection

**Goal:** the three remaining admin powers.

| Area | Work |
|---|---|
| Import | multipart staging, validation (extension/magic/size), duplicate rejection + explicit replace, install job, UI form with exactly file/country/version |
| Intervals | CRUD + validation, schedule math (UTC), scheduler loop with SKIP LOCKED claim, run history + items, run-now, next-run preview |
| Updates | per-country check, bulk check job, `update_available` state + badge, one-click update, `unknown` handling, dashboard counter |
| Retention | prune to `keep_versions` after successful update, never delete newest valid |
| Tests | schedule math table-driven, no double fire, partial runs, duplicate/replace, update states, prune invariants |

**Exit gate:** upload a file and it becomes a downloadable version; an interval fires (clock-mocked)
and downloads only when changed; a genuinely newer snapshot produces a badge and one-click update.

---

## Phase 5 — Monitoring, UI/UX polish, test depth

**Goal:** hit the 5/5 bar and make the whole thing pleasant.

| Area | Work |
|---|---|
| Metrics | sampler (CPU/load/RAM/disk/cache size), retention, downsampling, `/system/metrics` + `/status` |
| Charts | CPU, memory, disk, cache-growth charts; window selector (5m/1h/24h/7d); honest empty states |
| Dashboard | stat cards, updates available, running/queued/failed jobs, next interval, disk headroom warning |
| UI/UX | full state coverage (loading/empty/error/success), skeletons, toasts, confirm dialogs, keyboard nav, focus rings, reduced motion, responsive tables→cards, dark/light pass |
| A11y | contrast audit, labels, aria, touch targets, axe check in component tests |
| Tests | coverage ≥ 80 % on core modules, component tests for critical flows |
| Review | screenshots light/dark × mobile/desktop, rubric scored |

**Exit gate:** rubric ≥ 45/50 with evidence, all flows usable on a 390 px viewport, `bun run check`
green, no placeholder text or dead buttons anywhere.

---

## Phase 6 — Hardening & release

**Goal:** someone else can deploy and operate this without you.

| Area | Work |
|---|---|
| Ops | upgrade path, backup/restore drill, log review, disk-full drill, restart resilience |
| Security | checklist in `14-security.md` signed off, dependency audit, headers verified, rate limits verified |
| Perf | catalog/cache page timings, 1 GB+ download throughput, memory flat under load |
| Docs | README quick start, deployment runbook, API examples verified, diagrams refreshed |
| Release | version tag, changelog, verified fresh-VM install on Ubuntu 24.04 |

**Exit gate:** a clean Ubuntu 24.04 machine, following only `12-deployment.md`, reaches a working
public mirror with an existing backup/restore cycle.

---

## Cross-phase practice

- Every phase opens by re-reading its task group in `08-tasks.md`, and closes by ticking tasks,
  updating docs, and writing a report (built / verified / next).
- Every new endpoint is added to `04-api.md` first.
- Every new env var is added to `.env.example` + `09-development.md` in the same commit.
- Every new table/migration updates `03-data-model.md`.
- Nothing is "temporarily hardcoded": a TODO in a critical path blocks the phase gate.
