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
  System_Ext(proxy, "Optional TLS reverse proxy", "Operator-owned; forwards to host-local Nginx")

  Rel(admin, mm, "HTTPS", "/_auth, /_admin")
  Rel(visitor, mm, "HTTPS", "/_public")
  Rel(consumer, mm, "HTTPS", "/_public/api")
  Rel(proxy, mm, "HTTP to 127.0.0.1:8080", "Nginx origin")
  Rel(mm, gf, "index, region pages, PBF + MD5", "HTTPS")
```

The optional TLS proxy runs on the same host in the default Compose setup. The web container is published only on
`127.0.0.1:8080`; the API and PostgreSQL ports are not published to the host.

## 2. Container view

```mermaid
flowchart TB
  client["Browser / API client"]
  tls["Optional operator-owned TLS proxy"]
  subgraph host["Ubuntu 24.04 host"]
    hostport["127.0.0.1:8080 → web:8080"]
    subgraph compose["docker compose network"]
      web["web (nginx:1.29.0-alpine)\nSPA + /_auth /_admin /_public proxy\n:8080"]
      api["api (Bun)\nFastify + worker + scheduler\n:3000 internal only"]
      db[("db (postgres:16-alpine)")]
      vol1[("/data/cache volume")]
      vol2[("/var/lib/postgresql/data volume")]
    end
  end
  gf["Geofabrik"]

  client -->|HTTPS| tls
  tls -->|HTTP, same host| hostport
  client -.->|direct host-local HTTP, if used| hostport
  hostport --> web
  web -->|API paths / probes| api
  web -->|pages and assets| client
  api --> db
  api --> vol1
  db --> vol2
  api -.->|HTTPS| gf
```

## 3. Deployment on Ubuntu 24.04

```mermaid
flowchart LR
  user["User / API client"] -->|443 HTTPS| proxy["Optional Caddy / Traefik\nTLS termination"]
  proxy -->|HTTP to 127.0.0.1:8080| web["Compose web\nNginx :8080"]
  web -->|Compose network :3000| api["API container\nFastify + worker + scheduler"]
  api -->|Compose network :5432| pg["Postgres 16-alpine"]
  api --> cache[("cache volume")]
  api -->|outbound 443| geofabrik["download.geofabrik.de"]
  operator["Host backup script"] -.->|docker compose exec| pg
  operator -.->|manifest reads cache| cache
```

Compose publishes the web service as `127.0.0.1:8080:8080` by default. For a TLS proxy on another host, bind the web
service to the server's private interface and restrict access at the network firewall; do not assume a host firewall
alone protects a Docker-published port.

## 4. API namespace map

```mermaid
flowchart LR
  browser["Browser / API client"] --> nginx["Nginx\nstatic pages + reverse proxy"]
  nginx -->|GET / → 302| root["/_site/"]
  nginx -->|/_site/* deep links| spa["SPA shell and assets\nserved by Nginx"]
  nginx -->|GET /_auth/login| login["Login SPA shell\nserved by Nginx"]
  nginx -->|/_auth/api/*| auth["Fastify auth API\nlogin / logout / me"]
  nginx -->|/_admin/api/*\nBearer required| admin["Fastify admin API"]
  nginx -->|/_public/api/*\nanonymous, rate limited| public["Fastify public API"]
  nginx -->|/healthz, /readyz| probes["Fastify probes"]
  spa -->|same-origin requests| public
  spa -->|same-origin requests| admin
  login -->|same-origin requests| auth
```

## 5. Data model (compact)

```mermaid
erDiagram
  admins ||--o{ admin_tokens : "issues"
  admins ||--o{ audit_logs : "acts"
  admins o|--o{ upload_sessions : "creates"
  countries ||--|| country_cache : "has state"
  countries ||--o{ map_versions : "has"
  countries ||--o{ upload_sessions : "stages"
  countries ||--o{ interval_countries : "selected by"
  intervals ||--o{ interval_countries : "targets"
  intervals ||--o{ interval_runs : "fires"
  interval_runs ||--o{ interval_run_items : "contains"
  countries ||--o{ interval_run_items : "snapshots"
  countries ||--o{ download_events : "records"
  map_versions ||--o{ download_events : "records"
  jobs }o--|| countries : "countryId in JSON payload"
  settings
  metrics_samples
```

`jobs` identify country targets in a JSON payload rather than a foreign key. `settings` stores configuration markers;
`metrics_samples` stores bounded dashboard history. Full DDL: [`03-data-model.md`](03-data-model.md).

## 6. Job state machine

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running : worker claims
  queued --> canceled : admin cancels immediately
  running --> succeeded : handler completes and persists
  running --> queued : JOB_HANDLER_FAILED / WORKER_LOST retry with backoff
  running --> failed : attempts exhausted
  running --> canceled : cancellation cleanup completes
  succeeded --> [*]
  failed --> [*]
  canceled --> [*]
```

A running cancellation request does not change the durable job status immediately: the owner observes it, aborts the
handler, waits for cooperative cleanup, then marks the job canceled. `WORKER_LOST` either requeues with backoff or
becomes terminal after attempts are exhausted.

## 7. Cache lifecycle per country

```mermaid
stateDiagram-v2
  [*] --> Uncached
  Uncached --> Cached : first download or import becomes ready
  Cached --> Published : admin publishes (requires a ready version)
  Published --> Cached : admin unpublishes
  Cached --> Cached : add version / retention prune / update
  Cached --> Uncached : delete cache or last version row
  Published --> Uncached : delete cache
  Published --> Cached : last ready version removed; auto-unpublish
```

Deleting the cache preserves the catalog country but removes its interval memberships. Deleting the last ready version
closes publication even if pending or failed version rows remain.

## 8. Update check decision

```mermaid
flowchart TD
  start["Check for update"] --> reachable{Source page fetched and parsed?}
  reachable -- no --> unknown["unknown\n(show retry; do not claim up to date)"]
  reachable -- yes --> identity{Current source snapshot already cached and ready?}
  identity -- yes --> current["up_to_date"]
  identity -- no --> timestamps{Both source and newest-cache timestamps known?}
  timestamps -- no --> fallback{Both sizes known and different?}
  fallback -- yes --> available["update_available"]
  fallback -- no --> unknown
  timestamps -- yes --> newer{Source timestamp newer?}
  newer -- yes --> available
  newer -- no --> older{Source timestamp older?}
  older -- yes --> current
  older -- no --> size{Both sizes known and different?}
  size -- yes --> available
  size -- no --> current
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
  cache --> detail["/_site/admin/cache/:countryId"]
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
  country -->|Download| file["public file stream"]
  apidocs -->|copy curl| api["same-origin /_public/api"]
  api --> file
```
