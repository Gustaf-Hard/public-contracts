# AWS deployment runbook

Publishes the pilot to an always-on t4g.micro, fronted by CloudFront, gated by
Google Sign-In for a single operator. Design: `docs/superpowers/specs/2026-07-28-aws-deployment-design.md`.
Everything deploys under the **`personal`** AWS profile (account `260107956141`),
region **`eu-central-1`**.

```
Phone/laptop ──HTTPS──▶ CloudFront (*.cloudfront.net)
                          │ origin: HTTP :3100, locked to CloudFront prefix list
                          │ + X-Origin-Token header
                          ▼
                    EC2 t4g.micro (Amazon Linux 2023, arm64)
                      systemd: pilot-dashboard (Express + Google Sign-In gate)
                      systemd: pilot-daemon    (15-min cron ticks)
                      SQLite + contracts on EBS (/var/lib/mediagraf)
                          │ nightly 03:00 UTC
                          ▼
                    S3 (versioned, private): backups/ + contracts/ + seed/ + deploy/
                    SSM Parameter Store (/mediagraf/*, SecureString): all secrets
```

## Safety gates (do not skip)

1. **Auth before exposure.** The dashboard is unauthenticated on loopback. It is
   only ever bound to `0.0.0.0` with `AUTH_ENABLED=1` (enforced in code:
   `startDashboard` throws otherwise). CloudFront + `ORIGIN_TOKEN` are the outer
   fence; Google Sign-In + the `GMAIL_USER_EMAIL` allowlist is the real gate.
2. **No double-send.** Stop the laptop daemon before the box daemon is allowed to
   tick. Only one daemon may touch the mail threads.
3. **No data loss.** `seed-data.sh` backs up the local DB first and refuses to
   clobber an existing box DB without `--force`; nightly versioned S3 backups.

## Prerequisites (one-time, manual — operator)

**A. Google Cloud (fixes the weekly `invalid_grant`).**
In the operator's GCP project that owns the OAuth client:
- OAuth consent screen → **Publishing status → Publish app (Production)**. This
  stops refresh tokens expiring after 7 days. The sensitive-scope "unverified
  app" screen is a one-time click-through for the owner — acceptable for a
  single user.
- The authorized redirect URI is added in step 3 below (needs the CloudFront
  domain, unknown until the stack exists).

**B. Latest AL2023 arm64 AMI** (the template default may age out):
```bash
AWS_PROFILE=personal AWS_REGION=eu-central-1 aws ec2 describe-images --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023.*-arm64" "Name=state,Values=available" \
            "Name=architecture,Values=arm64" \
  --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text
```

## Deploy

All commands: `export AWS_PROFILE=personal AWS_REGION=eu-central-1`.

**1. Create the stack.** Generate the shared origin secret first (also stored in
SSM as `ORIGIN_TOKEN` in step 2 — the two MUST match):
```bash
ORIGIN_TOKEN=$(openssl rand -hex 32)
aws cloudformation deploy \
  --stack-name mediagraf \
  --template-file deploy/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides OriginToken="$ORIGIN_TOKEN" \
  --region eu-central-1
```
The instance boots and **waits** for the app tarball (step 4). Grab the outputs:
```bash
aws cloudformation describe-stacks --stack-name mediagraf \
  --query 'Stacks[0].Outputs' --output table
```
Note `DashboardUrl` (e.g. `https://d123.cloudfront.net`) and `WebAuthRedirectUri`.

