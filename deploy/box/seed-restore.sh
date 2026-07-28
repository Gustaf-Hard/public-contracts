#!/bin/bash
# One-time data seed: install the laptop's pilot.db + contracts (uploaded to
# s3://BUCKET/seed/) onto the box. Refuses to clobber an existing box DB unless
# FORCE=1 — the box is authoritative once live, so this must never silently
# overwrite good data. Triggered by the laptop-side deploy/seed-data.sh.
set -euo pipefail
source /etc/mediagraf/deploy.conf   # BUCKET, REGION
DB=/var/lib/mediagraf/pilot.db

if [ -f "$DB" ] && [ "${FORCE:-}" != "1" ]; then
  echo "seed-restore: $DB already exists — refusing (re-run with FORCE=1 to override)" >&2
  exit 3
fi

systemctl stop pilot-daemon pilot-dashboard 2>/dev/null || true
aws s3 cp "s3://$BUCKET/seed/pilot.db" "$DB" --region "$REGION"
aws s3 sync "s3://$BUCKET/seed/contracts/" /var/lib/mediagraf/contracts/ --region "$REGION" || true
chown -R mediagraf:mediagraf /var/lib/mediagraf
systemctl start pilot-dashboard
echo "seed-restore: installed seed DB (dashboard started; daemon left stopped for verification)"
