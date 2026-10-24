# 01 — Overview

## 1. Problem

OpenStreetMap extracts are large (Finland ≈ 737 MB, Europe ≈ 33 GB) and live on a single upstream
server. Teams need a **local mirror** that they control: predictable bandwidth, known versions,
no surprise upstream deletions, and a controlled way to expose data to other people.

## 2. Product

**MapMirror** caches OpenStreetMap country/region extracts from Geofabrik onto your own server,
keeps their versions, PIDs them with checksums, and serves them to admins (always) and to the public
(only for countries the admin publishes).

**One sentence:** *a private OSM extract mirror with versions, scheduling, update detection and a
public download portal.*

## 3. Personas

| Persona | Needs | Sees |
|---|---|---|
| **Admin (single account)** | Cache countries, manage versions, publish to the public, schedule refresh, know when upstream changed, watch disk/CPU/RAM, import offline files | Admin panel (`/_site/admin/*`) + `/_admin/api/*` |
| **Public visitor** | Find a country, check version/date/size, download it, cite the license | Public site (`/_site/*`) + `/_public/api/*` |
| **API consumer** (script/app) | List published countries, download programmatically with stable URLs | `/_public/api/*` (no UI) |
| **Operator** | Deploy on Ubuntu 24.04 with Docker, bootstrap the admin, reset a password, back up | `docs/12-deployment.md` |

## 4. In scope

- Admin authentication (username + password → Bearer token), bootstrap and reset scripts.
- Geofabrik catalog search, country selection, caching latest **or a specific dated snapshot**.
- Version management: list, download, delete per version; delete an entire country from cache.
- Per-country public switch (opt-in), public catalog + country pages, public APIs and downloads.
- Auto-download intervals (daily / weekly / monthly, multiple countries), run history, run-now.
- Per-country "check for update" + bulk check + update badge and one-click update.
- Import form: **file / country / version** (offline `.osm.pbf` upload).
- Admin dashboard charts: CPU, RAM, disk; job and storage widgets.
- Docker deployment (Nginx :8080 + API + PostgreSQL), documentation, backups.

## 5. Out of scope (deliberately, for now)

| Not building | Why / when it could change |
|---|---|
| Tile server / vector tiles | Different product; Shortbread MVT packages exist upstream and could be added as another format |
| OSM diff (`.osc.gz`) application, `pyosmium-up-to-date` workflows | Full-file mirror is the requirement; diffs are a separate feature |
| S3 / object storage | Local volume decided (D-5); storage abstraction leaves the door open |
| Multiple admin accounts UI | Schema supports it (D-4); UI is one account |
| Redis / external worker / horizontal scaling | In-process PostgreSQL queue (D-11) |
| JWT, OAuth, SSO | Opaque tokens (D-3) |
| User accounts for downloaders | Public access is anonymous and per-country (D-9) |
| i18n runtime | English only, strings centralized (D-16) |
| Format conversion (SHP, GPKG, MBTiles) | `.osm.pbf` only (D-2) |
| Trash / soft-delete recovery | Hard delete + confirmation (D-7b) |

## 6. Key product rules

1. **Nothing is public by default.** A country is downloadable by strangers only after the admin flips
   its switch, and only while at least one `ready` version exists.
2. **Only admin can download a cached map by default** — all admin downloads are authenticated and
   audited.
3. **A version is immutable.** Uploads never "merge"; duplicates are rejected unless explicitly replaced.
4. **Latest 3 versions** per country by default; pruning never removes the newest valid version.
5. **Update checks tell the truth**: unreachable source ⇒ `unknown`, not "up to date".
6. **Upstream dated snapshots are ephemeral.** Geofabrik deletes old dated files eventually, so
   MapMirror is the durable record: once cached, the version stays until pruned or deleted.
7. **Destructive actions are confirmed and audited.**
8. **Every byte served publicly is attributable**: downloads are logged (bytes, country, version,
   hashed IP) and pages show ODbL attribution.

## 7. Source facts that shape the design

Verified against `download.geofabrik.de` on 2026-10-24 (details and consequences: ADR-018, ADR-019).

| Fact | Consequence |
|---|---|
| `index-v1-nogeom.json` lists every region (id, parent, name, ISO codes, pbf URL) and its structure is **stable** | Catalog search reads JSON, not HTML; cache it in Postgres and sync on a TTL |
| Sizes, dates, "data up to", and dated snapshots exist **only** on each region's HTML page | Region detail is fetched on demand (10-min cache) with fixtures + graceful degradation |
| `-latest.osm.pbf` is overwritten in place; dated files are **deleted after a while** | A version is what *we* stored (`latest@<timestamp>` or `YYMMDD`); our cache is the archive |
| Public extracts omit `user`/`uid`/`changeset`; data is ODbL, © OpenStreetMap contributors | No PII in cached files; attribution is mandatory on public pages |

## 8. Resolved product decisions

All 16 owner decisions (D-1 … D-16) and the Phase 0 namespace decision (D-17) are in
[`15-decisions.md`](15-decisions.md). Nothing in these docs contradicts them.

## 9. Success criteria

- Admin can go from a fresh Docker install to a publicly downloadable country in **under 5 minutes**
  (excluding download time).
- A public consumer can `curl` the list and download a country with **no account**.
- The admin never has to guess whether upstream changed: the UI always shows a freshness state.
- A reviewer can score the UI ≥ **45/50** on the rubric in `13-ui-ux.md`.
- A new contributor can run the stack locally from `09-development.md` alone.
