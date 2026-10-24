# MapMirror — Build Prompt & Specification (v1 — For Review)

> **Status: APPROVED — v1.1 (2026-10-24).** All 16 open questions (D-1 … D-16) were answered by the
> owner; the resolutions are recorded in §24 and in `docs/15-decisions.md`.
> Current stage: **Phase 0 = documentation only** (`docs/`). No application code is written until the
> docs set is approved.
>
> Owner: you. Executor: Arena coding agent. Everything in this file is traceable by requirement ID
> (`AUTH-1`, `CACHE-3`, …) so nothing from the original request is lost or silently reinterpreted.
> Appendix A contains the original request **verbatim** as the reference of record.

---

## 0. How to use this document

1. **Read it.** Sections 1–22 are the whole job. Section 22 lists the few decisions I need from you.
2. **Confirm or edit.** Reply with approvals / changes / removals. Anything you don't object to is
   treated as approved once you say "confirmed".
3. **Phase 0 (docs).** I generate the documentation set in `/docs` (Section 18): tasks, roadmap,
   diagrams, dev guide, laws, project tree, API contract, data model, UI/UX rubric.
4. **Phase 1+ (code).** Only after Phase 0 is approved. Each phase ends with a report
   (done / verified / next) and a commit on the working branch.

**Interpretation rule:** where the original request is ambiguous, this document states an explicit
default (marked _derived_ or listed in Section 22). Nothing is assumed silently.

---

## 1. Vision

**MapMirror** is a self-hosted **map cache and download mirror** for OpenStreetMap country extracts.

- An **admin** browses a searchable catalog of countries/regions from the map source
  (Geofabrik), caches chosen countries locally, manages **versions**, exposes selected countries for
  **public download**, schedules **automatic refresh intervals**, **detects updates**, imports local
  map files, and monitors server resources.
- **Visitors** (no account) browse only the countries the admin has **published**, view their
  versions, and download them from the website or via a public API.

The quality bar is a **5/5 UI/UX rating**, informed by [uupm.cc](https://uupm.cc/) (UI UX Pro Max:
UI styles, palettes, font pairings, chart types, UX guidelines).

---

## 2. Mandatory technology stack (non-negotiable)

| Area | Requirement |
|---|---|
| Runtime / package manager | **Bun** (workspaces, scripts, test runner host) |
| Language | **TypeScript** (strict), documented with **JSDoc** on exported APIs |
| Backend framework | **Fastify** |
| Validation | **Zod** (schema-first; types derived via `z.infer`) |
| Database | **PostgreSQL** |
| Frontend | **Vue 3** + **Vuetify 3** + **VueUse** + **Pinia** |
| Build tool | **Vite** |
| Test framework | **Vitest** |
| Packaging | **Docker + docker compose**, target **Ubuntu 24.04** |
| Docs | Markdown + Mermaid diagrams |

Substitutions require your explicit approval. No Tailwind/Ant/React/Prisma-style stack swaps; raw SQL
+ a small typed query layer (or Kysely) is used instead of a heavyweight ORM unless you prefer
otherwise (see D-12).

---

## 3. Glossary

| Term | Meaning in this project |
|---|---|
| **geofabric** (as written in the request) | **Geofabrik Download Server** — `https://download.geofabrik.de` (recommended reading of the term; see D-1) |
| **Country** | A source region/extract (e.g. `europe/finland`), with ISO code(s) where available |
| **Cached country** | A country with ≥1 stored map artifact version in local storage |
| **Version** | One immutable artifact (source snapshot date, imported upload, …) with checksum + size |
| **Public / open access** | Per-country switch allowing anonymous download |
| **Interval** | A recurring auto-download schedule (daily / weekly / monthly) over many countries |
| **Update available** | The source offers a newer snapshot than the newest cached version |
| **Job** | A background task (download, import, verify, prune) with progress + cancel |

---

## 4. Actors & authorization model

| Actor | Capabilities |
|---|---|
| **Admin** | Login with username+password → Bearer token. Full access to all `/_admin/*` APIs and the admin pages under `/_site/admin/*`. By default the **only** actor allowed to download cached maps. |
| **Public user / visitor** | No account, no signup. Sees published countries on the website (`/_site/*`), calls `/_public/api/*`, downloads published countries. |

