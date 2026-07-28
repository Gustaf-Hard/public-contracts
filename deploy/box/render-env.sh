#!/bin/bash
# Render /etc/mediagraf/pilot.env from SSM Parameter Store. Each parameter under
# /mediagraf/ becomes an env var named by its last path segment (secrets are
# SecureString, decrypted here). Runs at boot (mediagraf-render-env.service) and
# on every deploy. Fixed, non-secret paths live in the systemd units, not here.
set -euo pipefail
source /etc/mediagraf/deploy.conf   # BUCKET, REGION

umask 077
mkdir -p /etc/mediagraf
TMP=$(mktemp)
aws ssm get-parameters-by-path \
  --path "/mediagraf/" --recursive --with-decryption \
  --region "$REGION" \
  --query 'Parameters[].[Name,Value]' --output text \
  | while IFS=$'\t' read -r name value; do
      printf '%s=%s\n' "${name##*/}" "$value"
    done > "$TMP"

# Fail closed: never install an empty env file over a good one.
if [ ! -s "$TMP" ]; then
  echo "render-env: no /mediagraf/ SSM parameters found — leaving existing env untouched" >&2
  rm -f "$TMP"
  exit 1
fi
mv "$TMP" /etc/mediagraf/pilot.env
chmod 600 /etc/mediagraf/pilot.env
chown mediagraf:mediagraf /etc/mediagraf/pilot.env
echo "render-env: wrote /etc/mediagraf/pilot.env ($(wc -l < /etc/mediagraf/pilot.env) vars)"
