#!/usr/bin/env bash
# Host-side PostgreSQL dump and cache-file inventory. The artifacts themselves remain in the cache volume.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

read -r -a COMPOSE_CMD <<< "${COMPOSE:-docker compose}"
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT/backups}"
[[ "$BACKUP_ROOT" = /* ]] || BACKUP_ROOT="$ROOT/$BACKUP_ROOT"
TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DESTINATION="$BACKUP_ROOT/$TIMESTAMP"

if [[ -e "$DESTINATION" ]]; then
  printf 'error: backup already exists: %s\n' "$DESTINATION" >&2
  exit 1
fi
mkdir -p -- "$BACKUP_ROOT"
TEMP_DIR="$(mktemp -d "$BACKUP_ROOT/.incomplete-${TIMESTAMP}.XXXXXX")"
cleanup() {
  if [[ -n "${TEMP_DIR:-}" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT

printf 'backup: dumping PostgreSQL database\n' >&2
"${COMPOSE_CMD[@]}" exec -T db pg_dump --username=mapirror --dbname=mapirror --format=custom \
  > "$TEMP_DIR/database.dump"
[[ -s "$TEMP_DIR/database.dump" ]] || { printf 'error: PostgreSQL dump is empty\n' >&2; exit 1; }

printf 'backup: building the API image for cache inventory\n' >&2
"${COMPOSE_CMD[@]}" build api >&2

printf 'backup: hashing cached map artifacts (this reads the cache volume)\n' >&2
"${COMPOSE_CMD[@]}" run -T --rm --no-deps --entrypoint bun api scripts/cache-manifest.ts \
  > "$TEMP_DIR/cache-manifest.json"
[[ -s "$TEMP_DIR/cache-manifest.json" ]] || { printf 'error: cache manifest is empty\n' >&2; exit 1; }

printf 'backup: validating cache manifest\n' >&2
"${COMPOSE_CMD[@]}" run -i -T --rm --no-deps --entrypoint bun api scripts/cache-manifest.ts --validate-stdin \
  < "$TEMP_DIR/cache-manifest.json" > /dev/null

mv --no-clobber --no-target-directory "$TEMP_DIR" "$DESTINATION"
if [[ -e "$TEMP_DIR" ]]; then
  printf 'error: backup destination appeared during this run: %s\n' "$DESTINATION" >&2
  exit 1
fi
TEMP_DIR=''
printf 'backup complete: %s\n' "$DESTINATION"
