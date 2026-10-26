# syntax=docker/dockerfile:1

# The web image (task `P1-DOCK-02`): the SPA, built by Vite, served by nginx.
#
# ## Two stages, and only one of them is the web server
#
# The build needs Node-shaped things — a package cache, a bundler, 261 packages of which most are development tools. The
# runtime needs one binary, one config file and the 588 kB the build produced. So `build` produces `apps/web/dist` and
# `runtime` copies that directory and nothing else: no sources, no `node_modules`, no bun. The image is the size of nginx
# plus a bundle.
#
# ## Why the build installs **development** dependencies
#
# The mirror image of `api.Dockerfile`'s rule. Vite and `@vitejs/plugin-vue` are dev dependencies here, and a
# `--production` install would produce an image whose build step has no bundler. `--frozen-lockfile` stays: the
# difference between the two images is *which* packages, never *whether* the lockfile decides.
#
# ## Why nginx and not `bun serve`
#
# Range requests, `ETag`/`If-None-Match`, `gzip`, static-file caching headers and a proxy to the API are what this
# container has to do (`P1-DOCK-03`, `P3-API-05`), and doing them correctly by hand is a project of its own. nginx does
# them with configuration.
#
# ## Why the config replaces the base image's
#
# The container runs as uid 101, and the official image's defaults write to `/var/run`, `/var/cache/nginx` and
# `/var/log/nginx`, all root-owned: measured, a non-root nginx with those defaults dies on
# `mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)` before it serves a byte. `docker/nginx.conf`
# is the whole configuration — including the files that make an unprivileged nginx work (`pid` and the temp paths under
# `/tmp`, logs on the process's own streams) — and its own `ENTRYPOINT []` below means no base-image entrypoint script
# runs against a config it was not written for.

ARG BUN_IMAGE=oven/bun:1.4.4
ARG NGINX_IMAGE=nginx:1.29.0-alpine

# ── stage 1: build ───────────────────────────────────────────────────────────────────────────────────────────────────

FROM ${BUN_IMAGE} AS build

WORKDIR /app

# Manifests first, sources second: a source edit then invalidates only the build, never the install.
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

# `--frozen-lockfile` without `--production`: the bundler is a dev dependency and is the point of this stage.
RUN bun install --frozen-lockfile --no-progress

# Everything `vite build` reads: the app, the shared package it imports, and the two helper modules `vite.config.ts`
# imports (`alias.ts`, `dev-proxy.ts`) — which is why the config is copied with the sources rather than listed alone.
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared

# The workspace's own script, not a hand-written `vite build`: one command to keep in step with `bun run build:web`.
RUN bun run --filter @mapirror/web build

# ── stage 2: runtime ────────────────────────────────────────────────────────────────────────────────────────────────

FROM ${NGINX_IMAGE} AS runtime

# The whole server, in one file: `P1-DOCK-03` grows it with the SPA fallback and the proxy to the API.
COPY docker/nginx.conf /etc/nginx/nginx.conf

# Only the built bundle crosses into this stage. `dist/` holds `index.html`, one JS file, one CSS file and the font —
# measured at 588 kB, of which 145 kB is gzip.
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

# Unprivileged, numerically, like the API image: `nginx` is uid 101 in the official Alpine image, and `nginx.conf`
# listens on 8080 because a process without `CAP_NET_BIND_SERVICE` cannot bind 80.
USER 101:101

EXPOSE 8080

# docker stop sends SIGTERM, which nginx treats as an immediate shutdown that can cut a download short; SIGQUIT is its
# graceful one. The base image states the same thing, and stating it here keeps it true if the base ever changes.
STOPSIGNAL SIGQUIT

# The base image's entrypoint exists to edit `/etc/nginx/conf.d/default.conf` and to run templates through `envsubst`.
# Neither applies: this image ships one complete config, and the edit would fail as uid 101 on a root-owned file. Starting
# nginx directly is the honest description of what this container does.
ENTRYPOINT []
CMD ["nginx", "-g", "daemon off;"]