**2. Set the SSM parameters** (`/mediagraf/*`). Secrets as `SecureString`:
```bash
CF=https://<DashboardUrl-domain>        # from step 1 outputs
put()  { aws ssm put-parameter --name "/mediagraf/$1" --type String       --value "$2" --overwrite; }
puts() { aws ssm put-parameter --name "/mediagraf/$1" --type SecureString  --value "$2" --overwrite; }

puts ANTHROPIC_API_KEY        "sk-ant-..."
puts GMAIL_OAUTH_CLIENT_ID    "....apps.googleusercontent.com"
puts GMAIL_OAUTH_CLIENT_SECRET "GOCSPX-..."
puts SLACK_BOT_TOKEN          "xoxb-..."
puts SLACK_SIGNING_SECRET     "..."
puts SESSION_SECRET           "$(openssl rand -hex 32)"
puts ORIGIN_TOKEN             "$ORIGIN_TOKEN"      # SAME value as the stack param

put  GMAIL_USER_EMAIL         "gustaf@binogi.com" # the ONLY allowed operator
put  GMAIL_FROM_NAME          "Gustaf ..."
put  GMAIL_LABEL_PREFIX       "..."
put  ANTHROPIC_ANALYSIS_MODEL "claude-haiku-4-5-20251001"
put  SLACK_CHANNEL_ID         "C..."
put  SLACK_INTERACTIVITY_PORT "3200"
put  PILOT_TICK_CRON          "*/15 * * * *"
put  PILOT_FOLLOWUP_CRON      "0 8 * * *"
put  WEB_AUTH_REDIRECT_URI    "$CF/auth/callback"
put  GMAIL_OAUTH_REDIRECT_URI "$CF/auth/callback"
```
(Copy the real values from the laptop `.env`.)

**3. Google authorized redirect URI.** In the GCP OAuth client, add
`https://<DashboardUrl-domain>/auth/callback` (the `WebAuthRedirectUri` output)
to **Authorized redirect URIs**.

**4. Ship the code.**
```bash
./deploy/deploy.sh
```
Packages `HEAD`, uploads to `s3://<bucket>/deploy/app.tar.gz`, and runs the
on-box provisioning. First boot: user-data was already waiting on the tarball
and will pick it up within ~20 s; `install.sh` installs Node 20, deps, systemd
units, and starts the services. (On later deploys `deploy.sh` swaps the code and
restarts.)

**5. Verify the gate is live — on the phone.** Open `DashboardUrl`:
- Unauthenticated → redirected to Google Sign-In.
- Sign in as the operator email → dashboard loads.
- (Optional) a different Google account → 403.
Confirm the layout works on the phone (see the responsive pass).

**6. Seed the data** (one-time, laptop). With the laptop daemon **stopped**:
```bash
./deploy/seed-data.sh              # backs up local DB, uploads, installs on box
```
The box dashboard restarts on the seeded DB; the **daemon stays stopped** for
verification.

**7. Cut over.**
- Stop the laptop daemon (and dashboard) for good.
- Start the box daemon: `aws ssm send-command --instance-ids <id>
  --document-name AWS-RunShellScript
  --parameters 'commands=["sudo systemctl start pilot-daemon"]'`.
- Watch the first tick land in the dashboard heartbeat. Keep the laptop DB backup
  until the box has run healthy for a few days.

## Operating the box

- **SSH-free admin:** `aws ssm start-session --target <instance-id>` (Session
  Manager; no key pair, no port 22).
- **Logs:** `journalctl -u pilot-dashboard -f` / `-u pilot-daemon -f`.
- **Redeploy code:** commit, then `./deploy/deploy.sh`.
- **Rotate a secret:** `aws ssm put-parameter --overwrite ...` then
  `sudo /usr/local/bin/mediagraf-render-env && sudo systemctl restart
  pilot-daemon pilot-dashboard`.
- **Restore from backup:** copy a `s3://<bucket>/backups/YYYY/MM/DD/pilot-*.db`
  onto a fresh box's `/var/lib/mediagraf/pilot.db`.

## Open decision — Slack interactivity

Only the dashboard (port 3100) is exposed through CloudFront. The daemon's Slack
interactivity listener (`SLACK_INTERACTIVITY_PORT`) is **not** reachable, so
Slack **buttons** won't resolve escalations once on the box — the mobile
dashboard becomes the control surface. Slack **notifications** (outbound) still
work. If Slack buttons must keep working, add a second CloudFront behavior /
path routing to the interactivity port and update the Slack app request URL.
Decide at cutover.

## Cost

t4g.micro ~$6/mo · EBS gp3 30 GB ~$2.4/mo · EIP (attached) $0 · CloudFront
(personal traffic) ~$0 · S3 ~pennies · SSM standard free. **≈ $8-10/mo.**
