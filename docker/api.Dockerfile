# syntax=docker/dockerfile:1

# The API image (task `P1-DOCK-01`): Fastify routes, the job worker and the interval scheduler in one process, running
# as a non-root user.
#
# ## Why two stages
#
# The build step is one command — `bun install` — and it is the only thing that needs a network, a package cache and a
# writable home. The runtime needs none of those. Splitting them means the runtime layer never contains the install
# machinery or the ~215 packages this repository uses only to develop itself (measured: 281 in a full install, 65 in a
# production one), and editing a source file cannot re-resolve the dependency tree — the `deps` stage's inputs are the
# three manifests and the lockfile.
#
# ## Why `--production` and three `node_modules`
#
# Bun installs a workspace's dependencies into **that workspace's** `node_modules`, with symlinks into a shared store at
# `node_modules/.bun`. So the runtime needs the store *and* `apps/api/node_modules` *and* `packages/shared/node_modules`;
# copying only the first produces an image that builds and then dies on `Cannot find module 'fastify'`. Measured with a
# staging copy of exactly these paths: the API boots and answers `/healthz` (see `docs/16-changelog.md`, pass 38).
#
# `apps/web` is deliberately absent: it is a static bundle built by `web.Dockerfile` (`P1-DOCK-02`), and its Vue/Vuetify
# dependencies would add ~120 MB to an image that never serves a page.
#
# ## Why the sources are copied, not compiled
#
# Bun executes TypeScript directly. The runtime image ships `src/` as written, and there is no build output to get stale
# or to drift from the sources it came from.
#
# ## Why the base tag is an exact version
#
# `oven/bun:1.4.4` — the same version as `packageManager` in the root `package.json`, which `scripts/tests/
# dockerfile.spec.ts` asserts. `latest` would make two builds of the same commit produce different images.

ARG BUN_IMAGE=oven/bun:1.4.4

# ── stage 1: dependencies ────────────────────────────────────────────────────────────────────────────────────────────

FROM ${BUN_IMAGE} AS deps

WORKDIR /app

# The three manifests and the lockfile are all `bun install --frozen-lockfile` reads. `apps/web/package.json` is left
# out on purpose; bun notes the skipped workspace and installs the rest (measured — it is a note, not an error).
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# `--frozen-lockfile`: a build must never resolve a version the lockfile does not name, or two builds of one commit
# differ. `--production`: dev dependencies (test runners, type definitions) have no business in a runtime image.
RUN bun install --frozen-lockfile --production --no-progress

# ── stage 2: runtime ─────────────────────────────────────────────────────────────────────────────────────────────────

FROM ${BUN_IMAGE} AS runtime

# Defaults that hold inside the container regardless of the operator's `.env`: the API binds every interface (compose
# publishes the port) and writes to the mounted volume, never to the layer it runs in.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CACHE_DIR=/data/cache \
    TMP_DIR=/data/tmp

WORKDIR /app

# One user, one id, stated rather than generated: a bind-mounted volume keeps its ownership across `docker compose up`
# and a `chown` of the host directory can be written down (`10001:10001`). `--no-create-home` because nothing writes to
# one; the shell is `nologin` because this account runs a process, not a session. `/data` is created *here*, before the
# `USER` line, because an unprivileged process cannot create a directory under a root-owned `/`.
RUN groupadd --gid 10001 mapirror \
 && useradd --uid 10001 --gid mapirror --no-create-home --shell /usr/sbin/nologin mapirror \
 && mkdir -p /data/cache /data/tmp \
 && chown -R 10001:10001 /data

# `--chown` on the copies rather than a later `chown -R`: the same ownership, without a second copy of 27 MB of modules in
# a second layer.
COPY --chown=10001:10001 --from=deps /app/node_modules ./node_modules
COPY --chown=10001:10001 --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=10001:10001 --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

# The manifests stay: bun resolves the workspace link `@mapirror/shared` through them, and `scripts/migrate.ts` imports
# the API's own modules, which import `@mapirror/shared` in turn.
COPY --chown=10001:10001 package.json bun.lock ./
COPY --chown=10001:10001 apps/api/package.json ./apps/api/
COPY --chown=10001:10001 apps/api/src ./apps/api/src
COPY --chown=10001:10001 packages/shared/package.json ./packages/shared/
COPY --chown=10001:10001 packages/shared/src ./packages/shared/src

# The operator scripts that must exist *inside* the container: `P1-DOCK-04`'s entrypoint runs the first two on every
# boot, and the third is what an operator runs through `docker compose exec api` to reset a forgotten password. Named
# one by one, with `secret-prompt.ts` — the only `lib/` module they import — because `scripts/lib/` also holds the
# build-context matcher, which is a gate tool the container has no use for.
COPY --chown=10001:10001 scripts/migrate.ts scripts/init-admin.ts scripts/reset-admin-password.ts ./scripts/
COPY --chown=10001:10001 scripts/lib/secret-prompt.ts ./scripts/lib/

USER 10001:10001

# Documentation only: the port is `PORT`, and compose maps the published one onto it.
EXPOSE 3000

# The worker loop stops on a signal; the default for a non-PID-1 process is already SIGTERM, and saying so keeps it true
# if the `CMD` ever gains a wrapper.
STOPSIGNAL SIGTERM

# `P1-DOCK-04` replaces this with an `ENTRYPOINT` that migrates and bootstraps the admin first. Until then the image is
# the API on its own, which is what `docker run` + `docker compose exec` are for.
CMD ["bun", "apps/api/src/server.ts"]
