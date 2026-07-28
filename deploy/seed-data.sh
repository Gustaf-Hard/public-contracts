#!/usr/bin/env bash
# One-time data cutover: back up the laptop DB, upload pilot.db + contracts to
# the stack bucket's seed/ prefix, and install them on the box (guarded against
# clobbering an existing box DB). The Gmail token is NOT copied — logging in via
# the web gate recreates it. "No data can be lost": a local .bak is made first.
#
#   AWS_PROFILE=personal ./deploy/seed-data.sh            # normal
#   AWS_PROFILE=personal ./deploy/seed-data.sh --force     # overwrite box DB
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-personal}
export AWS_REGION=${AWS_REGION:-eu-central-1}
STACK=${STACK:-mediagraf}
FORCE_FLAG=${1:-}

out() { aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out AppBucketName)
IID=$(out InstanceId)
DB=${PILOT_DB_PATH:-data/pilot.db}
[ -f "$DB" ] || { echo "No local DB at $DB"; exit 1; }

TS=$(date -u +%Y%m%d-%H%M%S)
cp "$DB" "$DB.bak-$TS"
echo "Local backup -> $DB.bak-$TS"

echo "Uploading seed to s3://$BUCKET/seed/ ..."
aws s3 cp "$DB" "s3://$BUCKET/seed/pilot.db"
[ -d data/contracts ] && aws s3 sync data/contracts "s3://$BUCKET/seed/contracts/"

FORCE=0; [ "$FORCE_FLAG" = "--force" ] && FORCE=1
echo "Installing on box $IID (FORCE=$FORCE) ..."
CMD=$(aws ssm send-command --instance-ids "$IID" \
  --document-name AWS-RunShellScript \
  --comment "mediagraf seed-restore" \
  --parameters "commands=[\"sudo FORCE=$FORCE /usr/local/bin/mediagraf-seed-restore\"]" \
  --query 'Command.CommandId' --output text)
aws ssm wait command-executed --command-id "$CMD" --instance-id "$IID" || true
echo "=== $(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$IID" --query Status --output text) ==="
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$IID" --query 'StandardOutputContent' --output text
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$IID" --query 'StandardErrorContent' --output text
