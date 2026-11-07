# 12 — Deployment (Ubuntu 24.04 + Docker)

Three containers (Nginx, API, PostgreSQL), two volumes, one `.env`. TLS is terminated by an external
reverse proxy (D-15).

## 1. Server prerequisites

```bash
# Ubuntu 24.04 LTS
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl git gpg openssl ufw unzip

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

Membership in the `docker` group grants root-equivalent control of this host; add only trusted administrators.

Compose binds the published web port to `127.0.0.1:8080` by default: host-local checks and a TLS proxy on this same
machine can reach it, but remote clients cannot. Keep that binding for production. Docker-published ports may bypass UFW's
normal input rules, so do not treat `ufw deny 8080` as an exposure control.

Configure UFW before enabling it and allow SSH first. For a same-host TLS proxy, allow only its public listener ports:

```bash
sudo ufw allow OpenSSH
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

A host-local test needs no inbound 8080 rule. If a proxy on another machine must reach the application, change the Compose
port binding to the server's **private interface address** (for example, `10.0.0.5:8080:8080`) and restrict that port in
the cloud/provider network firewall to the proxy's address. Do not publish `8080` on all interfaces or rely on UFW alone
for a Docker-published port.

## 2. Install MapMirror

The current deployment candidate is the Phase 6 working branch; use a release tag here after P6-REL-01 publishes one.

```bash
sudo mkdir -p /opt/mapirror && sudo chown "$USER:$USER" /opt/mapirror
git clone --branch arena/5a1becdd-mapirror --single-branch \
  https://github.com/komeilm76/mapirror.git /opt/mapirror
cd /opt/mapirror

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

### Optional host-side Bun checks

Bun is **not required on the Docker host** to build or run this deployment: the API image contains its own pinned Bun
runtime. Install Bun on the host only if you also want to install workspace dependencies and run repository checks there.
The prerequisites above install `curl` and `unzip`, which the Bun installer needs:

```bash
curl -fsSL https://bun.com/install | bash
source ~/.bashrc
bun --version                         # expected: 1.4.4 (package.json's packageManager pin)
test "$(bun --version)" = "1.4.4"   # stop if the installed version differs
cd /opt/mapirror
bun install --frozen-lockfile
bun run check
```

`bun run check` may skip PostgreSQL-backed integration cases if `DATABASE_URL_TEST` is not reachable or its role cannot
create scratch databases. Treat those skips as unverified, not as passes; run the database-backed suites against a
separate disposable PostgreSQL instance with `CREATEDB` when collecting release evidence. Do not point tests at the
production database.

### What `compose.yaml` starts

| Service | From | Published | Volume | Healthcheck | Meaning of `healthy` |
|---|---|---|---|---|---|
| `db` | `postgres:16-alpine` | — | `pg-data:/var/lib/postgresql/data` | `pg_isready -U mapirror -d mapirror` | `initdb` finished and the server answers |
| `api` | `docker/api.Dockerfile` | — | `data:/data` (`CACHE_DIR`, `TMP_DIR`) | `bun -e` → `GET /readyz` | the database **and** the cache directory answer |
| `web` | `docker/web.Dockerfile` | `127.0.0.1:8080:8080` | — | `wget` → `/index.html` | nginx serves the shell — not the API |

Only `web` publishes a port. `db` is reachable solely by the API (a published `5432` is a password-guessing surface with no
benefit), and `api` only through nginx — otherwise a client could skip the proxy and choose its own
`X-Forwarded-For`. All three restart `unless-stopped`, log through `json-file` capped at 3 × 10 MB, and run with
`no-new-privileges`.

`api` waits for `db` to be **healthy**, so a first boot does not spend the entrypoint's 60 s wait. `web` waits only for the
API container to exist: holding the UI back until the API is healthy would leave the operator staring at an empty port
during a long first migration instead of nginx's `502`, which names the upstream it could not reach. It is an ordering
convenience rather than a requirement — nginx does not resolve `api` at startup, so a `web` that started before the API
existed would begin proxying to it the moment Docker's DNS answered (§3).

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

**Docker secrets are a different install, not a flag.** `POSTGRES_PASSWORD_FILE` is read by the API (trailing newline
stripped), and it is what a systemd `LoadCredential` unit or a secrets-based compose file uses — but it cannot be added to
`.env` beside the value compose already sends. Compose interpolates `POSTGRES_PASSWORD` into both `db` and `api`, and
`.env` reaches the API *whole*, so a `POSTGRES_PASSWORD_FILE` line there arrives at the same time and the API refuses the
pair: `POSTGRES_PASSWORD: cannot be combined with POSTGRES_PASSWORD_FILE; set exactly one of the two`. Setting only the
`_FILE` does not get that far — compose stops at `required variable POSTGRES_PASSWORD is missing a value`, because the
database would otherwise be created with a password nobody has. A secrets deployment therefore replaces the mechanism:
drop `POSTGRES_PASSWORD` from `.env`, point `POSTGRES_PASSWORD_FILE` at the mounted file in **both** services, and add a
`secrets:` block.

The password rule survives that swap, because it is about the DSN rather than about where the password came from:
`databaseUrlFor` completes the password-less `postgres://mapirror@db:5432/mapirror` from whichever of the two variables
`parseEnv` accepted. What does *not* change is `POSTGRES_PASSWORD`'s second job — it is the value `initdb` gets on a
**fresh** volume, so the file's owner and the database's password have to agree from the first boot.

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
`8080` (an unprivileged process cannot bind `80`); Compose publishes that container port as `127.0.0.1:8080` on the host,
so the same-host TLS proxy and local health checks can reach it without exposing the plain-HTTP origin.

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