- Role model is intentionally simple: `admin` only (multi-admin support is D-4).
- Everything not explicitly public is denied by default (deny-by-default middleware).

---

## 5. URL namespaces (hard law)

| Prefix | Contents |
|---|---|
| `/_auth/*` | **All authentication**: the login **page** at `/_auth/login` and the auth **APIs** at `/_auth/api/*` (login, logout, me) |
| `/_site/*` | **All non-auth website pages** (SPA): public catalog, country pages, API docs, and the admin panel under `/_site/admin/*` |
| `/_admin/*` | **All** admin APIs (page shells live under `/_site/admin/*`), admin-only, Bearer token required |
| `/_public/*` | **All** public APIs (page shells live under `/_site/*`), anonymous, no token |
| everything else | Static assets only (`/assets/*`), the probes `/healthz`,`/readyz`, and the `/` → `/_site/` redirect. No pages, no APIs. |

Rules:

- **No** API may live outside the three API prefixes, and **no page may live outside `/_site/*`** (except infra probes `/healthz`, `/readyz` and the `/` → `/_site/` redirect).
- Any new endpoint must be registered under the correct prefix; a test asserts route table
  compliance so this law cannot regress.
- Unauthorized → `401`; authenticated-but-forbidden → `403`; consistent JSON error envelope
  `{ error: { code, message, details?, requestId } }`.
- Admin HTML routes (`/_site/admin/*`) are **UI** routes only; they hold no API logic. All data flows
  to them through `/_admin/api/*`.

---

## 6. Authentication & admin bootstrap

- **AUTH-1 — Launch script takes the admin password.** The launch/bootstrap script must accept the
  admin password (and admin username, default `admin`) and create/ensure the admin account on
  first boot. It must also work non-interactively (`ADMIN_USERNAME`, `ADMIN_PASSWORD` /
  `ADMIN_PASSWORD_FILE`) and be **idempotent** (re-running never duplicates or overwrites silently).
  Password policy enforced (min length, not in a small weak-password list), input hidden when
  interactive, password never echoed, never logged, never committed.
- **AUTH-2 — Login.** `POST /_auth/api/login` with `{ username, password }` → Bearer token + expiry + admin
  profile. Wrong credentials give a generic error (no user enumeration), constant-time-ish handling,
  and are rate limited.
- **AUTH-3 — Bearer token only.** Every `/_admin/api/*` request uses `Authorization: Bearer <token>`.
  No cookies, no Basic auth, no session for admin APIs. Token validated on every request; expires;
  revocable; invalidated on password reset/logout-all.
- **AUTH-4 — Reset admin password script.** A dedicated script (runnable **inside Docker**, e.g.
  `docker compose exec api bun run scripts/reset-admin-password.ts`) that takes username + new
  password (or generates a strong one and prints it **once**), updates the hash, and revokes existing
  tokens. Documented in the dev + deployment docs.
- **AUTH-5 — Hardening.** Password hashing with **Argon2id**; JWT (short-lived) or opaque DB token
  (see D-3); login throttling + temporary lockout; audit log entries for login success/failure,
  password reset, token revocation; secrets only via env/file; `/healthz` and error responses must
  never leak config or stack traces in production.

---

## 7. Geofabrik catalog (browse / search / choose)

- **GEO-1** Admin can **search** the Geofabrik catalog (by country/region name, ISO code, continent)
  with pagination, continent filter, and sorting. Catalog is synced from the source index and cached
  in PostgreSQL with a configurable TTL + manual "Sync now".
- **GEO-2** Each catalog row shows: country/region name, ISO code(s), continent, source path,
  source size, source last-update timestamp, **cache status**, **public status**, and actions.
- **GEO-3** A **Download** action appears near a country **when it is not already cached** (and is
  offered again for a specific not-yet-cached version). Cached countries show version management
  actions instead.
- **GEO-4** Downloading a country lets the admin pick **`latest`** or a **specific source version**
  (dated snapshot), showing size/date before confirming.

---

## 8. Cache management (admin)

- **CACHE-1 — Download to cache.** A download runs as a **background job**: streamed to a temp file,
  progress (bytes, %, speed, ETA) visible live, cancelable, **resumable** where the source supports
  it, **checksum verified** (`.md5`/`.sha256` when available), then atomically moved into final
  storage. Disk-space preflight before starting. Failures leave no half-cached version.
