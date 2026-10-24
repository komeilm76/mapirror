# 06 — Diagrams

All diagrams are Mermaid and render on GitHub. Update them with the code they describe.

## 1. System context

```mermaid
C4Context
  title MapMirror — system context
  Person(admin, "Admin", "Caches, versions, publishes, schedules")
  Person(visitor, "Visitor", "Downloads published countries")
  Person(consumer, "API consumer", "Scripts/apps using /_public/api")
  System(mm, "MapMirror", "Cache + mirror for OSM extracts")
  System_Ext(gf, "Geofabrik", "Upstream OSM extract server (ODbL)")
  System_Ext(proxy, "TLS reverse proxy", "Caddy/Traefik in front of Nginx :8080")

  Rel(admin, mm, "HTTPS", "/_auth, /_admin")
  Rel(visitor, mm, "HTTPS", "/_public")
  Rel(consumer, mm, "HTTPS", "/_public/api")
  Rel(proxy, mm, "proxy", "http://:8080")
  Rel(mm, gf, "index, region pages, pbf + md5", "HTTPS")
```

## 2. Container view

```mermaid
flowchart TB
  subgraph host["Ubuntu 24.04 host"]
    proxy["Reverse proxy (TLS)\noptional, operator-owned"]
    subgraph compose["docker compose"]
      web["web (nginx:alpine)\nSPA + /_auth /_admin /_public proxy\n:8080"]
      api["api (bun)\nFastify + worker + scheduler\n:3000 internal"]
      db[("db (postgres:16)")]
      vol1[("/data/cache (volume)")]
      vol2[("/var/lib/postgresql/data (volume)")]
    end
  end
  proxy --> web
  web -->|proxy| api
  api --> db
  api --> vol1
  db --> vol2
  api -.->|HTTPS| gf["Geofabrik"]
```

## 3. Deployment on Ubuntu 24.04

```mermaid
flowchart LR
  u["User"] -->|443| caddy["Caddy / Traefik\n(TLS, provider)"]
  caddy -->|8080| nginx["Nginx container"]
  nginx -->|3000| fastify["API container"]
  fastify --> pg["Postgres container"]
  fastify --> cache[("cache volume")]
  fastify -->|outbound 443| geofabrik["download.geofabrik.de"]
  backup["backup profile\npg_dump + manifest"] -.-> pg
  backup -.-> cache
```

## 4. API namespace map

```mermaid
flowchart LR
  root["/"] -->|302| site["/_site/"]
  site --> pages["/_site/*\npublic pages (SPA)"]
  site --> adm["/_site/admin/*\nadmin panel pages (SPA)"]
  login["/_auth/login\nlogin page (SPA)"]
  pages --> papi["/_public/api/*\nJSON, anonymous"]
  adm --> aapi["/_admin/api/*\nJSON, Bearer"]
  login --> auth["/_auth/api/*\nJSON: login / logout / me"]
  adm --> dash["/_site/admin/cache/finland\ndeep links rewritten to index.html"]
```

## 5. Data model (compact)

```mermaid
erDiagram
  admins ||--o{ admin_tokens : ""
  countries ||--|| country_cache : ""
  countries ||--o{ map_versions : ""
  countries ||--o{ interval_countries : ""
  intervals ||--o{ interval_countries : ""
  intervals ||--o{ interval_runs : ""
  interval_runs ||--o{ interval_run_items : ""
  countries ||--o{ download_events : ""
  admins ||--o{ audit_logs : ""
```

Full DDL: [`03-data-model.md`](03-data-model.md).

## 6. Job state machine

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running : claimed
  queued --> canceled : admin cancel
  running --> succeeded : verify + install
  running --> failed : error / checksum / source gone
  running --> canceled : cancel flag seen
  failed --> queued : retry if attempts < max
  failed --> [*] : attempts exhausted
  succeeded --> [*]
  canceled --> [*]
```

## 7. Cache lifecycle per country

```mermaid
stateDiagram-v2
  [*] --> Uncached
  Uncached --> Cached : first download/import ready
  Cached --> Published : admin flips switch (needs ready version)
  Published --> Cached : admin flips switch off
  Cached --> Cached : add version / prune to 3 / update
  Cached --> Uncached : delete last version or delete country
  Published --> Uncached : delete last version (auto-unpublish)
```

## 8. Update check decision

```mermaid
flowchart TD
  a["Check for update"] --> b{Source reachable?}
  b -- no --> c["unknown\n(show retry)"]
  b -- yes --> d{Source newest data timestamp\nnewer than newest cached?}
  d -- no --> e["up_to_date"]
  d -- yes --> f{That version already cached?}
  f -- yes --> e
  f -- no --> g["update_available\n+ Download update"]
```

## 9. Interval scheduling timeline (daily 03:00 UTC)

```mermaid
gantt
  title Daily interval with keep=3
  dateFormat  YYYY-MM-DD HH:mm
  axisFormat  %m-%d %H:%M
  section Scheduled
  03:00 run (261023 kept) :2026-10-23 03:00, 5m
  03:00 run (261024 added) :2026-10-24 03:00, 5m
  03:00 run               :2026-10-25 03:00, 5m
  section Retention
  prune to newest 3        :2026-10-24 03:05, 1m
```

## 10. Admin SPA navigation

```mermaid
flowchart LR
  login["/_auth/login"] --> dash["/_site/admin (dashboard)"]
  dash --> catalog["/_site/admin/catalog"]
  dash --> cache["/_site/admin/cache"]
  cache --> detail["/_site/admin/cache/:slug"]
  dash --> intervals["/_site/admin/intervals"]
  dash --> imports["/_site/admin/import"]
  dash --> jobs["/_site/admin/jobs"]
  dash --> system["/_site/admin/system"]
  dash --> settings["/_site/admin/settings"]
  dash --> audit["/_site/admin/audit"]
  catalog -->|download| jobs
  detail -->|versions, public, check update| detail
```

## 11. Public SPA navigation

```mermaid
flowchart LR
  home["/_site/ catalog"] --> country["/_site/countries/:slug"]
  home --> apidocs["/_site/api-docs"]
  country -->|Download| file["file stream"]
  apidocs -->|copy curl| file
```