For the production setup, open `https://maps.example.com/_auth/login` (replace with your hostname) and log in with
`ADMIN_USERNAME` / `ADMIN_PASSWORD`. For host-local testing before configuring TLS, use
`http://localhost:8080/_auth/login` from the Docker host.

> Change the password through the reset script immediately if the bootstrap password was shared
> in any channel.

**Database extensions.**

`0001_init.sql` creates `pg_trgm` (search) and optionally `unaccent`. Both are *trusted* extensions in
PostgreSQL 13+, so the database **owner** can create them without superuser rights — the default
`postgres` user in the container is fine. If you point MapMirror at an externally managed database, run this once as a database admin. On the Ubuntu host, install
`postgresql-client` first if `psql` is not already available (`sudo apt install -y postgresql-client`):

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

Set `PUBLIC_BASE_URL=https://maps.example.com` so generated links are correct. The Compose port stays bound to
`127.0.0.1` for a same-host proxy; Docker-published ports may bypass UFW, so a firewall rule alone is not a safe substitute.
For a proxy on another host, bind only to a private host interface and restrict it with the provider/network firewall.

### How the internal Nginx container routes (order matters)

`docker/nginx.conf` is that container's whole configuration, and this is its map — the same order, for the same reasons:

```nginx
# in docker/nginx.conf — APIs first, then pages
# every target is the upstream, never `api:3000` itself — see the first bullet below
location ^~ /_auth/api/   { proxy_pass http://api_upstream; }        # auth JSON  ─┐ must come before
location ^~ /_admin/api/  { proxy_pass http://api_upstream; }        # admin JSON  │ the page rules,
location ^~ /_public/api/ { proxy_pass http://api_upstream; }        # public JSON │ otherwise the SPA
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

Six things in there are worth knowing before editing it:

- **The API is reached through an `upstream`, never by host name.** `proxy_pass http://api:3000` looks right and is
  wrong in a way that only shows up after a deploy: the name is resolved from `/etc/hosts` when the configuration
  loads and never again, and `docker compose up -d` recreates `api` on a **new address** — the password rotation above
  ends with exactly that command. Every API call then answers `502` until someone restarts web, and the log names the
  address that no longer exists (measured on nginx 1.29.0, pass 44: `connect() failed … upstream:
  "http://127.0.0.1:3000/"` while `getent hosts api` already returned the new one). The pair that fixes it is in the
  file: `resolver 127.0.0.11` — Docker's embedded DNS on any user-defined network — and
  `upstream api_upstream { zone …; server api:3000 resolve; }`, with `valid=10s` capping how long a stale address can
  outlive its container. Re-probed: a recreated API on a new address is followed within ten seconds, with no restart,
  and a `web` container that started while DNS was unreachable recovers on its own.
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
| Secrets | `chmod 600 .env`; `ADMIN_PASSWORD_FILE` / `POSTGRES_PASSWORD_FILE` for a non-compose deployment, or for compose with a `secrets:` block (§2) |
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