- **CACHE-2 — Cached list.** Table of cached countries: versions, total size, cached-at, source,
  checksum, public state, last update check, last download, actions.
- **CACHE-3 — Delete country from cache.** Explicit destructive confirmation (type-name or dialog),
  removes all versions + files, clears public state, records an audit entry. Optional soft-delete to
  trash folder (D-7b).
- **CACHE-4 — Delete a specific version.** Version-level delete per country; deleting the last version
  makes the country "not cached" and auto-closes public access. Download tokens/URLs for removed
  versions return `404`.
- **CACHE-5 — Consistency.** DB rows are the source of truth; a periodic **orphan sweep** reconciles
  files ↔ DB and reports/fixes mismatches. Never delete a file that a running job or active download
  is using.

---

## 9. Public access switch

- **PUB-1** Per-country **switch** ("Open download access") in the admin cache list/detail. Toggling is
  immediate and reflected in `/_public/api/*` and the public website (no redeploy, no cache-busting).
- **PUB-2** Only a **cached** country can be opened. Closing access **keeps** the cache intact.
- **PUB-3** Default = **closed**. Only admin can download cached maps until a country is opened.
  Opened countries expose all their cached versions (or latest-only, see D-9) publicly.
- **PUB-4** Every toggle is audited (who, when, before/after).

---

## 10. Auto-download intervals

- **INT-1** Admin can create / edit / delete / enable-disable intervals.
  **Required form fields: frequency (`daily` | `weekly` | `monthly`) and countries (multi-select).**
  _Derived fields (confirm in D-6):_ time of day, timezone, weekday (weekly), day of month (monthly),
  retention policy (keep N versions), "only download if source changed" flag.
- **INT-2** On fire: download latest version for each selected country (skipping unchanged sources),
  verify, then optionally prune old versions per retention.
- **INT-3** **Run history** per interval: status, start/end, duration, bytes, per-country result,
  error message; **Run now** (manual trigger); next-run preview; last-run summary.
- **INT-4** Scheduler is **DB-backed and persistent**: survives restarts, timezone-aware
  (default `UTC`, configurable), prevents double execution (advisory lock / job lock), and does not
  silently drop missed runs (catch-up policy documented).
- **INT-5** Interval runs surface in the dashboard as running/queued/failed widgets.

---

## 11. Update detection (per country)

- **UPD-1** **"Check for update" button near each cached country** → compares cached version(s) with
  the source and returns one of: `up_to_date`, `update_available` (with new version id/date/size),
  `unknown` (source unreachable — never reported as up-to-date).
- **UPD-2** When newer versions exist, the UI shows an **update badge + suggestion** with a one-click
  **"Download update"**. The old version stays available until the new one is verified and installed.
- **UPD-3** Bulk action **"Check all cached countries"** plus an optional scheduled daily check; the
  dashboard shows "N updates available".
- **UPD-4** `last_checked_at` and the result are persisted and displayed; freshness is visible, not
  guessed.

---

## 12. Import map (upload) form

**Required fields — exactly these three:**

| Field | Control | Rules |
|---|---|---|
| **Choose file** | File picker (drag & drop supported) | Allowed formats: `.osm.pbf`, `.shp.zip` / `.gpkg.zip` (configurable allow-list, D-2); configurable max size; server re-validates extension, MIME/magic bytes and size; streamed to disk with progress |
| **Select country** | Searchable country select (from catalog) | Country must exist in the catalog; cannot be empty |
| **Version** | Text (or date) input | Must be unique per country (conflict handling D-10); validated format; default suggestion = today |

_Derived, non-input behavior:_ detected format + computed size + computed checksum shown after upload,
job progress, and a success state that immediately enables public toggle / update checks for that
version. Imported artifacts are marked `source = upload` so they are distinguishable from Geofabrik
downloads and are never "updated" by the source automatically.

---

## 13. Public website & public API

- **WEB-1** Public home: only **published** countries, with search, continent filter, cards/table
  showing name, ISO flag/code, newest version, size, last updated, and a **Download** button.
  Empty state explains that no map is published yet (friendly, no dead end).
