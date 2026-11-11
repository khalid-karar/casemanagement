#!/usr/bin/env bash
# Restore a backup made by backup.sh into an EMPTY database, then print row counts to compare with production.
#   restore.sh <backup.dump.enc> <target database url>
# Never point this at production. It refuses a target that already has tables.
set -euo pipefail
file=${1:?backup file}; target=${2:?target database url}
: "${BACKUP_PASSPHRASE_FILE:?}"
(cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256")
if [ "$(psql "$target" -Atc "select count(*) from information_schema.tables where table_schema='public'")" != "0" ]; then
  echo "target database is not empty: refusing" >&2; exit 1
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$file" \
  | pg_restore --no-owner --dbname="$target"
psql "$target" -Atc "select 'cases', count(*) from cases union all select 'audit_events', count(*) from audit_events union all select 'case_documents', count(*) from case_documents union all select 'tenant_keys', count(*) from tenant_keys"
echo "Restore finished. Now: run the app against this database and 'pnpm anchors verify <tenant>' for each tenant."
