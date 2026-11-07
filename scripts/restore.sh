#!/usr/bin/env bash
# Restore a database dump, reconcile it against the existing cache volume, and verify API readiness.
set -Eeuo pipefail

usage() {
  printf 'Usage: %s BACKUP_DIRECTORY\n' "${0##*/}" >&2
}
if [[ $# -ne 1 || "$1" == '-h' || "$1" == '--help' ]]; then
  usage
  [[ $# -eq 1 ]] && exit 0
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="$1"
[[ "$BACKUP_DIR" = /* ]] || BACKUP_DIR="$ROOT/$BACKUP_DIR"
[[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || {
  printf 'error: backup directory is missing or is a symlink: %s\n' "$BACKUP_DIR" >&2
  exit 2
}
[[ -f "$BACKUP_DIR/database.dump" && ! -L "$BACKUP_DIR/database.dump" && -s "$BACKUP_DIR/database.dump" ]] || {
  printf 'error: database.dump is missing, empty, or not a regular file\n' >&2
  exit 2
}
[[ -f "$BACKUP_DIR/cache-manifest.json" && ! -L "$BACKUP_DIR/cache-manifest.json" && -s "$BACKUP_DIR/cache-manifest.json" ]] || {
  printf 'error: cache-manifest.json is missing, empty, or not a regular file\n' >&2
  exit 2
}

read -r -a COMPOSE_CMD <<< "${COMPOSE:-docker compose}"
compose() { "${COMPOSE_CMD[@]}" "$@"; }

printf 'restore: building the API image for manifest validation\n' >&2
compose build api >&2
printf 'restore: validating cache manifest before changing database state\n' >&2
compose run -i -T --rm --no-deps --entrypoint bun api scripts/cache-manifest.ts --validate-stdin \
  < "$BACKUP_DIR/cache-manifest.json" > /dev/null

printf 'restore: starting PostgreSQL service\n' >&2
compose up -d db
ready=0
for _ in {1..60}; do
  if compose exec -T db pg_isready --username=mapirror --dbname=mapirror >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  printf 'error: PostgreSQL did not become ready within 60 seconds\n' >&2
  exit 1
fi

# Keep the API down until the database is restored and the explicit reconciliation has completed.
compose stop api
printf 'restore: replacing the mapirror database\n' >&2
compose exec -T db dropdb --if-exists --force --username=mapirror mapirror
compose exec -T db createdb --username=mapirror --owner=mapirror mapirror
compose exec -T db pg_restore --exit-on-error --no-owner --username=mapirror --role=mapirror --dbname=mapirror \
  < "$BACKUP_DIR/database.dump"

printf 'restore: reconciling restored rows against the existing cache volume\n' >&2
compose run -T --rm --no-deps --entrypoint bun api scripts/reconcile-cache.ts

printf 'restore: starting API and waiting for readiness\n' >&2
compose up -d api
ready=0
for _ in {1..90}; do
  if compose exec -T api bun -e \
    'fetch("http://127.0.0.1:3000/readyz").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))' \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  if ! compose stop api; then
    printf 'warning: could not stop the API after its readiness check failed; stop it manually before serving traffic\n' >&2
  fi
  printf 'error: API did not become ready within 90 seconds; inspect: docker compose logs api\n' >&2
  exit 1
fi

printf 'restore complete: database restored, missing cache artifacts reconciled, API ready\n'
printf 'cache manifest retained for inventory only: %s/cache-manifest.json\n' "$BACKUP_DIR"
