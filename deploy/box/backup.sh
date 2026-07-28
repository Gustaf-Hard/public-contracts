#!/bin/bash
# Nightly durability backup (mediagraf-backup.timer). Takes a WAL-checkpointed,
# consistent copy of pilot.db via better-sqlite3's online .backup(), uploads it
# to the versioned S3 bucket, and syncs the contracts dir. Keeps 30 days (S3
# lifecycle). "No data can be lost."
set -euo pipefail
source /etc/mediagraf/deploy.conf   # BUCKET, REGION
DB=/var/lib/mediagraf/pilot.db
CONTRACTS=/var/lib/mediagraf/contracts
TS=$(date -u +%Y%m%dT%H%M%SZ)
DAY=$(date -u +%Y/%m/%d)
DEST="/tmp/pilot-$TS.db"

if [ ! -f "$DB" ]; then
  echo "backup: no DB at $DB yet — nothing to do"
  exit 0
fi

# Consistent online snapshot (checkpoint WAL, then .backup to a new file).
/usr/local/bin/node -e '
  const Database = require("/opt/mediagraf/app/node_modules/better-sqlite3");
  const db = new Database(process.argv[1], { readonly: false });
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.backup(process.argv[2]).then(() => { db.close(); }).catch((e) => { console.error(e); process.exit(1); });
' "$DB" "$DEST"

aws s3 cp "$DEST" "s3://$BUCKET/backups/$DAY/pilot-$TS.db" --region "$REGION"
[ -d "$CONTRACTS" ] && aws s3 sync "$CONTRACTS" "s3://$BUCKET/contracts/" --region "$REGION"
rm -f "$DEST"
echo "backup: uploaded pilot-$TS.db"
