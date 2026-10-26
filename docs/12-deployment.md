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

### What `compose.yaml` starts

| Service | From | Published | Volume | Healthcheck | Meaning of `healthy` |
|---|---|---|---|---|---|
| `db` | `postgres:16-alpine` | — | `pg-data:/var/lib/postgresql/data` | `pg_isready -U mapirror -d mapirror` | `initdb` finished and the server answers |
| `api` | `docker/api.Dockerfile` | — | `data:/data` (`CACHE_DIR`, `TMP_DIR`) | `bun -e` → `GET /readyz` | the database **and** the cache directory answer |
| `web` | `docker/web.Dockerfile` | `8080:8080` | — | `wget` → `/index.html` | nginx serves the shell — not the API |

Only `web` publishes a port. `db` is reachable solely by the API (a published `5432` is a password-guessing surface with no
benefit), and `api` only through nginx — otherwise a client could skip the proxy and choose its own
`X-Forwarded-For`. All three restart `unless-stopped`, log through `json-file` capped at 3 × 10 MB, and run with
`no-new-privileges`.

`api` waits for `db` to be **healthy**, so a first boot does not spend the entrypoint's 60 s wait. `web` waits only for the
API container to exist: nginx resolves `api` when it starts, and holding the UI back until the API is healthy would leave
the operator staring at an empty port during a long first migration instead of nginx's `502`, which names the upstream it
could not reach.

`healthy` in `docker compose ps` therefore means **ready**, not alive: `/readyz` is what the API's probe asks. `/healthz`
stays liveness only, for the kernel and for `restart` decisions — a container whose database is gone is unhealthy but is not
restarted on that basis.

```bash
docker compose ps                       # up, healthy, and on which port
docker compose logs -f api              # the four entrypoint steps, then the request log
docker compose exec api bun scripts/reset-admin-password.ts --generate
docker compose down                     # keeps both volumes
docker compose down -v                  # removes them: a fresh install
```

**The database password never enters a URL.** `compose.yaml` derives `DATABASE_URL` as
`postgres://mapirror@db:5432/mapirror` — user, service, database, no password — and passes `POSTGRES_PASSWORD` alongside;
the API completes the DSN itself (`db/client.ts`), percent-encoding what it inserts. That is what makes a password with
`@`, `:`, `/`, `?`, `#` or `%` work, and it is not a nicety: written straight into a DSN, `p@ss` makes the driver
authenticate with `p`, `pa#ss` makes the string an invalid URL, and `pa%ss` makes the driver's decoder throw. There is one
copy of the password, in `.env`, and changing it is the only edit needed:

```bash
# change the password of an existing install
NEW=$(openssl rand -hex 24)          # hex: URL-safe by construction, and 48 characters of it
docker compose exec db psql -U mapirror -d postgres \
  -c "ALTER ROLE mapirror PASSWORD '$NEW'"      # the verifier lives inside the volume, not in .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$NEW|" .env
docker compose up -d                 # recreates the API container with the new value
```

The order matters, and `docker compose up -d` cannot come first: `POSTGRES_PASSWORD` only reaches `initdb`, which an
existing volume skips — so changing `.env` alone changes nothing in the database, and restarting the API first would make
step 1 fail against a password nobody has set yet. `psql` over the container's local socket does not need the password at
all, which is why the `ALTER ROLE` can be the first command. Connections the API already holds are not re-authenticated,
so the seconds between the two edits do not interrupt a running mirror.

`POSTGRES_PASSWORD_FILE` works too (`docker compose` secrets, systemd `LoadCredential`): the API reads the file and strips
only the trailing newline.

**Where the cache lives.** `data` is a named Docker volume by default, because a fresh clone has no `./data` owned by uid
`10001` and a bind mount would turn the first boot into a permission error. For a cache of hundreds of gigabytes, point it
at a real disk — one line in `compose.yaml`, and one `chown` on the host:

```yaml
    volumes:
      - /srv/mapirror/data:/data      # was: data:/data
```

```bash
sudo mkdir -p /srv/mapirror/data && sudo chown -R 10001:10001 /srv/mapirror/data
docker compose up -d                            # now a bind mount
```

The same applies to the database: `pg-data:/var/lib/postgresql/data` may become a host path, but a *non-empty* directory
makes `initdb` refuse, so start with an empty one.

### What gets built

| Image | Dockerfile | Contents | Status |
|---|---|---|---|
| `api` | `docker/api.Dockerfile` | Fastify + worker + scheduler, one Bun process, sources shipped as written | exists (`P1-DOCK-01`) |
| `web` | `docker/web.Dockerfile` | the Vite bundle, served by nginx — the proxy to the API prefixes lands in `P1-DOCK-03` | exists (`P1-DOCK-02`) |

