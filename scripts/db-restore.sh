#!/bin/sh
# Load a dump made by scripts/db-dump.sh into the running compose `postgres`
# service (T18).
#
#   scripts/db-restore.sh <dump-file> --replace
#
# This REPLACES every Pythia table in the target database with the dump's
# contents; what was indexed there before is gone. `--replace` is required so
# it never runs by accident. The restore runs in one transaction: if anything
# fails, the database is left as it was.
#
# Stop the app first (`docker compose stop app`) so nothing writes during the
# restore, then start it again; it runs any newer migrations on start. Devices
# whose offline cursor is ahead of the restored database get `reset` from
# /api/sync and re-sync from the start on their own.
set -eu

cd "$(dirname "$0")/.."

if [ "$#" -ne 2 ] || [ "$2" != "--replace" ]; then
  echo "usage: scripts/db-restore.sh <dump-file> --replace" >&2
  echo "Replaces all Pythia data in the compose postgres database with the dump." >&2
  exit 2
fi
file=$1
if [ ! -f "$file" ]; then
  echo "no such file: $file" >&2
  exit 2
fi

if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  echo "the app service is running; stop it first: docker compose stop app" >&2
  exit 1
fi

tmp=/tmp/pythia-restore-$$.dump
docker compose cp "$file" "postgres:$tmp"
status=0
docker compose exec -T postgres pg_restore -U pythia -d pythia \
  --clean --if-exists --no-owner --single-transaction --exit-on-error "$tmp" || status=$?
docker compose exec -T postgres rm -f "$tmp"

if [ "$status" -ne 0 ]; then
  echo "restore failed (exit $status); the database was not changed" >&2
  exit "$status"
fi
echo "restored $file; start the app with: docker compose start app"
