#!/usr/bin/env bash
# Encrypted logical backup of the whole database.
#   DATABASE_ADMIN_URL      owner connection (sees all tenants)
#   BACKUP_DIR              destination (ship this directory to in-Kingdom object storage; see docs/OPERATIONS.md)
#   BACKUP_PASSPHRASE_FILE  file holding the backup passphrase (NOT the data master key, and kept somewhere else)
#   BACKUP_KEEP_DAYS        optional: delete local backups older than this
# Output: cms-<UTC timestamp>.dump.enc and a .sha256 next to it.
set -euo pipefail
: "${DATABASE_ADMIN_URL:?}" "${BACKUP_DIR:?}" "${BACKUP_PASSPHRASE_FILE:?}"
umask 077
mkdir -p "$BACKUP_DIR"
ts=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/cms-$ts.dump.enc"
pg_dump --format=custom --no-owner --dbname="$DATABASE_ADMIN_URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$out"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
[ -s "$out" ] || { echo "backup is empty" >&2; exit 1; }
if [ -n "${BACKUP_KEEP_DAYS:-}" ]; then find "$BACKUP_DIR" -name 'cms-*.dump.enc*' -mtime +"$BACKUP_KEEP_DAYS" -delete; fi
echo "$out"
