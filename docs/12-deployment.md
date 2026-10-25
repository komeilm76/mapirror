# 12 — Deployment (Ubuntu 24.04 + Docker)

Three containers (Nginx, API, PostgreSQL), two volumes, one `.env`. TLS is terminated by an external
reverse proxy (D-15).

## 1. Server prerequisites

```bash
# Ubuntu 24.04 LTS
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl git ufw

# Docker Engine + Compose plugin (official repo)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "$USER" && newgrp docker
docker compose version
```

Firewall (adjust if a proxy runs on another host):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 8080/tcp     # or 80/443 only, if the proxy is on this machine
sudo ufw enable
```

## 2. Install MapMirror

```bash
sudo mkdir -p /opt/mapirror && sudo chown "$USER:$USER" /opt/mapirror
git clone <repo-url> /opt/mapirror && cd /opt/mapirror

cp .env.example .env
# edit .env:
#   ADMIN_PASSWORD=<strong, ≥12 chars>
#   PUBLIC_BASE_URL=https://maps.example.com
#   POSTGRES_PASSWORD=<strong>
chmod 600 .env

docker compose up -d --build
docker compose ps
docker compose logs -f api
```

**Do not edit `DATABASE_URL`.** Inside the containers it is derived — `postgres://mapirror:<POSTGRES_PASSWORD>@db:5432/mapirror` — so changing `POSTGRES_PASSWORD` is enough and the two can never disagree. The copy in `.env` is for running the API outside Docker (native dev, tests). The same rule applies to `CACHE_DIR` / `TMP_DIR`, which compose points at the mounted volumes (`/data/cache`, `/data/tmp`).

First boot performs, in order: wait for DB → run migrations → create the admin (idempotent) → start
the API, worker and scheduler. Nothing manual is required (DOCK-2).

Verify:

```bash
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/readyz
curl -sI http://localhost:8080/ | head -1          # expect 302 → /_site/
curl -s  http://localhost:8080/_public/api/countries
```

Then open `http://<server>:8080/_auth/login` and log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

> Change the password through the reset script immediately if the bootstrap password was shared
> in any channel.

**Database extensions.**

`0001_init.sql` creates `pg_trgm` (search) and optionally `unaccent`. Both are *trusted* extensions in
PostgreSQL 13+, so the database **owner** can create them without superuser rights — the default
`postgres` user in the container is fine. If you point MapMirror at an externally managed database:

```bash
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'   # once, as an admin
```

Otherwise the first boot fails at migration with a clear `permission denied to create extension`
message — that is the only manual step a managed database ever needs.

## 3. TLS with an external reverse proxy

### Caddy (simplest)

```caddyfile
maps.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080 {
        # allow long downloads and uploads
        flush_interval -1
    }
}
```

### Nginx as the outer proxy

```nginx
server {
  listen 443 ssl http2;
  server_name maps.example.com;
  ssl_certificate     /etc/letsencrypt/live/maps.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/maps.example.com/privkey.pem;

  client_max_body_size 9g;         # imports (MAX_UPLOAD_BYTES + headroom)
  proxy_read_timeout 3600s;        # large downloads
  proxy_send_timeout 3600s;
  proxy_buffering off;             # stream downloads, don't buffer gigabytes on disk
  proxy_request_buffering off;     # stream uploads straight through

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Set `PUBLIC_BASE_URL=https://maps.example.com` so generated links are correct, and keep port 8080
bound to localhost or firewalled when a proxy fronts it.

### How the internal Nginx container routes (order matters)

```nginx
# in docker/nginx.conf — most specific first
location ^~ /_auth/api/   { proxy_pass http://api:3000; }   # auth JSON  ─┐ must come before
location ^~ /_admin/api/  { proxy_pass http://api:3000; }   # admin JSON   │ the SPA fallback,
location ^~ /_public/api/ { proxy_pass http://api:3000; }   # public JSON  │ otherwise the login
location =  /healthz      { proxy_pass http://api:3000; }   # probes      ─┘ page rule swallows it
location =  /readyz       { proxy_pass http://api:3000; }
location =  /_auth/login  { try_files /index.html =404; }   # the one page outside /_site
location ^~ /_site/       { try_files $uri /index.html; }   # SPA deep links
location =  /             { return 302 /_site/; }
location /                { try_files $uri =404; }          # assets; unknown paths 404
```

`proxy_request_buffering off` matters: without it Nginx spools a multi-gigabyte import to its own disk
before forwarding it, doubling disk usage and delaying progress.

## 4. Configuration

All configuration is environment-based (list in `09-development.md` §5). Production notes:

| Concern | Recommendation |
|---|---|
| Secrets | `chmod 600 .env`, or mount `ADMIN_PASSWORD_FILE` / `POSTGRES_PASSWORD_FILE` as Docker secrets |
| Storage | `CACHE_DIR` on a dedicated volume/disk; **plan ~1 TB for a dozen countries** (Europe alone is ~33 GB) |
| Disk reserve | `DISK_RESERVE_BYTES` default 2 GiB — increase on small disks |
| Tokens | `AUTH_TOKEN_TTL_HOURS` 8–12 for admins |
| Public limits | Start at `PUBLIC_DOWNLOADS_PER_MINUTE=10`; raise if legitimate traffic needs it |
| Logs | `LOG_LEVEL=info`; `docker compose logs` or a log driver |

## 5. Storage sizing

| Scope | Size |
|---|---|
| Finland | ~737 MB per version |
| Germany | ~4 GB per version |
| Europe | ~33 GB per version |
| 3 versions × 10 mid-size countries | ~15–40 GB |

Retention keeps 3 versions by default (D-7) — the admin cache page shows the projected footprint and
`/system/status` reports free space with the reserve subtracted.

## 6. Operations

### Logs

```bash
docker compose logs -f api          # application + jobs
docker compose logs -f web          # nginx access/error
docker compose logs --tail=200 db
```

### Restart / update

```bash
git pull
docker compose build
docker compose up -d                # migrations run on boot
docker compose ps
```

Rollback: `git checkout <previous-tag> && docker compose up -d --build`. Migrations are forward-only;
restore the database backup if a rollback crosses a schema change.

### Admin password reset

```bash
make reset-admin                                   # interactive (hidden prompt, confirmed)
# or, non-interactive — prints the generated password once
docker compose exec -T api bun run admin:reset --username admin --generate
# or the script directly (same thing)
docker compose exec api bun run scripts/reset-admin-password.ts --username admin
```

All three forms revoke the admin's existing tokens, so any open admin tab is signed out immediately.

### Backup

```bash
./scripts/backup.sh                 # runs ON THE HOST; shells into the containers
```

`scripts/backup.sh` is a host-side wrapper: `docker compose exec -T db pg_dump …` for the database,
then it walks `/data/cache` through the `api` container to write the manifest. Output goes to
`./backups/<timestamp>/` (gitignored).

Backs up:

- `pg_dump --format=custom` of the database (authoritative state),
- a manifest of cached artifacts (path, size, md5) — the files themselves are already checksummed and
  can be re-downloaded from the source if lost.

Recommended cron:

```cron
15 2 * * * cd /opt/mapirror && ./scripts/backup.sh >> /var/log/mapmirror-backup.log 2>&1
```

### Restore

```bash
docker compose stop api
./scripts/restore.sh backups/2026-10-24T021500Z
docker compose start api
```

The restore script recreates the database and restores the dump. It does **not** restore map files —
the backup contains a manifest, not terabytes of artifacts. Instead it reconciles: every `ready` version
whose file is present on the volume is verified against its recorded md5; every missing file is marked
`failed` with `VERSION_FILE_MISSING` and appears in the admin UI as "file missing — re-download".

That is deliberate: re-downloading a country from Geofabrik is cheaper and more trustworthy than
restoring a copy from backup. A restore drill — including the missing-artifact path — is required in
Phase 6 (`P6-OPS-01`).

## 7. Monitoring the deployment

- `/healthz` — process alive (use for restarts). It checks nothing else on purpose: a liveness probe that
  consults Postgres restarts a healthy API every time the database blinks.
- `/readyz` — DB reachable + cache dir writable (use for load-balancer gating). Two checks, concurrent, each
  bounded at 2 s, so a hung connection cannot stall the probe. `503` names the failing checks in the body and
  the reason in the API log.
- Both answer `GET`/`HEAD` with `cache-control: no-store` and need no credentials. Keep `/readyz` on the
  internal network where your load balancer can reach it; it performs a `select 1` and a small file write per
  call, and it is deliberately not rate limited (a probe must never be throttled). Docker's own healthcheck
  should use `/healthz`, because a container that restarts on readiness has the same restart-loop problem.
- Admin dashboard `/_site/admin/` — CPU/RAM/disk charts, jobs, updates available, disk headroom.
- Optional: point an uptime monitor at `/_public/api/stats` and a disk alarm at `/_admin/api/system/status`.

## 8. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| `api` restarts in a loop | `docker compose logs api` | Env error, DB not ready, or permission on `CACHE_DIR` |
| 502 from Nginx | `curl localhost:3000/healthz` inside the network | API down or crashed |
| Downloads stop at 1 GB | Proxy body/timeout limits | Raise `proxy_read_timeout`, disable buffering |
| `413` on import | `client_max_body_size` | Raise in nginx config (`docker/nginx.conf` and outer proxy) |
| Permission denied writing cache | Volume ownership | `chown -R $(docker compose exec -T api id -u):$(docker compose exec -T api id -g) <volume>` (the container runs non-root) |
| Slow catalog | No index after migration | Re-run migrations; check `countries_name_trgm` exists |

## 9. Uninstall

```bash
docker compose down            # keep data
docker compose down -v         # ⚠ deletes database + cached maps
sudo rm -rf /opt/mapirror
```