- **WEB-2** Country detail page: available version(s), size, source date, checksum, **license &
  attribution** (OpenStreetMap © contributors, ODbL; Geofabrik attribution), download actions.
- **WEB-3** Public APIs (anonymous, rate limited):
  - `GET /_public/api/countries` — list of published countries (search, filter, pagination)
  - `GET /_public/api/countries/:slug` — one country + versions
  - `GET /_public/api/countries/:slug/download?version=latest|id` — streamed file download
    (`Content-Disposition`, `Content-Length`, `Range`, `ETag`/`Last-Modified`, correct MIME)
  - `GET /_public/api/stats` — aggregate counters (optional)
  All public responses include links/counters and are documented with `curl` examples.
- **WEB-4** In-app **API docs** page (public) with copy-paste `curl` examples and response shapes.

---

## 14. Admin dashboard & resource monitoring widgets

- **MON-1** Charts for **CPU**, **RAM**, **disk usage of the cache volume**, plus load average and
  (optional) network I/O. Sampled on an interval, persisted as time series, rendered as
  area/line charts with **live refresh** and selectable window (5m / 1h / 24h / 7d).
- **MON-2** Cards/widgets: total cached size, #countries cached / public, #updates available,
  active/queued/failed jobs, storage headroom warning, next scheduled interval, source sync freshness.
- **MON-3** Honest metrics labeling (host vs container scope documented in `docs`).

---

## 15. UI/UX requirements — target 5/5

Design intelligence reference: **uupm.cc (UI UX Pro Max)** — UI styles, color palettes, font
pairings, chart types, UX guidelines, landing patterns, and the Vue tech-stack guidance.

- **UX-1 Design direction (proposed, confirm D-14):** a map/data product identity — clean and
  confident, **dark-first admin** ("control room" for charts + data-dense tables) and **light-first
  public** ("catalog" feel). Space Grotesk (display) + Inter (UI) pairing; deep teal/indigo primary
  with an amber "update available" accent; 8-pt spacing scale; 12–16 px radii; subtle borders over
  heavy shadows; restrained motion.
- **UX-2** Vuetify 3 theme tokens (no ad-hoc hex in components), **light + dark**, AA contrast,
  visible focus rings, keyboard navigable, `prefers-reduced-motion` respected.
- **UX-3** Every screen implements **loading (skeleton) / empty / error / success** states, plus
  optimistic toggles with rollback, toasts, and explicit confirm dialogs for destructive actions.
- **UX-4** SVG icon set only (Material Design Icons) — **no emoji as UI icons**; consistent hover
  feedback; no layout shift; sticky table headers; virtualized/paginated lists where needed.
- **UX-5** Responsive: mobile (360 px) → tablet → desktop (≥1440 px); admin tables degrade to cards
  on small screens; touch targets ≥ 44 px.
- **UX-6** Copy: short, human, actionable; no jargon in public pages; error messages say what to do
  next.
- **UX-7 Measurable rubric** in `docs/ui-ux.md` — 10 criteria (visual hierarchy, consistency,
  typography, color/contrast, state coverage, feedback, accessibility, responsiveness, performance,
  trust/empty states), each scored /5 with evidence (screenshots) and a target total of **50/50**
  (≥ 45 required to call a phase done).
- **UX-8 Performance:** lazy-loaded routes, code-split vendor chunks, LCP < 2.5 s on the public
  catalog, no blocking font fetch, images/icons inlined or cached.
- **UX-9** Screenshot review at the end of each UI phase (light + dark, mobile + desktop) against the
  rubric, with fixes applied before sign-off.

---

## 16. Docker / deployment (Ubuntu 24.04)

- **DOCK-1** `compose.yaml` services: `db` (PostgreSQL), `api` (Fastify + worker loop), `web` (built
  SPA served by nginx, also reverse-proxying `/_auth`, `/_admin`, `/_public` to `api`), optional
  `backup`. Named volumes for database and map cache. Healthchecks + `restart: unless-stopped`.
- **DOCK-2** One-command start on a clean Ubuntu 24.04 box: copy `.env.example` → `.env`, set
  `ADMIN_PASSWORD`, run `docker compose up -d` (or `make up`). Migrations run automatically on boot;
  admin bootstrap reads the password from env/script. No manual SQL, no manual mkdir.