Both are multi-stage and both run as a **non-root** user — uid `10001` for the API, `101` for nginx. The API image is worth
knowing three things about, because they are the difference between an image that starts and one that does not:

- **`oven/bun:1.4.4`**, the same version the repository pins in `packageManager`. `scripts/tests/dockerfile.spec.ts` fails
  if the two drift.
- **Dependencies are installed with `--frozen-lockfile --production`**, so a build resolves nothing the lockfile does not
  already name and no test runner reaches production.
- **The process runs as uid `10001`, and `/data` belongs to it.** A bind-mounted cache directory therefore needs
  `chown 10001:10001` on the host once:

```bash
sudo chown -R 10001:10001 /srv/mapirror/data
```

The web image needs none of that: nginx reads the bundle and writes only to `/tmp` inside its own container. It listens on
`8080` (an unprivileged process cannot bind `80`), which is why compose publishes the host's `8080` onto it — the address
the rest of this guide uses.

**Do not edit `DATABASE_URL`.** Inside the containers it is derived — `postgres://mapirror:<POSTGRES_PASSWORD>@db:5432/mapirror` — so changing `POSTGRES_PASSWORD` is enough and the two can never disagree. The copy in `.env` is for running the API outside Docker (native dev, tests). The same rule applies to `CACHE_DIR` / `TMP_DIR`, which compose points at the mounted volumes (`/data/cache`, `/data/tmp`).

### What the first boot actually does

The API container's `ENTRYPOINT` is `docker/entrypoint.api.sh`: four steps, in this order, and the order is the point.

| # | Command | Why it is here |
|---|---|---|
| 1 | `bun scripts/wait-for-db.ts` | a migration against a database that is still starting fails, and a container that gives up is a restart loop |
| 2 | `bun scripts/migrate.ts` | the `admins` table does not exist until `0001_init.sql` has run, and step 3 needs it |
| 3 | `bun scripts/init-admin.ts --bootstrap` | creates the account on a fresh volume; on every boot after, reports it and changes nothing |
| 4 | `exec bun apps/api/src/server.ts` | `exec` makes the API **PID 1**, so `docker stop`'s `SIGTERM` reaches it and the process drains instead of being killed after the grace period |

Each step prints one line to stderr — `entrypoint: step 2/4: applying migrations` — and a failing step prints
`entrypoint: step 2/4: … failed (exit 3); the API is not started` and exits with **that** code. So `docker compose logs
api` names the step that failed, and the API never starts against a database it could not prepare. Nothing manual is
required (DOCK-2); the worker and scheduler start inside the API process (the queue arrives with `P2-JOB-01`), and the
migration stays in the entrypoint, in the open, rather than in the API's boot path — compose will also pass
`MIGRATE_ON_BOOT=false` (`P1-DOCK-05`) so the second pass does not happen at all.

**A slow database.** The wait is 60 s by default; `docker run … bun scripts/wait-for-db.ts --timeout 300` (up to 3600)
covers a cold NAS volume or a database on another host. It is a `select 1` through the API's own pool, not a port probe:
a PostgreSQL that is still recovering accepts TCP and then answers `57P03`, which `pg_isready`-shaped waits cannot see,
and the runtime image deliberately carries no OS packages to run one with. With the database down entirely, step 1
spends the minute, prints the deadline it waited for, and exits `1` — `restart: unless-stopped` is where retries belong,
not inside the script.

**A database that says no.** Four refusals are not waited for, because waiting cannot change them: `28P01`/`28000`
(the credentials were rejected), `42501` (the role may not connect) and `3D000` (there is no such database). The first
attempt prints `the database refused the connection and will keep refusing it — … (28P01); check DATABASE_URL and
POSTGRES_PASSWORD` and exits `1`. This is the shape a wrong `POSTGRES_PASSWORD` takes, and it must not look like a slow
start: on a volume that already exists, editing `.env` without `ALTER ROLE` produces exactly this, in half a second,
instead of a silent minute.

**A second boot asks for nothing.** Step 3 runs every time. `--bootstrap` looks the account up *before* it looks for a
password, so a restart succeeds after you delete `ADMIN_PASSWORD` from `.env` — which is what one does once the account
exists; without the flag the step demanded a password it did not need and exited `1`, so a working install could not
restart. It prints `admin 'admin' already exists — unchanged`, touches nothing, and leaves a deactivated account
deactivated (re-enabling is a decision, not a repair — use the admin UI or `reset-admin-password`). On a **fresh** volume
with no password source it still stops, with the message naming `ADMIN_PASSWORD` and `ADMIN_PASSWORD_FILE`, instead of
starting a server nobody can log into:

```bash
$ docker compose logs api | tail -2
entrypoint: step 3/4: bootstrapping the admin account
error: no admin password supplied. Set ADMIN_PASSWORD or ADMIN_PASSWORD_FILE, or run in a terminal.
entrypoint: step 3/4: bootstrapping the admin account failed (exit 1); the API is not started
```

