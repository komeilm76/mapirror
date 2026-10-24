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

**Phase 0 — documentation.** No application code yet; the build starts after the docs are approved.

| | |
|---|---|
| Requirements & decisions | [`PROMPT.md`](PROMPT.md) |
| Documentation index | [`docs/00-index.md`](docs/00-index.md) |
| Roadmap | [`docs/07-roadmap.md`](docs/07-roadmap.md) |
| Tasks | [`docs/08-tasks.md`](docs/08-tasks.md) |
| API contract | [`docs/04-api.md`](docs/04-api.md) |

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
