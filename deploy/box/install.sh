#!/bin/bash
# First-boot provisioning, run by EC2 user-data after the app tarball is
# extracted to /opt/mediagraf/app. Idempotent: safe to re-run. Reads
# BUCKET/REGION/APP_PORT from /etc/mediagraf/deploy.conf (written by user-data).
set -euxo pipefail

NODE_VER=v20.18.1
APP=/opt/mediagraf/app
BIN=/usr/local/bin

# --- toolchain: Node 20 arm64 + build tools (better-sqlite3 fallback build) ---
dnf -y install gcc-c++ make python3 || true
if [ ! -x /opt/node/bin/node ] || ! /opt/node/bin/node -v | grep -q "^${NODE_VER%%.*}"; then
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-arm64.tar.xz" -o /tmp/node.tar.xz
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
fi
ln -sf /opt/node/bin/node "$BIN/node"
ln -sf /opt/node/bin/npm "$BIN/npm"
ln -sf /opt/node/bin/npx "$BIN/npx"

# --- box command shims (symlink to the version-controlled scripts) ---
ln -sf "$APP/deploy/box/render-env.sh"   "$BIN/mediagraf-render-env"
ln -sf "$APP/deploy/box/deploy.sh"       "$BIN/mediagraf-deploy"
ln -sf "$APP/deploy/box/backup.sh"       "$BIN/mediagraf-backup"
ln -sf "$APP/deploy/box/seed-restore.sh" "$BIN/mediagraf-seed-restore"
chmod +x "$APP"/deploy/box/*.sh

# --- systemd units ---
install -m 644 "$APP/deploy/systemd/mediagraf-render-env.service" /etc/systemd/system/
install -m 644 "$APP/deploy/systemd/pilot-daemon.service"         /etc/systemd/system/
install -m 644 "$APP/deploy/systemd/pilot-dashboard.service"      /etc/systemd/system/
install -m 644 "$APP/deploy/systemd/mediagraf-backup.service"     /etc/systemd/system/
install -m 644 "$APP/deploy/systemd/mediagraf-backup.timer"       /etc/systemd/system/
systemctl daemon-reload
systemctl enable mediagraf-render-env.service pilot-daemon.service pilot-dashboard.service mediagraf-backup.timer

# --- build app deps + render env + start ---
chown -R mediagraf:mediagraf /opt/mediagraf /var/lib/mediagraf
cd "$APP"
sudo -u mediagraf HOME=/var/lib/mediagraf "$BIN/npm" ci --omit=dev
/usr/local/bin/mediagraf-render-env
systemctl start mediagraf-backup.timer
systemctl restart mediagraf-render-env.service pilot-daemon.service pilot-dashboard.service
echo "install.sh complete"