**One-off commands still get steps 1–3.** `docker compose run --rm api bun scripts/reset-admin-password.ts` waits for the
database and migrates before it runs, because an explicit command replaces only step 4 (`exec "$@"`). That is why the
image has a single entrypoint and not two.

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
  proxy_request_buffering off;     # stream uploads straight through
  proxy_max_temp_file_size 0;      # stream downloads without spooling them to disk
  proxy_buffering on;              # …and without giving up gzip (see below)

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

`docker/nginx.conf` is that container's whole configuration, and this is its map — the same order, for the same reasons:

```nginx
# in docker/nginx.conf — APIs first, then pages
location ^~ /_auth/api/   { proxy_pass http://api:3000; }            # auth JSON  ─┐ must come before
location ^~ /_admin/api/  { proxy_pass http://api:3000; }            # admin JSON  │ the page rules,
location ^~ /_public/api/ { proxy_pass http://api:3000; }            # public JSON │ otherwise the SPA
location =  /healthz      { access_log off; proxy_pass …; }          # probes      ┘ fallback swallows them
location =  /readyz       { access_log off; proxy_pass …; }
location =  /             { return 302 /_site/$is_args$args; }
location =  /_site        { return 301 /_site/$is_args$args; }
location =  /_auth/login  { try_files $uri /index.html; }            # the one page outside /_site
location ^~ /_site/       { try_files $uri /index.html; }            # SPA deep links
location =  /index.html   { expires -1; add_header …; }              # the shell: never cached, six headers
location ^~ /assets/      { expires 1y; add_header …; }              # content-hashed: cached for a year
location /                { try_files $uri =404; }                   # anything else: a real 404
```

Five things in there are worth knowing before editing it:

- **A redirect keeps the query string only if you write it.** `return` sends the target exactly as written, so the first
  version of these two lines dropped it: `/?utm_source=newsletter` landed on `/_site/` with the campaign gone (measured,
  pass 41). `$is_args$args` is what re-attaches it — `?` plus the arguments when there are any, nothing when there are not.
- **A fallback must be a URI.** `try_files $uri /index.html` sends the request through location matching again, so the
  deep link lands on the `/index.html` rule and picks up its `Cache-Control` and CSP. `try_files /index.html =404` — the
  obvious way to write the login page — serves the file *inside* that location instead, with neither header.
- **`proxy_buffering off` is not the streaming switch.** With buffering off nginx cannot compress what it forwards, so every
  JSON answer leaves uncompressed. `proxy_max_temp_file_size 0` is what actually keeps a 773 MB download off the disk: the
  response is held in memory for 32 kB and then passed through with backpressure.
- **`expires -1` on the shell, `1y` on `/assets/`.** The bundle's file names contain their hash, so a year is honest; the
  shell's name never changes, so caching it is a deploy nobody sees.
- **The CSP's `upgrade-insecure-requests` is conditional** on `X-Forwarded-Proto: https` (the outer proxy's header). On a
  plain-HTTP first run the directive would upgrade the bundle's own requests to a port with no TLS, and the page would stay
  blank.

`proxy_request_buffering off` matters in the other direction: without it nginx spools a multi-gigabyte import to its own
disk before forwarding it, doubling disk usage and delaying progress.

**One setting outside this file.** The API decides who to believe about a client's address (`TRUST_PROXY`, `09-development.md`
§5), and it defaults to `loopback`. Behind this container the peer is not loopback but the compose network — so left at the
default, every visitor looks like the web container and the API's rate limiter has a single key for the whole internet. Set

```dotenv
TRUST_PROXY=loopback,uniquelocal
```

in `.env` when the stack runs in Docker. **Both halves are needed.** A named preset *replaces* the default rather than
adding to it: `uniquelocal` is `10/8`, `172.16/12`, `192.168/16` and `fc00::/7`, and it does **not** include loopback
(measured, pass 41: with `TRUST_PROXY=uniquelocal` a request from `127.0.0.1` carrying `X-Forwarded-For: 203.0.113.81` was
recorded as `127.0.0.1`). That matters here because the outer proxy in §3 reaches this container over `127.0.0.1:8080` and,
on a host running the API without Compose, that is also the API's peer — so the recommended value lists `loopback`
explicitly. `docker compose` is wired for this in `P1-DOCK-05`.

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

All three forms revoke the admin's existing tokens, so any open admin tab is signed out immediately, and print how
many sessions were ended. `--generate` prints the new password **once**, after the change has committed — it is not
stored anywhere, so copy it before the terminal scrolls. `--password-stdin` reads the password from a pipe (writing the
generated password to a secret store, for example); it refuses a terminal, where the shell would echo what is typed.

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