The repository `Makefile` provides short wrappers around the common operator commands. Run them from the checkout root:

| Target | Effect |
|---|---|
| `make up` | `docker compose up -d --build` — build and start the stack |
| `make down` | `docker compose down` — stop it and **keep** both named volumes |
| `make logs` | Follow logs from all services; use `make logs SERVICE=api` (or `web` / `db`) to select one |
| `make migrate` | Run `bun scripts/migrate.ts` in the running `api` container |
| `make test` | Run the repository Vitest suite on the host (`bun run test`); set `DATABASE_URL_TEST` for DB-backed tests |
| `make reset-admin` | Run the password-reset script in the API container, inheriting the terminal for its hidden prompt |

`make down` deliberately does not remove data; use `docker compose down -v` only when you intend to delete the database and cache volumes. The compose executable can be overridden, for example `make up COMPOSE='docker compose -f compose.prod.yaml'`.

### Logs

```bash
docker compose logs -f api          # application + jobs
docker compose logs -f web          # nginx access/error
docker compose logs --tail=200 db
```

### Upgrade (forward-only migrations)

Before changing the running release, create a database dump and cache inventory, and copy the backup directory
off the server. Keep the backup until the new release is healthy and verified:

```bash
./scripts/backup.sh
# Copy the reported backups/<UTC timestamp>/ directory to separate storage.

git pull --ff-only
docker compose up -d --build
docker compose logs --tail=200 api
docker compose ps
```

Compose waits for PostgreSQL health before starting the API. The API entrypoint applies each pending SQL
migration in its own transaction **before** it starts serving; a failed migration is not recorded as applied,
and the API does not start. Logs should show either `migrations: already up to date` or the exact migration
names followed by `migrations: N applied`, then API startup. Confirm `api` is healthy in `docker compose ps`
and verify readiness:

```bash
docker compose exec -T api bun -e \
  'fetch("http://127.0.0.1:3000/readyz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
```

The integration suite includes an upgrade drill: it migrates a fresh scratch database to the preceding
migration set, inserts representative admin, catalog/cache, version, and settings rows, applies the next
migration, then asserts those rows and the full migration history remain intact. Run it with `bun run test:api`
against the reachable PostgreSQL instance in `DATABASE_URL_TEST`; the test role must have `CREATEDB`. It is
skipped when that database is unreachable or the role cannot create scratch databases.

Migrations are forward-only. An older API image against a database with a newer migration is refused at boot
with `SCHEMA_SKEW`; the API does not attempt a downgrade. A code-only rollback is safe only when the restored
image recognizes every applied migration and compatibility has been checked. If the new release applied a
migration, use the **pre-upgrade** database dump to roll back both schema and code. The cache volume is retained;
missing files are reconciled by the older API's housekeeping after it starts:

```bash
# Preserve the backup directory outside the checkout before switching tags.
docker compose stop api
git checkout <previous-tag>
docker compose up -d db
docker compose exec -T db dropdb --if-exists --force --username=mapirror mapirror
docker compose exec -T db createdb --username=mapirror --owner=mapirror mapirror
docker compose exec -T db pg_restore --username=mapirror --exit-on-error --no-owner --role=mapirror --dbname=mapirror \
  < /secure/backups/<pre-upgrade-timestamp>/database.dump
docker compose up -d --build
```

