# Project tree (target)

Status: **planned** — this is the structure Phase 1 creates. Every directory has exactly one job.

```
mapirror/
├─ PROMPT.md                       # Approved requirements + decision log (source of truth)
├─ README.md                       # 5-minute pitch, quick start, links into docs/
├─ package.json                    # Bun workspaces root; scripts: check, dev, test, build
├─ tsconfig.base.json              # Strict TS settings shared by every package
├─ eslint.config.js                # Flat ESLint config (JS + type-aware TS + Vue)
├─ prettier.config.js              # Formatting (code only)
├─ .prettierignore / .editorconfig # Formatting scope + editor defaults
├─ vitest.config.ts                # One config, four projects (shared, api, web, scripts)
├─ vitest.projects.ts              # The project table — read by the config and by check:hygiene
├─ compose.yaml                    # exists (P1-DOCK-05): db + api + web, two volumes, healthchecks,
│                                  # one published port (8080), and a DSN that carries no password
├─ compose.override.yaml           # Dev-only: hot reload, exposed DB port
├─ .env.example                    # Every env var, documented, no real secrets
├─ Makefile                        # up, down, logs, migrate, test, reset-admin, backup
├─ .dockerignore / .gitignore      # Ignore node_modules, data/, dist/, .env
│
├─ apps/
│  ├─ api/                         # Fastify server + worker (single container, two loops)
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ src/
│  │  │  ├─ server.ts              # Entry: build app, listen, install signals
│  │  │  ├─ app.ts                 # Fastify instance, plugin order, route registration
│  │  │  ├─ config/
│  │  │  │  ├─ env.ts              # Zod-validated process.env → typed config
│  │  │  │  ├─ prefixes.ts         # API route classification + requiresAdminToken (L2)
│  │  │  │  └─ constants.ts        # API-only limits/defaults (prefixes come from @mapirror/shared)
│  │  │  ├─ plugins/
│  │  │  │  ├─ order.ts            # The pipeline as ordered data — the only place order is decided
│  │  │  │  ├─ db.ts               # Kysely instance, healthcheck, shutdown hook
│  │  │  │  ├─ errors.ts           # Error taxonomy + JSON envelope + 404/500 handlers
│  │  │  │  ├─ security.ts         # Helmet-style headers, CORS, body limits
│  │  │  │  ├─ rate-limit.ts       # Public per-IP and admin per-token limits (onRequest)
│  │  │  │  ├─ auth-guard.ts       # Bearer guard for /_admin/api/* — onRequest, deny by default (L2)
│  │  │  │  └─ request-context.ts  # Request id, logger child, timing
│  │  │  ├─ routes/
│  │  │  │  ├─ index.ts            # Registers one encapsulated plugin per API prefix
│  │  │  │  └─ not-implemented.ts  # 503 NOT_READY stubs at their real contract paths
│  │  │  ├─ modules/
│  │  │  │  ├─ auth/               # /_auth: login, logout, me; token issue/verify/revoke
│  │  │  │  │  ├─ routes.ts
│  │  │  │  │  ├─ service.ts
│  │  │  │  │  ├─ password.ts       # Argon2id hash/verify + policy
│  │  │  │  │  ├─ admin-accounts.ts # Create the first admin: validate, hash, insert + audit, idempotent
│  │  │  │  │  ├─ weak-passwords.ts # 1 000-entry blocklist (Django, BSD-3)
│  │  │  │  │  ├─ session.ts        # Authorization header → session; verdict → 401/403 (shared with the guard)
│  │  │  │  │  ├─ login-throttle.ts # sliding-window failures: (ip, username) + ip, bounded map
│  │  │  │  │  └─ tokens.ts         # Bearer tokens: mint, digest, verify verdict, revoke, prune
│  │  │  │  ├─ admin/              # /_admin/api: catalog, cache, versions, imports,
│  │  │  │  │  │                   # intervals, jobs, metrics, settings, audit
│  │  │  │  │  ├─ catalog-route.ts # Authenticated search/filter/page + consistent freshness snapshot
│  │  │  │  │  ├─ catalog-region-route.ts # Slug detail, parent chain, cached versions and outage-safe snapshots
│  │  │  │  │  ├─ catalog-sync-route.ts # Authenticated, idempotent catalog-job trigger
│  │  │  │  ├─ routes/{catalog,cache,versions,imports,intervals,jobs,system,settings,audit}.ts
│  │  │  │  │  └─ services/{cache,versions,publication,intervals,metrics}.ts
│  │  │  │  ├─ public/             # /_public/api: countries, versions, download, stats
│  │  │  │  ├─ geofabrik/          # MapSource contract, catalog client, region parsing, later source operations
│  │  │  │  │  ├─ source.ts        # MapSource interface (thin, 4 methods)
│  │  │  │  │  ├─ index-client.ts  # Zod-validated, bounded/cancelable index-v1-nogeom fetch + mapping
│  │  │  │  │  ├─ region-page.ts   # HTML5 parser: dated PBF snapshots, sizes, and “data up to”
│  │  │  │  │  ├─ region-page-client.ts # Path-safe, bounded region-page fetch + detail/snapshot adapter
│  │  │  │  │  ├─ file-metadata.ts # Bounded HEAD metadata and .md5 requests
│  │  │  │  ├─ slug.ts           # Name-based local slugs and deterministic collision resolution
│  │  │  │  └─ fixtures/          # Saved upstream-shaped samples for offline tests
│  │  │  │  ├─ jobs/               # Queue, download enqueue guard, worker and cancellation
│  │  │  │  │  ├─ enqueue-download.ts # Partial unique-index conflict → JOB_ALREADY_RUNNING / 409
│  │  │  │  │  ├─ enqueue-catalog-sync.ts # Transaction-locked, idempotent catalog job enqueue
│  │  │  │  │  ├─ catalog-sync-handler.ts # TTL decision, slug-preserving upsert, transactional audit
│  │  │  │  │  ├─ download-handler.ts # Resumable transfer, verify, atomically install
│  │  │  │  │  ├─ worker.ts        # FOR UPDATE SKIP LOCKED, loop, concurrency, graceful stop
│  │  │  │  ├─ cancellation.ts    # Cooperative cancellation + ownership-loss abort
│  │  │  │  ├─ lock.ts            # Session advisory lock ownership
│  │  │  │  ├─ progress.ts        # Monotonic, throttled progress reporting
│  │  │  │  ├─ reaper.ts          # Stale worker recovery
│  │  │  │  └─ retry.ts           # Bounded exponential backoff
│  │  │  │  ├─ system/             # Metrics sampler (CPU/RAM/disk), disk preflight
│  │  │  │  └─ storage/             # Validated CACHE_DIR paths, parts, no-follow open/install/unlink
│  │  │  ├─ db/
│  │  │  │  ├─ migrations/         # 0001_init.sql, 0002_catalog.sql (forward-only SQL, Kysely)
│  │  │  │  ├─ migrator.ts         # SQL provider, migrateToLatest/resetDatabase, name rules
│  │  │  │  ├─ transaction.ts      # withTransaction: idle/statement bounds, read-only, retry 40001/40P01
│  │  │  │  ├─ schema.ts           # Kysely table types, phases 1–2 (measured JS types, no `any`)
│  │  │  │  ├─ version-check.ts    # Boot gate: disk vs EXPECTED_MIGRATIONS vs kysely_migration (SCHEMA_SKEW)
│  │  │  │  └─ repositories/       # Typed queries accept the process DB or a caller-owned transaction
│  │  │  │     ├─ executor.ts      # Shared Kysely/Transaction executor type
│  │  │  │     ├─ admin-tokens.ts  # Token rows: insert, find-with-admin, touch, revoke, prune
│  │  │  │     ├─ catalog.ts       # Catalog upsert, lookup, parents/ready versions, SQL search/filter/page
│  │  │  │     ├─ cache.ts         # Cached-only lists and cache summaries
│  │  │  │     └─ map-versions.ts  # Country versions: ready-first list and lookups
│  │  │  └─ lib/
│  │  │     ├─ client-ip.ts        # Untrusted forwarded address → a value `inet` accepts, or null
│  │  │     ├─ rate-limit.ts       # Sliding-window limiter: bounded, injectable clock, refusal is free
│  │  │     ├─ housekeeping.ts     # Boot-time token pruning: bounded, off the boot path, never fatal
│  │  │     ├─ download.ts         # Streamed fetch, resume, progress, checksum via a storage-owned file handle
│  │  │     ├─ checksum.ts         # MD5/SHA-256 streaming
│  │  │     ├─ time.ts             # UTC helpers, schedule math (tested)
│  │  │     ├─ errors.ts           # AppError subclasses + codes
│  │  │     └─ logger.ts           # Pino config with redaction
│  │  └─ tests/                    # API, integration, and source-adapter tests
│  │     ├─ integration/catalog-repositories.spec.ts # Real-Postgres search, filters, cache, paging and versions
│  │     ├─ integration/public-visibility-matrix.spec.ts # Real-Postgres published/private/unknown visibility across public reads
│  │     ├─ integration/public-country-download-route.spec.ts # Real-Postgres stream, Range/If-Range, ETag, HEAD/304 and event semantics
│  │     ├─ integration/catalog-route.spec.ts # Authenticated API projection, contract, filtering and 400-row budget
│  │     ├─ integration/catalog-region-route.spec.ts # Slug detail, source snapshots, cache fallback and validation
│  │     ├─ integration/catalog-sync-route.spec.ts # Auth, attributed 202, concurrency and active-job reuse
│  │     ├─ geofabrik-region-page.spec.ts   # Three offline HTML fixtures + size/date edge cases
│  │     ├─ geofabrik-region-page-client.spec.ts # URL safety, bounded fetch, status and timeout
│  │     ├─ geofabrik-file-metadata.spec.ts # Bounded HEAD and MD5 request cases
│  │     ├─ geofabrik-slug.spec.ts          # Normalization, collisions, stability, path constraints
│  │     ├─ integration/jobs-enqueue.spec.ts # PostgreSQL duplicate, race, terminal reuse, and 409 mapping
│  │     └─ storage.spec.ts                 # Path validation, symlink safety, atomic install, safe unlink
│  │
│  └─ web/                         # Vue 3 + Vuetify 3 SPA (served by nginx)
│     ├─ package.json              # vue, vue-router, vuetify, pinia, @vueuse/core
│     ├─ index.html                # The mount point (`#app`) and the module script
│     ├─ vite.config.ts            # Vue + vite-plugin-vuetify, `@` alias, host/port (§09), proxy
│     ├─ alias.ts                  # `@` → src, shared by vite.config, vitest.config and the tests
│     ├─ dev-proxy.ts              # exists (P1-WEB-08): the five API contexts → 127.0.0.1:$PORT, 502 sentence
│     ├─ src/
│     │  ├─ main.ts                # Two lines: build the app, mount it (+ the two stylesheets)
│     │  ├─ bootstrap.ts           # createWebApp(): Pinia → Vuetify → Router → theme sync → API client
│     │  ├─ App.vue                # v-app → v-main → router-view → ToastHost (the one shell)
│     │  ├─ shims-vue.d.ts         # `*.vue` for plain-tsc consumers (ESLint); vue-tsc ignores it
│     │  ├─ vite-env.d.ts          # Vite's ambient types (the web tsconfig sets `types: []`)
│     │  ├─ router/index.ts        # createAppRouter(): the table + the guard + the titles, in one place
│     │  ├─ router/routes.ts       # All 17 records of 13 §4: 15 pages + 2 redirects, each with screen/owner
│     │  ├─ router/guards.ts       # Path-keyed admin guard (no per-route flag): 401 → /_auth/login?redirect=…
│     │  ├─ router/redirect.ts     # The `redirect` parameter, validated on both sides of the round trip
│     │  ├─ router/titles.ts       # document.title from meta.title ("Cache · MapMirror")
│     │  ├─ router/nav.ts          # the sidebar, as data; active-state and trail predicates live here
│     │  ├─ router/breadcrumbs.ts  # Sidebar trail + API-loaded cached-country label (UUID fallback while loading)
│     │  ├─ router/paths.ts        # Page path builders, all derived from @mapirror/shared
│     │  ├─ auth/token-storage.ts  # The session token in sessionStorage; every access wrapped (D-13)
│     │  ├─ types/vue-router.d.ts  # RouteMeta augmentation: title/screen/owner required on every route
│     │  ├─ api/
│     │  │  ├─ client.ts           # Bearer JSON client + timeout-free authenticated file streaming
│     │  │  ├─ errors.ts           # ApiError (server + client codes), endsSession, validationIssues()
│     │  │  ├─ error-copy.ts       # Exhaustive HTTP/client/job/operational human copy + next steps (P2-WEB-07)
│     │  │  ├─ notify-error.ts     # Persistent mapped API-error toast with request id (P2-WEB-07)
│     │  │  └─ index.ts            # createAppApiClient(): the sign-out policy; provideApiClient()
│     │  ├─ composables/useApi.ts  # useApi(): the client, injected — throws if the app provided none
│     │  ├─ stores/auth.ts         # The session: token + profile + expiry; signIn/signOut/forget/restore (D-13)
│     │  ├─ stores/breadcrumbs.ts  # Reactive API-loaded country name for the detail-page breadcrumb
│     │  ├─ stores/notifications.ts # Toasts: one per action, errors persist, newest three at most
│     │  ├─ stores/jobProgress.ts   # Session-local job ids + persistent drawer state (P2-WEB-06)
│     │  ├─ jobs/presentation.ts    # Exact-byte, phase, progress and ETA labels shared by S11 and its drawer
│     │  ├─ components/common/ToastHost.vue  # Renders the queue (position is P1-WEB-07's)
│     │  ├─ components/admin/UserMenu.vue    # exists: who is signed in, and the way out
│     │  ├─ components/admin/JobProgressDrawer.vue # exists: global 2 s detail polling, progress, cancel, safe errors
│     │  ├─ plugins/vuetify.ts     # createAppVuetify(): both themes, built from styles/tokens.ts
│     │  ├─ plugins/pinia.ts
│     │  ├─ theme/policy.ts        # Path → theme (admin dark, public light, auth follows the system)
│     │  ├─ styles/
│     │  │  ├─ tokens.ts           # The palette of 13 §2 + themeFrom() + contrastRatio()/bestOn()
│     │  │  ├─ tokens.css          # --mm-* spacing/radius/motion/focus, focus ring, reduced motion
│     │  │  ├─ shell.css           # exists: skip link and the breadcrumb trail (P1-WEB-07)
│     │  │  ├─ catalog.css         # exists: responsive catalog table/cards (P2-WEB-01)
│     │  │  ├─ cache.css            # exists: responsive cache table/cards + detail/version actions (P2-WEB-03/04)
│     │  │  ├─ jobs.css             # exists: queue table/cards and persistent progress panel (P2-WEB-06)
│     │  │  ├─ public.css           # public shell, catalog empty state, detail/API guide and not-found states (P3-WEB-01…05)
│     │  │  └─ typography.css      # @font-face (Space Grotesk, 22 kB) + the type roles
│     │  ├─ assets/fonts/          # space-grotesk-latin-wght.woff2 + OFL.txt
│     │  ├─ stores/                # notifications, auth and jobProgress exist; catalog, cache,
│     │  │                         # versions, intervals, jobs, system are future feature stores
│     │  ├─ composables/           # useApi (exists), usePolling (VueUse),
│     │  │                         # useConfirm, useByteFormat, useUpdateTicker
│     │  ├─ layouts/
│     │  │  ├─ AdminLayout.vue     # exists: topbar, drawer, trail, skip link (P1-WEB-07)
│     │  │  ├─ adminShell.ts       # exists: 248 / 64 / 1024, the numbers §3 states
│     │  │  ├─ PublicLayout.vue     # exists: public header, theme preference, attribution footer (P3-WEB-01)
│     │  │  └─ (auth remains a focused bare v-main)
│     │  ├─ pages/
│     │  │  ├─ PlaceholderPage.vue       # Shared fallback for admin screens not built yet
│     │  │  ├─ auth/LoginPage.vue        # exists (P1-WEB-06): the one page outside /_site
│     │  │  ├─ admin/CatalogPage.vue     # exists (P2-WEB-01): filters, sort, pagination, responsive table/cards
│     │  │  ├─ admin/CachePage.vue        # exists (P2-WEB-03): cache list, size sort, URL filters, table/cards
│     │  │  ├─ admin/CacheCountryPage.vue # exists (P2-WEB-04, P3-WEB-06): detail, public switch, active jobs, paginated versions, streamed download/delete
│     │  │  ├─ admin/JobsPage.vue          # exists (P2-WEB-06): queue filters, progress rows/cards
│     │  │  ├─ admin/{Dashboard,Intervals,Import,
│     │  │  │        System,Settings,Audit}Page.vue
│     │  │  ├─ public/{Home,CountryDetail,ApiDocs,NotFound}Page.vue  # Home (P3-WEB-01/05), CountryDetail (P3-WEB-02/03), ApiDocs (P3-WEB-04), NotFound (P3-WEB-05)
│     │  ├─ components/
│     │  │  ├─ common/             # PageHeader, DataTableShell, EmptyState, ErrorState,
│     │  │  │                      # SkeletonBlock, ConfirmDialog, CopyField, StatCard
│     │  │  ├─ cache/              # CacheTable, VersionTable, PublicToggle, UpdateBadge,
│     │  │  │                      # DownloadProgress, DeleteDialogs
│     │  │  ├─ catalog/            # CountrySearch, CountryPicker, SourceVersionPicker
│     │  │  ├─ intervals/          # IntervalForm, IntervalRuns, SchedulePreview
│     │  │  ├─ charts/             # CpuChart, MemoryChart, DiskChart, TimeWindowSelect
│     │  │  └─ public/             # CountryCard, VersionList, DownloadButton, LicenseNote
│     │  ├─ styles/                # tokens.css, typography, overrides
│     │  └─ types/                 # RouteMeta augmentation + re-exports from @mapmirror/shared
│     └─ tests/                    # Component + store tests (Vitest + jsdom); law-router.test.ts is L1
│                                  # for the SPA, dev-server.spec.ts boots a real Vite on port 0
│
├─ packages/
│  └─ shared/                      # Single source of truth for API contracts
│     ├─ src/
│     │  ├─ routes.ts              # Prefixes + path classification (L1) — no deps, no globals
│     │  ├─ errors.ts              # 25 HTTP codes → statuses, 4 internal codes, envelope type
│     │  ├─ pagination.ts          # parsePagination/buildPageMeta, defaults + clamping
│     │  ├─ license.ts             # ODbL + Geofabrik attribution strings
│     │  ├─ constants.ts           # Token format, sort fields, 9 DB-mirrored vocabularies
│     │  ├─ catalog.ts             # Catalog listing and sync-trigger request/response contracts
│     │  ├─ catalog-region.ts      # Region detail and snapshot request/response contracts
│     │  ├─ schemas/               # Zod request/response schemas (with the API contract tasks)
│     │  ├─ types/                 # z.infer exports (no hand-written duplicates)
│     │  └─ index.ts
│     └─ tests/                    # Contract tests (routes, errors, pagination, license, enums)
│
├─ scripts/                        # Operator-facing CLI + repo checks (bun run …)
│  ├─ check-hygiene.ts             # Gate stage 2: ignore matrix, env-doc parity, .dockerignore safelist
│  ├─ check-workspaces.ts          # Gate stage 1: workspace wiring assertions
│  ├─ tests/                       # CLI tests (scripts project in Vitest)
│  │  └─ sync-catalog.spec.ts      # Arguments, config errors, shared queue behavior
│  ├─ init-admin.ts                # Launch script: create admin from ADMIN_PASSWORD* (idempotent, never echoes)
│  ├─ lib/
│  │  ├─ secret-prompt.ts         # Hidden terminal input: raw mode first, no echo, Ctrl-C/Ctrl-D
│  │  └─ dockerignore.ts          # exists (P1-DOCK-01): .dockerignore matching, one answer for gate + image test
│  ├─ reset-admin-password.ts      # Reset + revoke all sessions (--generate / --password-stdin / prompt)
│  ├─ migrate.ts                   # Run Kysely migrations (also run on boot)
│  ├─ wait-for-db.ts               # exists (P1-DOCK-04): `select 1` until the database answers, 60 s deadline
│  ├─ sync-catalog.ts              # Idempotently enqueue/reuse a catalog_sync job
│  ├─ backup.sh / restore.sh       # pg_dump + cache manifest
│  └─ seed-dev.ts                  # Dev fixtures (never runs in production)
│
├─ docker/
│  ├─ api.Dockerfile               # exists (P1-DOCK-01): deps → runtime, uid 10001, bun 1.4.4
│  ├─ web.Dockerfile               # exists (P1-DOCK-02): Vite build → nginx runtime, uid 101
│  ├─ nginx.conf                   # exists (P1-DOCK-02/03): unprivileged server, APIs before pages,
│  │                               # SPA fallback, shell headers, gzip, streaming, cache policy,
│  │                               # `upstream` + `resolve` so a recreated API is followed (pass 44)
│  ├─ entrypoint.api.sh            # exists (P1-DOCK-04): wait-for-db → migrate → init-admin --bootstrap → exec API
│  └─ caddy.example                # TLS termination example (D-15)
│
├─ docs/                           # This folder (Phase 0)
│
└─ data/                           # Gitignored, Docker volumes in production
   ├─ cache/<country-slug>/<version>/<file>.osm.pbf
   ├─ tmp/                         # *.part files, upload staging
   └─ pg/                          # PostgreSQL data (volume only)
```

## Storage layout (canonical)

```
/data/cache/
└─ finland/                       # country.slug
   ├─ 260101/
   │  └─ finland-260101.osm.pbf
   └─ 261023/
      └─ finland-261023.osm.pbf
```

- Path is always derived: `CACHE_DIR/<slug>/<version>/<source-filename>`.
- Slug and version are validated (`^[a-z0-9][a-z0-9-]*$`, `^[A-Za-z0-9._-]{1,32}$`) before use.
- Temporary files: `/data/tmp/<job-id>.part`, removed on failure/cancel.

## Naming rules

| Thing | Convention | Example |
|---|---|---|
| DB tables | snake_case, plural | `map_versions` |
| DB columns | snake_case | `created_at` |
| TS files | kebab-case | `parse-region.ts` |
| Vue components | PascalCase | `CacheTable.vue` |
| Zod schemas | PascalCase + `Schema` | `LoginRequestSchema` |
| API routes | plural nouns, kebab-case | `/_admin/api/cache/:countryId/versions` |
| Task IDs | `P<phase>-<AREA>-<nn>` | `P2-JOB-03` |
| ADRs | `ADR-00N` | `ADR-001` |
