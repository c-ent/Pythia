#!/bin/sh
# Dump the Pythia database from the running compose `postgres` service (T18).
#
#   scripts/db-dump.sh [out-file]      default: data/backups/pythia-<UTC time>.dump
#
# Run it on the workstation after the heavy first indexing, copy the file to
# the always-on host, and load it there with scripts/db-restore.sh. Vectors
# and content hashes travel with the dump, so the host serves search without
# re-embedding anything. The dump holds private note text: keep it off shared
# storage. data/ is gitignored.
#
# The dump is written inside the container and copied out with `docker compose
# cp`, so no binary data passes through a shell redirect (PowerShell would
# corrupt it).
set -eu

cd "$(dirname "$0")/.."

out=${1:-data/backups/pythia-$(date -u +%Y%m%dT%H%M%SZ).dump}
mkdir -p "$(dirname "$out")"
tmp=/tmp/pythia-dump-$$.dump

docker compose exec -T postgres pg_dump -U pythia -d pythia --format=custom --no-owner --file "$tmp"
docker compose cp "postgres:$tmp" "$out"
docker compose exec -T postgres rm -f "$tmp"

echo "dumped to $out"