- **DOCK-3** Non-root containers, pinned image tags/base versions, `.dockerignore`, no secrets in
  images, `.env` never committed, uploads/downloads streamed (no full buffering in memory).
- **DOCK-4** nginx config handles large uploads (`client_max_body_size`), long downloads
  (`proxy_read_timeout`, buffering off), gzip for API/HTML, and a documented TLS path (external
  reverse proxy / Caddy example).
- **DOCK-5** Ops: structured logs (`docker compose logs`), DB + cache backup & restore procedure,
  upgrade steps, disk-full behavior documented, and a `make` target set (`up`, `down`, `logs`,
  `migrate`, `test`, `reset-admin`).

---

## 17. Engineering standards

- **ENG-1 Monorepo** with bun workspaces: `apps/api`, `apps/web`, `packages/shared` (Zod schemas +
  shared types/constants), `scripts/`, `docker/`, `docs/`.
- **ENG-2 TypeScript strict**; no `any` in public surfaces; Zod at every boundary (env, request,
  response, DB rows mapped explicitly); JSDoc on exported functions/types; conventional commits.
- **ENG-3** Lint + format enforced (ESLint + Prettier or equivalent), `bun run check` = typecheck +
  lint + format check + tests.
- **ENG-4 Vitest**: unit (validators, scheduler math, version comparison, storage paths, checksum),
  integration (API routes against a test PostgreSQL, auth guards, prefix law, public visibility
  rules), and web component tests for critical flows. Core coverage target ≥ 80 %.
- **ENG-5** Pino structured logs, request IDs, graceful shutdown (drain jobs, close pool), error
  taxonomy + centralized handler, no stack traces in production responses.
- **ENG-6 Security**: Helmet-style headers, strict CORS, rate limits (login/public download),
  Argon2id, path-traversal guard on every file operation, token scopes, upload validation,
  dependency audit in CI-able script.
- **ENG-7** Accessible, i18n-ready copy (English default, strings centralized).
- **ENG-8** Every behavior change updates the matching `docs/` file in the same commit.

---

## 18. Phase 0 — documentation deliverables (approval gate)

`docs/` must contain at least:

| File | Contents |
|---|---|
| `00-index.md` | Docs map + how to read |
| `01-overview.md` | Product, personas, scope, non-goals, glossary |
| `02-architecture.md` | Context/container view, module boundaries, job & scheduler design |
| `03-data-model.md` | Tables, constraints, indexes, ERD (Mermaid) |
| `04-api.md` | **Full endpoint contract** for `/_auth`, `/_admin`, `/_public` (params, bodies, responses, errors, curl) |
| `05-flows.md` | Sequence flows: login, cache download, version delete, import, public download, interval run, update check |
| `06-diagrams.md` | Mermaid: system context, containers, ERD, deployment, scheduling timeline |
| `07-roadmap.md` | Phases, milestones, exit criteria |
| `08-tasks.md` | Checkbox task list with IDs, dependencies, acceptance criteria, status |
| `09-development.md` | Local setup, env vars, commands, migrations, testing, debugging, seeding |
| `10-laws.md` | Non-negotiable rules (route prefixes, stack, auth, docs-in-sync, no silent scope changes) |
| `11-project-tree.md` | Target tree with one-line purpose per folder |
| `12-deployment.md` | Ubuntu 24.04 + Docker runbook, TLS, backups, upgrades |
| `13-ui-ux.md` | Design tokens, screen inventory, component rules, 10-criteria 5/5 rubric |
| `14-security.md` | Threat model, auth rules, file/upload safety, rate limits, checklist |
| `15-decisions.md` | ADR log — one entry per resolved question in Section 22 |
| `16-changelog.md` | Review passes over the docs: what was found and fixed |

Docs are Mermaid-rendered on GitHub, cross-linked, and kept current. **Phase 0 is a gate:** no code
until you approve it.

---

## 19. Target project tree (draft)

