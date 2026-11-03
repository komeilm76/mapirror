# MapMirror

Self-hosted **cache and download mirror** for OpenStreetMap country extracts (Geofabrik).

One admin caches countries, keeps their versions, publishes the ones that should be public, schedules
automatic refreshes, and watches CPU/RAM/disk. Everyone else browses the published maps and downloads
them — no account needed.

```
Admin   →  /_auth/login  ·  /_site/admin/*   +  /_admin/api/*   (Bearer token)
Public  →  /_site/*       ·  /_public/api/*  (anonymous)
```

## Status

| | |
|---|---|
| **Phase 0 — documentation** | ✅ released as [`v0.1.0`](https://github.com/komeilm76/mapirror/releases/tag/v0.1.0) |
| **Phase 6 — hardening & release** | 🟦 in progress (`0.2.0-dev`) |

The API, public site, admin UI, worker and Docker Compose deployment are implemented. Phase 6 is still in progress: operator-run Docker/PostgreSQL drills and the fresh-Ubuntu deployment verification remain before release. See the [task board](docs/08-tasks.md) for current evidence and open checks.

| | |
|---|---|
| Requirements & decisions | [`PROMPT.md`](PROMPT.md) |
| Documentation index | [`docs/00-index.md`](docs/00-index.md) |
| Roadmap | [`docs/07-roadmap.md`](docs/07-roadmap.md) |
| Tasks | [`docs/08-tasks.md`](docs/08-tasks.md) |
| API contract | [`docs/04-api.md`](docs/04-api.md) |
| Changelog | [`CHANGELOG.md`](CHANGELOG.md) |

## Repository layout

```
apps/api        Fastify API, job worker and interval scheduler
apps/web        Vue 3 + Vuetify SPA (public site + admin panel)
packages/shared The contracts both apps import: route law, error codes, pagination, licence, enums
scripts         operator CLI (admin bootstrap/reset, migrate, catalog sync)
docs            the specification set
```

Bun workspaces; the root `package.json` holds the release version (`0.2.0-dev`), the workspaces are
private and versionless. Dependency graph: `apps/* → packages/shared` (no other edges yet).

```bash
bun install                 # installs the locked workspace dependencies
bun run typecheck           # strict tsc across scripts + all workspaces
bun run lint                # ESLint (type-aware, Vue, zero warnings tolerated)
bun run test                # Vitest across shared, API, web and scripts projects
bun run format:check        # Prettier checks all matched repository files
bun run check:workspaces    # verifies workspace wiring
bun run check:hygiene       # ignore matrix, env-doc parity, Docker context and test collection
bun run check               # full gate: workspace/hygiene checks, typecheck, lint, formatting, build budget and tests
```

## What it does

- **Search Geofabrik** and cache a country (latest or a specific dated snapshot), streamed with
  progress, resume, and md5 verification.
- **Manage versions**: list, download, delete one version, or delete a whole country from cache.
- **Publish per country** with a switch — public by default: nothing.
- **Schedule** daily / weekly / monthly downloads across many countries, with run history.
- **Detect updates** per country, show a badge, update in one click.
- **Import** a local `.osm.pbf` with exactly three fields: file, country, version.
- **Serve the public** through a clean site and a documented JSON API (`/_public/api/*`).
- **Monitor** CPU, RAM, disk and cache size in the admin dashboard.

## Stack

Bun · TypeScript · Fastify · Zod · PostgreSQL · Kysely · Vue 3 · Vuetify 3 · VueUse · Pinia · Vite ·
Vitest · Nginx · Docker.

## Quick start (Docker Compose)

With Docker Engine and the Compose plugin installed, run from the repository root:

```bash
cp .env.example .env
chmod 600 .env
# Edit .env: set a strong POSTGRES_PASSWORD and ADMIN_PASSWORD (at least 12 characters).
docker compose up -d --build
docker compose ps
curl -fsS http://localhost:8080/readyz
```

Wait for `db`, `api` and `web` to report healthy. Then open `http://localhost:8080/_auth/login` in a browser and sign in
with the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you configured. Do not keep the example PostgreSQL password for an
exposed deployment. For Ubuntu 24.04 prerequisites, firewall/TLS setup, storage, backups and operations, follow the
[deployment runbook](docs/12-deployment.md).

## License & attribution

Map data served by MapMirror comes from [Geofabrik](https://download.geofabrik.de) and is
© OpenStreetMap contributors, licensed under
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/). Public pages display this attribution.

The embedded weak-password list (`apps/api/src/modules/auth/weak-passwords.ts`) is derived from Django's
`common-passwords.txt.gz` (© Django Software Foundation and individual contributors, BSD-3-Clause); the
licence notice sits at the top of that module.
