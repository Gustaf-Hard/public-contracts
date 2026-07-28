#!/usr/bin/env bash
# Laptop-side deploy: package the committed tree, upload it to the stack's S3
# bucket, and trigger the on-box redeploy via SSM. Run after the stack exists.
#
#   AWS_PROFILE=personal ./deploy/deploy.sh
#
# Env overrides: STACK (default mediagraf), AWS_PROFILE (default personal),
# AWS_REGION (default eu-central-1).
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-personal}
export AWS_REGION=${AWS_REGION:-eu-central-1}
STACK=${STACK:-mediagraf}

out() { aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

BUCKET=$(out AppBucketName)
IID=$(out InstanceId)
[ -n "$BUCKET" ] && [ -n "$IID" ] || { echo "Stack $STACK not found or missing outputs"; exit 1; }

echo "Packaging HEAD -> app.tar.gz"
git archive --format=tar.gz -o /tmp/mediagraf-app.tar.gz HEAD
echo "Uploading to s3://$BUCKET/deploy/app.tar.gz"
aws s3 cp /tmp/mediagraf-app.tar.gz "s3://$BUCKET/deploy/app.tar.gz"

echo "Triggering on-box redeploy on $IID ..."
CMD=$(aws ssm send-command --instance-ids "$IID" \
  --document-name AWS-RunShellScript \
  --comment "mediagraf redeploy" \
  --parameters 'commands=["sudo /usr/local/bin/mediagraf-deploy"]' \
  --query 'Command.CommandId' --output text)

echo "SSM command $CMD dispatched. Waiting for completion ..."
aws ssm wait command-executed --command-id "$CMD" --instance-id "$IID" || true
STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$IID" --query Status --output text)
echo "=== status: $STATUS ==="
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$IID" \
  --query 'StandardOutputContent' --output text | tail -20
if [ "$STATUS" != "Success" ]; then
  echo "--- stderr ---"
  aws ssm get-command-invocation --command-id "$CMD" --instance-id "$IID" \
    --query 'StandardErrorContent' --output text | tail -30
  exit 1
fi