```
mapirror/
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ server.ts              # boot, listen, graceful shutdown
│  │  │  ├─ app.ts                 # Fastify instance + plugin registry
│  │  │  ├─ config/env.ts          # Zod-validated environment
│  │  │  ├─ plugins/               # db, auth-guard, errors, rate-limit, logging
│  │  │  ├─ modules/
│  │  │  │  ├─ auth/               # /_auth routes + token service
│  │  │  │  ├─ admin/              # /_admin routes: catalog, cache, versions
│  │  │  │  ├─ public/             # /_public routes: catalog, download
│  │  │  │  ├─ geofabrik/          # source client, index sync, version discovery
│  │  │  │  ├─ jobs/               # queue, worker, downloader, importer, scheduler
│  │  │  │  └─ system/             # metrics sampling, disk usage
│  │  │  ├─ db/                    # SQL migrations, repositories
│  │  │  └─ lib/                   # storage, checksum, time, http-streams, logger
│  │  └─ tests/
│  └─ web/
│     ├─ src/
│     │  ├─ main.ts / App.vue / router/
│     │  ├─ plugins/               # vuetify theme, pinia
│     │  ├─ stores/                # auth, catalog, cache, intervals, system, ui
│     │  ├─ composables/           # useApi, usePolling, useConfirm, useTheme
│     │  ├─ layouts/               # AdminLayout, PublicLayout, AuthLayout
│     │  ├─ pages/                 # admin/{dashboard,catalog,cache,intervals,import,settings}
│     │  │                         # public/{home,country,api-docs}, auth/login, 404
│     │  ├─ components/            # charts, data-tables, dialogs, badges, empty states
│     │  └─ styles/                # design tokens + theme
│     └─ tests/
├─ packages/shared/                # Zod schemas, DTO types, constants, error codes
├─ scripts/                        # init-admin, reset-admin-password, sync-catalog, backup
├─ docker/                         # Dockerfile.api, Dockerfile.web, nginx.conf, entrypoints
├─ docs/                           # Section 18
├─ compose.yaml  .env.example  Makefile  README.md
├─ package.json  tsconfig.base.json  eslint/prettier configs  vitest configs
└─ data/                           # gitignored: cache artifacts + pg data
```

---

## 20. Implementation roadmap (draft, after approval)

| Phase | Scope | Exit criteria |
|---|---|---|
| **0** | All docs in Section 18 | You approve docs |
| **1** | Monorepo skeleton, Docker compose, Postgres + migrations, env validation, admin bootstrap/reset scripts, `/_auth` login + Bearer guard, admin shell + login UI, theme tokens | `docker compose up` works, login works, prefix-law test green |
| **2** | Geofabrik catalog sync/search, cache download job + progress, versions list, delete country/version, admin download | Real country cached, verified checksum, deletable |
| **3** | Public switch, public site (catalog + country detail), `/_public` list/detail/download APIs | Anonymous user downloads an opened country; closed country is 404 |
| **4** | Import form (file/country/version), intervals CRUD + scheduler + run history, update check per country + bulk + badge | Upload works; interval fires; update badge appears |
| **5** | Monitoring widgets/charts, UI/UX polish, a11y + responsive pass, Vitest suites, docs refresh | Rubric ≥ 45/50, tests green, typecheck/lint clean |
| **6** | Docker hardening, TLS/proxy docs, backups, clean-VM verification, release notes | Fresh Ubuntu 24.04 deployment verified |

Each phase: report → your review → next phase. No phase skipped.

---

## 21. Definition of Done (global)

- [ ] Every requirement ID in Sections 6–16 maps to a task in `docs/08-tasks.md` with status.
- [ ] `bun run check` (typecheck + lint + format + tests) passes; core coverage ≥ 80 %.
- [ ] Route law (APIs under the three prefixes, every page under `/_site/*`) and auth-guard law
      enforced by tests, not convention.
- [ ] Clean Ubuntu 24.04 + `docker compose up` reproduces the full app from zero.
- [ ] Public download verified with `curl` (Range, headers, rate limit) and in-browser.
- [ ] Admin bootstrap + password reset verified inside Docker.
- [ ] UI rubric ≥ 45/50 with light/dark and mobile/desktop screenshots.
- [ ] Docs updated in the same commits; ADRs written; no TODO left in critical paths.
- [ ] Security checklist in `docs/14-security.md` all green.

---

## 22. Decisions (original questions — all resolved, see §24)

