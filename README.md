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
| **Phase 1 — foundation** | 🟨 in progress (`0.2.0-dev`) |

There is no running application yet: Phase 1 builds the workspace, Docker stack, database and auth.

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
packages/shared Zod schemas, DTO types and constants shared by both
scripts         operator CLI (admin bootstrap/reset, migrate, catalog sync)
docs            the specification set
```

Bun workspaces; the root `package.json` holds the release version (`0.2.0-dev`), the workspaces are
private and versionless. Dependency graph: `apps/* → packages/shared` (no other edges yet).

```bash
bun install                 # links the three workspaces
bun run check:workspaces    # verifies the workspace wiring (12 checks)
```

## What it will do

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

## Quick start (when Phase 1 lands)

```bash
cp .env.example .env          # set ADMIN_PASSWORD (≥ 12 chars)
docker compose up -d --build
open http://localhost:8080/_auth/login
```

Ubuntu 24.04 runbook: [`docs/12-deployment.md`](docs/12-deployment.md).

## License & attribution

Map data served by MapMirror comes from [Geofabrik](https://download.geofabrik.de) and is
© OpenStreetMap contributors, licensed under
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/). Public pages display this attribution.