This rollback database restore is deliberately separate from `scripts/restore.sh`: that script restores a
backup for the current code and runs the current release's cache reconciliation path, without applying an older
schema migration. For destructive recovery, see §6 `Restore`; the pre-upgrade dump is the only path that returns the
schema to an older release.

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
# or: make backup
```

`scripts/backup.sh` writes `database.dump` and `cache-manifest.json` to
`./backups/<UTC timestamp>/` (gitignored). The database is captured with `pg_dump --format=custom`;
the API image is built separately so build output cannot enter the manifest, then a one-off Bun invocation overrides
the normal API entrypoint while scanning the shared cache volume. Its stdout contains only the manifest JSON, which is
validated against the strict version 1 schema (format, timestamp, artifact paths, decimal byte sizes, and MD5 digests)
before the backup directory is atomically published. The manifest records each regular cached map file's relative path,
byte size, and computed MD5. Hashing reads every cached artifact, so schedule it for a quiet period on large volumes.
The map files themselves are not copied: they can be re-downloaded from Geofabrik if lost. A failed run removes its
incomplete staging directory rather than leaving something that looks like a complete backup.

Recommended cron:

```cron
15 2 * * * cd /opt/mapirror && ./scripts/backup.sh >> /var/log/mapmirror-backup.log 2>&1
```

### Restore

```bash
./scripts/restore.sh backups/2026-10-24T021500Z
# or: make restore BACKUP=backups/2026-10-24T021500Z
```

The restore wrapper validates the backup files, builds the current API image, and parses the cache manifest against the
strict version 1 schema before starting PostgreSQL or taking the API offline. It then stops the API, recreates the
`mapirror` database, and restores the custom dump. It leaves the cache volume in place and invokes the missing-file
reconciliation directly (without rerunning the API bootstrap entrypoint) **before** restarting the API. Missing, empty, or unsafe files for `ready`
versions are marked `failed` with `VERSION_FILE_MISSING`; the admin UI then offers the re-download path.
The manifest is an inventory, not a file backup, and restore does not compare its hashes with the cache or
re-hash every file against database checksums. Re-download missing artifacts from the source.

On success the script starts the API and waits for `/readyz`; on failure it stops the API so the operator
can inspect the failing restore step before serving traffic. If Docker refuses that final stop, the script
warns explicitly and the operator must stop the API manually before serving traffic. The script is intentionally destructive
to the current database. Perform a restore drill against a disposable deployment first, and retain a separate
copy of backups outside the server. Phase 6 (`P6-OPS-01`) requires a drill including the missing-artifact path.

### Download throughput and memory check (P6-PERF-01)

Run this on the Docker host during a quiet window, against a disposable or explicitly approved deployment. It sends one
3,000,000,000-byte HTTP range from an **already cached, published, exact-version** artifact through the public web/nginx
endpoint and discards the body on the host. It does not contact Geofabrik or write a local 3 GB file, but the transfer
still consumes 3 GB of network egress and records a public download event. The selected version must be at least 3 GB;
Europe is normally large enough, but use the actual stored version size shown in the admin cache page. Do not use `latest`:
record its resolved immutable version first.

From the repository/deployment checkout root, with Compose `api` and `web` healthy and Docker CLI access:

```bash
mkdir -p docs/evidence/p6-perf-01
set -o pipefail
BASE_URL=http://127.0.0.1:8080 \
COUNTRY_SLUG=europe \
VERSION='<exact-published-version>' \
bun run scripts/perf-download.ts | tee "docs/evidence/p6-perf-01/$(date -u +%Y%m%dT%H%M%SZ).json"
```

Replace the slug/version with a published, cached artifact at least 3,000,000,000 bytes. `BASE_URL` must reach this
Compose deployment's nginx origin (the default localhost URL does); do not route through a CDN/cache that could serve the
range without exercising the sampled containers. An external TLS proxy is acceptable only if it forwards to these same
containers without caching the range response. The script samples the local Compose `api` and `web` containers. The
preflight checks the immutable version and full object size, then requests exactly bytes 0–2,999,999,999.
It verifies the HTTP 206, `Content-Range`, `Content-Length`, identity encoding, and all received bytes. Every second it
samples Docker's container memory for both API and nginx; it prints a JSON report with elapsed time, decimal MB/s,
sample count, baseline, peak growth, and final memory. Exit status is nonzero if either container's peak rises more than
64 MiB above baseline or the full transfer/headers are not verified. The 64 MiB allowance is a bounded allocator/runtime
noise tolerance, not permission for continuing growth; inspect the samples and repeat a noisy run before sign-off.

Keep the JSON report with the release evidence. Mark P6-PERF-01 complete only after a successful real Compose run with
at least three memory samples and no sustained upward trend. Do not run this against an unapproved public deployment:
the operation deliberately transfers 3 GB and may incur egress charges.

## 7. Monitoring the deployment

- `/healthz` — process alive (liveness only). It checks nothing else on purpose: a liveness probe that
  consults Postgres restarts a healthy API every time the database blinks.
- `/readyz` — DB reachable + cache dir writable (use for load-balancer gating). Two checks, concurrent, each
  bounded at 2 s, so a hung connection cannot stall the probe. `503` names the failing checks in the body and
  the reason in the API log.
- Both answer `GET`/`HEAD` with `cache-control: no-store` and need no credentials. Keep `/readyz` on the
  internal network where your load balancer can reach it; it performs a `select 1` and a small file write per
  call, and it is deliberately not rate limited (a probe must never be throttled). Compose deliberately uses
  `/readyz` as the API healthcheck so `docker compose ps` exposes whether the service is ready. Docker's
  `restart: unless-stopped` policy does **not** restart a container merely because its health is `unhealthy`;
  it restarts after the main process exits. `/healthz` remains the process-liveness probe, and external traffic
  gates should use `/readyz`.
- Admin dashboard `/_site/admin/` — CPU/RAM/disk charts, jobs, updates available, disk headroom.
- Optional: point an uptime monitor at `/_public/api/stats` and a disk alarm at `/_admin/api/system/status`.

### Disk-full and restart drills (disposable projects only)

Never run these against production volumes. Use a disposable checkout with a fresh `.env` containing throwaway
credentials; `-p` gives every drill its own PostgreSQL/cache volumes. Do not reuse or remove the volumes of a real
installation. Record `docker compose ps`, the API logs, `/healthz` and `/readyz` before and after each fault.

**Bounded disk-full drill.** This overlays only the disposable API's cache directory with a 32 MiB tmpfs; the normal
`data:/data` volume, including uploads, and the host filesystem are not filled:

```bash
cat >/tmp/mapirror-disk-drill.yaml <<'YAML'
services:
  api:
    tmpfs:
      - /data/cache:rw,size=32m,mode=1777
