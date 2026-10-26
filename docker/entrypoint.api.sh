#!/bin/sh
# docker/entrypoint.api.sh — the API container's first four seconds (`P1-DOCK-04`, requirement DOCK-2).
#
# One boot, four steps, in this order and no other:
#
#   1. wait for the database        bun scripts/wait-for-db.ts
#   2. apply migrations             bun scripts/migrate.ts
#   3. bootstrap the admin account  bun scripts/init-admin.ts --bootstrap
#   4. become the API               exec bun apps/api/src/server.ts
#
# ## Why the order is the task
#
# Step 2 has to precede step 3: `admins` does not exist until `0001_init.sql` has run, so on a clean volume
# `init-admin` would fail with `relation "admins" does not exist` — and the API's own boot-time migration cannot help,
# because it runs *after* this script has already tried. That is why compose will run the API with `MIGRATE_ON_BOOT=false`
# (`P1-DOCK-05`, `09-development.md` §4): the migration happens once, here, in the open, where its output is the first
# thing an operator reads. Left at its default the boot check is idempotent and simply finds nothing pending, so the
# ordering is what matters and the flag is an optimisation against a second, silent pass. Step 1 has to precede step 2 for the same reason one level down — a migration against a database
# that is still recovering fails, and a container that boots before its database is a container that restart-loops.
#
# ## Why `--bootstrap`
#
# Step 3 runs on **every** boot, and after the first one there is nothing to create. Without `--bootstrap` the script
# would ask for a password it does not need and exit `1` when the operator has (sensibly) removed `ADMIN_PASSWORD` from
# `.env` — so a restart of a working install would refuse to start. `--bootstrap` looks the account up first and reports
# `already exists — unchanged`; on a *fresh* database it still refuses to invent an account without a password, which is
# the behaviour DOCK-2 wants ("set `ADMIN_PASSWORD`") rather than a server with no way in.
#
# ## What this script deliberately does not do
#
# - **It never touches the password.** `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE` are read by `init-admin.ts` through the
#   same validated configuration the API uses; nothing here expands, prints, passes or checks them, and there is no
#   `set -x` to trace them into a log (`14-security.md` L9).
# - **It never waits with `sleep`.** The wait is `scripts/wait-for-db.ts`, which asks the database `select 1` through
#   the API's own pool. A shell loop could only test the port, and an open port that is still recovering answers
#   `57P03 the database system is starting up`.
# - **It does not install a signal handler.** Step 4 is `exec`, so the API *replaces* this shell as PID 1 and receives
#   `SIGTERM` from `docker stop` itself. A `wait`-ing wrapper would swallow the first signal, and then the container
#   would be `SIGKILL`ed after the grace period instead of draining.
# - **It does not retry a failed step.** A migration that fails on a permission error will fail again in a second;
#   the exit code and the line above it are the useful output, and `restart: unless-stopped` is where retries belong.
#
# The paths are relative to the image's `WORKDIR` (`/app`), and `cd` makes that explicit: a container started with
# `--workdir` somewhere else must not silently run `./scripts/migrate.ts` against nothing.
#
# @see docs/12-deployment.md §2 — the boot sequence an operator reads.
# @see docs/05-flows.md F1 — the same flow as a sequence diagram.

set -eu

cd /app

log() {
  printf 'entrypoint: %s\n' "$*" >&2
}

# Runs one step and reports a failure with the step's own name and exit code.
#
# `"$@" || { ... }` rather than `if ! "$@"; then` because `$?` inside the block is the failed command's status: in an
# `if` with no `else`, POSIX makes the construct's status `0` when no branch was taken, which would report every
# failure as `exit 0`.
run_step() {
  label="$1"
  shift
  log "$label"
  "$@" || {
    status=$?
    log "$label failed (exit $status); the API is not started"
    exit "$status"
  }
}

run_step "step 1/4: waiting for the database" bun scripts/wait-for-db.ts
run_step "step 2/4: applying migrations" bun scripts/migrate.ts
run_step "step 3/4: bootstrapping the admin account" bun scripts/init-admin.ts --bootstrap

# Step 4. An explicit command replaces the default one — `docker run <image> bun scripts/migrate.ts --reset` still gets
# steps 1–3 first, which is what makes the image usable for one-off maintenance without a second entrypoint.
if [ "$#" -gt 0 ]; then
  log "step 4/4: starting: $*"
  exec "$@"
fi

log "step 4/4: starting the API"
exec bun apps/api/src/server.ts
