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
├─ compose.yaml                    # db + api + web (+ backup profile)
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
│  │  │  │  │  ├─ routes/{catalog,cache,versions,imports,intervals,jobs,system,settings,audit}.ts
│  │  │  │  │  └─ services/{cache,versions,publication,intervals,metrics}.ts
│  │  │  │  ├─ public/             # /_public/api: countries, versions, download, stats
│  │  │  │  ├─ geofabrik/          # MapSource impl: index sync, page parse, HEAD, versions
│  │  │  │  │  ├─ source.ts        # MapSource interface (thin, 4 methods)
│  │  │  │  │  ├─ geofabrik.ts     # Implementation
│  │  │  │  │  ├─ parse-region.ts  # HTML table parser for dated snapshots
│  │  │  │  │  └─ fixtures/        # Saved HTML/JSON samples for offline tests
│  │  │  │  ├─ jobs/               # Queue + worker
│  │  │  │  │  ├─ queue.ts         # claim/complete/fail with FOR UPDATE SKIP LOCKED
│  │  │  │  │  ├─ worker.ts        # Loop, concurrency, graceful stop
│  │  │  │  │  ├─ handlers/        # download.ts, import.ts, update-check.ts,
│  │  │  │  │  │                   # catalog-sync.ts, prune.ts, delete.ts
│  │  │  │  │  └─ scheduler.ts     # Interval evaluation (daily/weekly/monthly)
│  │  │  │  └─ system/             # Metrics sampler (CPU/RAM/disk), disk preflight
│  │  │  ├─ db/
│  │  │  │  ├─ migrations/         # 0001_init.sql … (SQL only, Kysely migrator)
│  │  │  │  ├─ migrator.ts         # SQL provider, migrateToLatest/resetDatabase, name rules
│  │  │  │  ├─ transaction.ts      # withTransaction: idle/statement bounds, read-only, retry 40001/40P01
│  │  │  │  ├─ schema.ts           # Kysely table types, phase 1 (measured JS types, no `any`)
│  │  │  │  ├─ version-check.ts    # Boot gate: disk vs EXPECTED_MIGRATIONS vs kysely_migration (SCHEMA_SKEW)
│  │  │  │  └─ repositories/       # Typed queries per aggregate
│  │  │  │     └─ admin-tokens.ts  # Token rows: insert, find-with-admin, touch, revoke, prune
│  │  │  └─ lib/
│  │  │     ├─ client-ip.ts        # Untrusted forwarded address → a value `inet` accepts, or null
│  │  │     ├─ rate-limit.ts       # Sliding-window limiter: bounded, injectable clock, refusal is free
│  │  │     ├─ housekeeping.ts     # Boot-time token pruning: bounded, off the boot path, never fatal
│  │  │     ├─ storage.ts          # Path building, .part files, atomic rename, delete
│  │  │     ├─ download.ts         # Streamed fetch, resume, progress, checksum
│  │  │     ├─ checksum.ts         # MD5/SHA-256 streaming
│  │  │     ├─ time.ts             # UTC helpers, schedule math (tested)
│  │  │     ├─ errors.ts           # AppError subclasses + codes
│  │  │     └─ logger.ts           # Pino config with redaction
│  │  └─ tests/                    # law-routes, auth, cache, public, scheduler, source
│  │
│  └─ web/                         # Vue 3 + Vuetify 3 SPA (served by nginx)
│     ├─ package.json              # vue, vue-router, vuetify, pinia, @vueuse/core
│     ├─ index.html                # The mount point (`#app`) and the module script
│     ├─ vite.config.ts            # Vue + vite-plugin-vuetify, `@` alias, host/port (§09)
│     ├─ alias.ts                  # `@` → src, shared by vite.config, vitest.config and the tests
│     ├─ src/
│     │  ├─ main.ts                # Two lines: build the app, mount it
│     │  ├─ bootstrap.ts           # createWebApp(): Pinia → Vuetify → Router, one factory each
│     │  ├─ App.vue                # v-app → v-main → router-view (the one shell)
│     │  ├─ shims-vue.d.ts         # `*.vue` for plain-tsc consumers (ESLint); vue-tsc ignores it
│     │  ├─ vite-env.d.ts          # Vite's ambient types (the web tsconfig sets `types: []`)
│     │  ├─ router/index.ts        # `/` → `/_site/` and the home route; the full tree is P1-WEB-03
│     │  ├─ router/paths.ts        # Page path builders, all derived from @mapirror/shared
│     │  ├─ plugins/vuetify.ts     # createAppVuetify(); the two themes are P1-WEB-02
│     │  ├─ plugins/pinia.ts
│     │  ├─ stores/                # auth, catalog, cache, versions, intervals, jobs,
│     │  │                         # system, ui (toasts/snackbars)
│     │  ├─ composables/           # useApi (fetch+error), usePolling (VueUse),
│     │  │                         # useConfirm, useByteFormat, useUpdateTicker
│     │  ├─ layouts/               # AdminLayout, PublicLayout, AuthLayout
│     │  ├─ pages/
│     │  │  ├─ auth/LoginPage.vue        # served at /_auth/login (the one page outside /_site)
│     │  │  ├─ admin/{Dashboard,Catalog,Cache,CountryDetail,Intervals,Import,Jobs,
│     │  │  │        System,Settings,Audit}Page.vue
│     │  │  ├─ public/{Home,CountryDetail,ApiDocs,NotFound}Page.vue  # HomePage.vue exists (P1-WEB-01)
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
│     │  └─ types/                 # Re-exports from @mapmirror/shared
│     └─ tests/                    # Component + store tests (Vitest + jsdom), setup.ts stubs matchMedia/RO
│
├─ packages/
│  └─ shared/                      # Single source of truth for API contracts
│     ├─ src/
│     │  ├─ routes.ts              # Prefixes + path classification (L1) — no deps, no globals
│     │  ├─ errors.ts              # 25 HTTP codes → statuses, 4 internal codes, envelope type
│     │  ├─ pagination.ts          # parsePagination/buildPageMeta, defaults + clamping
│     │  ├─ license.ts             # ODbL + Geofabrik attribution strings
│     │  ├─ constants.ts           # Token format, sort fields, 9 DB-mirrored vocabularies
│     │  ├─ schemas/               # Zod request/response schemas (with the API contract tasks)
│     │  ├─ types/                 # z.infer exports (no hand-written duplicates)
│     │  └─ index.ts
│     └─ tests/                    # Contract tests (routes, errors, pagination, license, enums)
│
├─ scripts/                        # Operator-facing CLI + repo checks (bun run …)
│  ├─ check-hygiene.ts             # Gate stage 2: ignore matrix, env-doc parity, .dockerignore safelist
│  ├─ check-workspaces.ts          # Gate stage 1: workspace wiring assertions
│  ├─ tests/                       # CLI tests (scripts project in Vitest)
│  ├─ init-admin.ts                # Launch script: create admin from ADMIN_PASSWORD* (idempotent, never echoes)
│  ├─ lib/
│  │  └─ secret-prompt.ts         # Hidden terminal input: raw mode first, no echo, Ctrl-C/Ctrl-D
│  ├─ reset-admin-password.ts      # Reset + revoke all sessions (--generate / --password-stdin / prompt)
│  ├─ migrate.ts                   # Run Kysely migrations (also run on boot)
│  ├─ sync-catalog.ts              # Manual catalog sync (cron-friendly)
│  ├─ backup.sh / restore.sh       # pg_dump + cache manifest
│  └─ seed-dev.ts                  # Dev fixtures (never runs in production)
│
├─ docker/
│  ├─ api.Dockerfile               # Multi-stage Bun build → non-root runtime
│  ├─ web.Dockerfile               # Vite build → nginx runtime
│  ├─ nginx.conf                   # /_auth/api/ before /_auth/login, SPA fallback, proxy, tuning
│  ├─ entrypoint.api.sh            # migrate → init-admin → start API+worker
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