YAML

DC=(docker compose -p mapirror-p6-disk -f compose.yaml -f /tmp/mapirror-disk-drill.yaml)
"${DC[@]}" up -d --build db api
"${DC[@]}" ps api
```

Wait for the API to become healthy, then fill only that tmpfs until the write reports `ENOSPC`:

```bash
"${DC[@]}" exec -T api bun -e '
const file = await (await import("node:fs/promises")).open("/data/cache/.p6-ops-03-fill", "w");
const block = Buffer.alloc(1024 * 1024);
let bytes = 0;
try {
  while (true) {
    const result = await file.write(block);
    bytes += result.bytesWritten;
    if (result.bytesWritten !== block.length) throw Object.assign(new Error("short write"), { code: "ENOSPC" });
  }
} catch (error) {
  if (error.code !== "ENOSPC") throw error;
  console.log(`tmpfs reached ENOSPC after ${bytes} bytes`);
} finally {
  await file.close();
}
'
"${DC[@]}" exec -T api bun -e '
const live = await fetch("http://127.0.0.1:3000/healthz");
const ready = await fetch("http://127.0.0.1:3000/readyz");
console.log(`healthz=${live.status} readyz=${ready.status}`);
if (live.status !== 200 || ready.status !== 503) process.exit(1);
'
"${DC[@]}" ps api
"${DC[@]}" logs --tail=100 api
```

Expected: the process remains up and `/healthz` stays `200`; the cache write makes `/readyz` return `503`, and
Compose eventually reports `api` as `unhealthy`. The `unless-stopped` restart policy does **not** restart a process
just because its health status is unhealthy. A real `GET /_admin/api/system/status` response reports `storage.state` as `full` at
zero available bytes (or `low` when bytes remain but are at/below `DISK_RESERVE_BYTES`). A new download is rejected
with `503 DISK_FULL` before its job is queued when its padded estimate plus reserve do not fit. For the rarer case
where another writer consumes space after preflight, the existing ENOSPC/EDQUOT worker test asserts that the
partial download is removed, the version is marked failed with `failure_reason=DISK_FULL`, and the worker persists
only its safe retrying `JOB_HANDLER_FAILED` job code. Previously-ready versions are unchanged.

Free the space and prove readiness recovers without restarting the API:

```bash
"${DC[@]}" exec -T api bun -e 'await (await import("node:fs/promises")).unlink("/data/cache/.p6-ops-03-fill")'
"${DC[@]}" exec -T api bun -e 'const r = await fetch("http://127.0.0.1:3000/readyz"); console.log(`readyz=${r.status}`); if (!r.ok) process.exit(1)'
"${DC[@]}" down -v                         # only this named, disposable project
rm -f /tmp/mapirror-disk-drill.yaml
```

**Restart drills.** Use a separate fresh checkout and `.env` with throwaway credentials, the normal named volumes
(no tmpfs override), and an unused host port 8080 for the disposable web UI:

```bash
RESTART=(docker compose -p mapirror-p6-restart -f compose.yaml)
"${RESTART[@]}" up -d --build
"${RESTART[@]}" ps
```

With no active jobs, `"${RESTART[@]}" restart api` should return to healthy and leave database/cache data intact.
Then stop only the throwaway DB with `"${RESTART[@]}" stop db`: `/healthz` should remain `200`, `/readyz` should
become `503`; after `"${RESTART[@]}" start db`, the pool reconnects and readiness returns without an API restart.
Compose health status is an observation, not a restart trigger.

For crash recovery, trigger catalog sync in the disposable admin UI, then queue the newest dated Finland snapshot
(about 0.7 GiB in the storage-sizing table). Confirm the disposable cache volume has the padded estimate plus reserve,
wait for the job to remain `running` with progress, and confirm `.partial/<job-id>.part` exists. Kill the **API process**, not the container, so Docker's
restart policy is exercised rather than a manual container stop:

```bash
"${RESTART[@]}" exec -T api bun -e 'process.kill(1, "SIGKILL")' || true  # exec disconnects as PID 1 exits
"${RESTART[@]}" ps api
"${RESTART[@]}" logs --since=10m api
```

Expected: the container restarts and becomes healthy; after the stale-job reaper's 4 min 30 s age threshold plus at
most one 15 s scan interval and retry backoff, the abandoned attempt is requeued with `WORKER_LOST`. That code stays
on the queued retry. The download retries from its retained `.part` using validated Range/If-Range rules, then verifies
size/checksum before installing the ready version. If attempts are exhausted instead, it ends `failed` with
`WORKER_LOST`. Keep the project until those outcomes and preserved rows are recorded, then remove only that project's
volumes with `docker compose ... down -v`.

The deterministic cases are in `apps/api/tests/unit/system-disk.spec.ts`, `apps/api/tests/unit/jobs-download-handler.spec.ts`,
`apps/api/tests/integration/download-handler.spec.ts` (resume and real writer seam), `apps/api/tests/unit/jobs-reaper.spec.ts`,
`apps/api/tests/integration/jobs-reaper.spec.ts`, and `apps/api/tests/unit/jobs-worker.spec.ts`. PostgreSQL-backed cases
require the test database; the live Docker drills above remain operator-run and must be recorded before P6-OPS-03 is marked done.

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