| ID | Question | Proposed default |
|---|---|---|
| **D-1** | Is "geofabric" = **Geofabrik** (`download.geofabrik.de`)? | **Yes**, Geofabrik as the source, abstracted behind a `MapSource` interface so another provider (e.g. BBBike, Geofabrik-internal, custom mirror) can be added later |
| **D-2** | Which artifact formats to cache? | **`.osm.pbf` only** by default (fastest, smallest, most useful); allow-list configurable for `.shp.zip`/`.gpkg.zip` |
| **D-3** | Bearer token type | **Opaque random token stored (hashed) in PostgreSQL** with expiry + revocation (simpler, instantly revocable); JWT optional |
| **D-4** | How many admin accounts? | **One admin** in the UI, with the schema supporting multiple and a future "admins" screen |
| **D-5** | Storage backend | **Local disk volume** (`/data/cache`) with a storage abstraction; S3-compatible later |
| **D-6** | Interval extras | Add **time of day (default 03:00)**, **timezone (UTC)**, **weekday (Mon)**, **day of month (1)**, **retention (keep 3 versions)** |
| **D-7** | Old version retention | Keep **last 3 versions** per country by default; prune only when an interval/retention rule says so; manual delete always allowed |
| **D-7b** | Delete behavior | **Hard delete** after typed confirmation; optional "trash" folder for 7 days (toggle in settings) |
| **D-8** | Project name / branding | **MapMirror** (repo name); display name editable in settings |
| **D-9** | Public exposure granularity | Public = **all cached versions of an opened country**, "latest" is the default link |
| **D-10** | Import version conflict | **Reject duplicates**; offer explicit "replace this version" action |
| **D-11** | Job runner | **PostgreSQL-backed job queue + in-process worker** in the `api` container (no Redis, simpler Docker); Redis only if you later scale out |
| **D-12** | ORM / query layer | **Raw SQL migrations + Kysely** (typed, no schema magic); Zod for I/O validation |
| **D-13** | Auth for admin SPA page refresh | Token in `sessionStorage` + Pinia (no cookies) per Bearer-only requirement; XSS mitigations documented |
| **D-14** | UI design direction | Dark-first admin / light-first public, Space Grotesk + Inter, teal-indigo + amber accent (Section 15) |
| **D-15** | Compose port & TLS | App served on `:8080` by nginx; TLS terminated by external proxy (Caddy/Traefik) — documented example included |
| **D-16** | Languages | English UI only, structure i18n-ready |

**Resolution:** all 16 answered by the owner on 2026-10-24 — see §24.

---

## 23. Working agreement

