#!/bin/bash
# On-box redeploy: pull the latest app tarball from S3, install deps into a
# fresh dir, atomically swap it in, refresh units/env, restart services.
# Triggered by the laptop-side deploy/deploy.sh via SSM. Data lives in
# /var/lib/mediagraf, so swapping the code dir never touches the DB or contracts.
set -euxo pipefail
source /etc/mediagraf/deploy.conf   # BUCKET, REGION
BIN=/usr/local/bin
APP=/opt/mediagraf/app

TMP=$(mktemp -d)
aws s3 cp "s3://$BUCKET/deploy/app.tar.gz" "$TMP/app.tar.gz" --region "$REGION"
rm -rf "$APP.new" && mkdir -p "$APP.new"
tar -xzf "$TMP/app.tar.gz" -C "$APP.new"
chown -R mediagraf:mediagraf "$APP.new"
(cd "$APP.new" && sudo -u mediagraf HOME=/var/lib/mediagraf "$BIN/npm" ci --omit=dev)

rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"

# Keep shims + units current with the new checkout, then restart.
ln -sf "$APP/deploy/box/render-env.sh"   "$BIN/mediagraf-render-env"
ln -sf "$APP/deploy/box/deploy.sh"       "$BIN/mediagraf-deploy"
ln -sf "$APP/deploy/box/backup.sh"       "$BIN/mediagraf-backup"
ln -sf "$APP/deploy/box/seed-restore.sh" "$BIN/mediagraf-seed-restore"
install -m 644 "$APP"/deploy/systemd/*.service /etc/systemd/system/
install -m 644 "$APP"/deploy/systemd/*.timer   /etc/systemd/system/
systemctl daemon-reload
/usr/local/bin/mediagraf-render-env
systemctl restart pilot-daemon.service pilot-dashboard.service
rm -rf "$TMP"
echo "deploy: live on $(date -u +%FT%TZ)"