1. I write **docs first**; implementation starts only after your explicit approval.
2. I work only on branch `arena/5a1becdd-mapirror` and commit there.
3. I never silently change scope, stack, or route layout; changes are proposed in `docs/15-decisions.md` first.
4. Each phase ends with a short report: **what was built, how it was verified, what comes next**, plus screenshots for UI phases.
5. If a source/provider constraint blocks a requirement (e.g. Geofabrik's dated snapshot retention), I report the constraint and the adapted solution instead of quietly dropping the feature.
6. Secrets (admin password, tokens, env values) never appear in docs, logs, commits, or chat.

---

## Appendix A — Original request (verbatim, preserved)

> We need make a new project was about cach map and make a mirror for download map.
> ________
> This project must be have a admin user.
> Admin user must be can login to use apis.
> In the first step of make this project , in launch script , must be can take admin password.
> ________
> Admin user after login , must be can search in geofabric and choose country to cache.
> Admin must be can see a download button near each country if is not was in a cache.
>
> Admin must be can delete country from cache.
> Admin must be can download specific version of country map or delete specific version of selected country map.
>
> In default just admin can download cached map.
> Admin must be have a button for open download access of country with a switch button.
> Admin can make auto download intervals.
> Form of create Intevals , must be have field about daily or weekly or monthly and one more field for take countries (multiple)
>
> Admin mist be can see update button near cached map of counties and suggest admin to download and update map of country , because new version is avalable.
> ________
> Other users must be can see countries was public for download in a website page.
> Users must be can call api for take list of avalable public countries.
> Users must be can call api for download selected avalable countiry.
> ________
> Near each cached country must be was a button for check for update.
> ________
> Import map form:
> This form must be have this fields:
> Field Choose file
> Field select country
> Field version
> ________
> We must be use postgresql ، bun ، typescript , fastify , zod , vue , vuetify , vueuse , pinia , jsDoc , vite , vitest.
> ________
> Login of admin must be was with username and password.
> we must be have a script for reset admin password.
> Authentication must be was with Bearer token.
> All admin routes,apis must be was under path "/_admin/*"
> All public routes and apis must be inder path "/_public/*"
> All authentication routes and apis must be under "/_auth/*"
>
> We must be can run easy this project with docker on ubuntu 24.
>
> Inside admin panel we must be have some widgets for show usages of hard , ram , cpu on a chart.
> ________
> We must be have a best ui,ux , because ui,ux is important and we must be can take 5 star rate from 5.
> You can read website https://uupm.cc/
> ________
> Make a good and standard prompt without losing my information in a new prompt. Save this prompt as markdown first , we must read this prompt , after im confirmed or modify this prompt you have allow to start working this project.
>
> Phase 0 mist be was about docs.
> Deep search and after make a best logic.
> We need write a good markdown files in a docs folder .
> We must be have tasks , roadmap , diagrams , how to use in development ، laws and tree of project

## Appendix B — Source findings used in this document

- **Geofabrik** publishes per-region pages with `-latest.osm.pbf`, `.md5` sidecars, `.poly`
  boundaries, `.osc.gz` replication updates, and **dated snapshots** in the form
  `region-YYMMDD.osm.pbf` (e.g. `finland-260101.osm.pbf`), plus a machine-readable catalog index — so
  "specific version download" and "update available" checks are both technically feasible.
  (Verified: `download.geofabrik.de/europe/finland.html`.)
- **uupm.cc (UI UX Pro Max)** is a design-intelligence reference (UI styles, 95 palettes, 56 font
  pairings, chart-type guidance, UX guidelines and Vue-specific best practices) — Section 15 turns it
  into a concrete, testable rubric rather than a vague "make it pretty".

---

## 24. Decision log — RESOLVED (owner-approved 2026-10-24)

| ID | Resolution |
|---|---|
| D-1 | **Geofabrik** is the initial source, behind a deliberately thin `MapSource` interface (no speculative abstraction). |
| D-2 | **`.osm.pbf` only** initially. Other formats only on a real requirement. |
| D-3 | **Opaque random bearer tokens**, stored as hashes, with expiry + revocation. **No JWT.** |
| D-4 | **One admin** in the initial UI; schema allows multiple admins later. |
| D-5 | **Local persistent Docker volume at `/data/cache`**; simple storage abstraction, no S3. |
| D-6 | **Daily / weekly / monthly**, defaults: 03:00 UTC, Monday, day 1. No complex scheduler. |
| D-7 | Keep the **latest 3 valid versions** per country; prune after a successful update; **always keep the latest valid version**. |
| D-7b | **Hard delete** with typed confirmation. No trash feature. |
| D-8 | Name **MapMirror**; display name editable via a simple setting if cheap. |
| D-9 | **Opt-in public access per country**; only valid published versions are exposed; `latest` link provided. |
| D-10 | **Reject duplicate versions**; explicit replace after confirmation; no merge system. |
| D-11 | **PostgreSQL-backed job queue + in-process worker** in the API container. No Redis, no separate worker service. |
| D-12 | **SQL migrations + Kysely + Zod** only. No extra ORM/validation library. |
| D-13 | Token in **`sessionStorage`** + Pinia; basic security headers; **no unsafe HTML rendering**. |
| D-14 | Simple responsive UI: **dark admin, light public**; fonts/palette kept only if cost-free. |
| D-15 | **Nginx on :8080**, TLS terminated by an external reverse proxy; documented, nothing extra. |
| D-16 | **English only**, strings centralized, full i18n postponed. |
| D-17 | *(added during Phase 0)* JSON APIs live inside the required prefixes: `/_admin/api/*`, `/_public/api/*`, `/_auth/*`. Rationale: `docs/15-decisions.md` ADR-001. |
| D-18 | **All website pages live under `/_site/*`** (public pages and the admin panel at `/_site/admin/*`); `/` redirects to `/_site/`. Supersedes the page half of D-17. |
| D-19 | **Login lives under `/_auth/*`**: the login page is `/_auth/login`, the auth JSON API is `/_auth/api/*` (`login`, `logout`, `me`). Overrides D-18 for the login page only. |
