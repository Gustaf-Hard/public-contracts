# Publish the pilot to AWS — always-on, Gmail-login-gated, mobile-ready

**Date:** 2026-07-28
**Status:** plan for review (operator chose: tiny always-on box + AWS-provided HTTPS URL)

## Problem

The pilot runs on the operator's laptop. It keeps dying — most recently the
daemon's Gmail refresh token expired (`invalid_grant`) so sending stopped. Root
cause: the Google OAuth app is in **"Testing" publishing status**, whose refresh
tokens expire every **7 days**. We need it (a) always running and robust, (b)
protected so only the operator can reach it, (c) able to send indefinitely while
"logged in," and (d) usable on a phone. Cheap: single small box, a few $/mo.

## Decisions (from the operator)

- **Tiny always-on box** (EC2/Lightsail + systemd), SQLite kept on disk, nightly
  S3 backup. Lift-and-shift of the current code — least effort, most robust.
- **AWS-provided HTTPS URL** (no custom domain) → **CloudFront** gives a stable
  `https://<id>.cloudfront.net` for the OAuth redirect + phone bookmark.
- **Google Sign-In gates the dashboard** and the same OAuth grant carries the
  Gmail send scope: logged in ⇒ can send; logged out / grant revoked ⇒ no access
  and no send. **Publish the OAuth app to "Production"** so refresh tokens stop
  expiring (kills the weekly `invalid_grant`).

## Architecture

```
Phone / laptop ──HTTPS──> CloudFront (*.cloudfront.net, default cert)
                              │  (origin: HTTP, locked to CloudFront prefix list
                              │   + shared secret header X-Origin-Token)
                              ▼
                        EC2 t4g.micro (Amazon Linux 2023, arm64)
                          systemd: pilot-dashboard.service  (Express + auth gate)
                          systemd: pilot-daemon.service     (node-cron 15-min ticks)
                          SQLite  data/pilot.db  on EBS gp3
                          data/contracts/  on EBS
                              │  nightly cron
                              ▼
                        S3 (versioned, private)  pilot-db-backups/  +  contracts/
                        SSM Parameter Store (SecureString): Anthropic, Slack,
                          Google OAuth client id/secret, session secret
```

### 1. Compute — one small instance, supervised
- **EC2 t4g.micro** (1 GB, arm64; ~$6/mo on-demand, less with a Savings Plan).
  better-sqlite3 + Node are light; Opus/Haiku run API-side, so local RAM is
  modest. Bump to t4g.small if PDF batches pressure memory.
- **systemd** units for the daemon and the dashboard with `Restart=always` —
  this is the actual fix for "the daemon keeps dying": the OS restarts it, and
  `recoverStuckSends` already recovers any interrupted claim on the next tick.
- Keep the in-process `node-cron` scheduler (no EventBridge needed for a box).

### 2. HTTPS + edge — CloudFront
- CloudFront distribution, viewer HTTPS via the default `*.cloudfront.net`
  certificate. Origin = the EC2 public DNS over HTTP, locked down by (a) the
  managed **CloudFront origin-facing prefix list** in the security group and
  (b) a secret **`X-Origin-Token`** header CloudFront adds and the app checks —
  so the box can't be reached except through CloudFront.
- Forward all headers/cookies/methods needed for the app + OAuth (caching
  disabled for a dynamic private tool).

### 3. Auth gate — Google Sign-In, single combined grant (CRITICAL)
- The dashboard is today **unauthenticated (loopback-only)**. Exposing it
  publicly WITHOUT auth would leak PII and the send controls. **The auth gate
  MUST be implemented and verified before CloudFront is pointed at it** — this
  is the #1 safety gate of the migration.
- Add session middleware to `src/dashboard.js`: any unauthenticated request →
  redirect to Google OAuth. Request scopes **openid email + `gmail.send` +
  `gmail.readonly`** in ONE consent. On callback:
  1. Verify the returned email **equals the allowed operator** (`GMAIL_USER_EMAIL`)
     — anyone else is rejected. (Single-user allowlist.)
  2. Persist the **refresh token** as the server-side send credential (SSM
     SecureString or an encrypted file on EBS); the daemon reads the same
     credential. This is what makes "logged in ⇒ can send" literally true — one
     grant powers both identity and sending.
  3. Set a signed, `httpOnly`, `secure`, `SameSite=Lax` session cookie.
- **Logout / lost session** → cookie cleared → next request re-does Google
  Sign-In. If the grant is revoked, sends fail and re-auth is required — exactly
  the requested behaviour.
- **Publish the OAuth app to "Production"** in the operator's Google Cloud
  project so refresh tokens no longer expire after 7 days. (Sensitive Gmail
  scopes show a one-time "unverified app → Advanced → proceed" screen for the
  owner; acceptable for a single-user tool. Keep the app owned by the operator's
  own GCP project.)

### 4. Secrets & config — SSM Parameter Store
- SecureString params: `ANTHROPIC_API_KEY`, `SLACK_*`, `GMAIL_OAUTH_CLIENT_ID/
  SECRET`, `SESSION_SECRET`, `X_ORIGIN_TOKEN`. The EC2 **instance role** reads
  them at boot into the systemd env. Nothing secret in git or the AMI.

### 5. Data durability — "no data can be lost"
- SQLite + `data/contracts/` on **EBS gp3** (persists across restarts/stop-start).
- **Nightly cron**: WAL-checkpointed `.backup` of `pilot.db` → **versioned S3**
  bucket (`pilot-db-backups/`), plus `contracts/` sync. Keep 30 days.
- Cutover copies the current laptop `pilot.db` up as the seed; the laptop copy
  is kept until the live box is verified. Documented restore: pull latest from
  S3 onto a fresh instance.

### 6. Mobile
- The current layout is desktop-first (e.g. `.kommun-page` grid `320px
  minmax(0,1fr)`, the `/arenden` master–detail). Add a responsive CSS pass:
  under ~760px, stack the sidebar/thread columns and the master–detail into a
  single column, enlarge tap targets (Skicka / Hoppa över / thread rows), keep
  the reply textarea usable. Verify on a phone viewport before cutover.

### 7. Infra as code + deploy
- **CloudFormation** (per operator default) provisions: EC2 + instance role +
  security group (CloudFront prefix list only), S3 backup bucket (versioned,
  private, block-public), CloudFront distribution, SSM params (values set out of
  band, not in the template). Region **eu-central-1** (operator default).
- **Deploy script** on the box: `git pull && npm ci --omit=dev && systemctl
  restart pilot-daemon pilot-dashboard`. Logs → journald (optionally CloudWatch
  agent). First deploy: user-data clones the repo, installs Node 20 (arm64),
  writes the systemd units, runs the OAuth bootstrap once.

## Cost (rough, eu-central-1)
- EC2 t4g.micro on-demand ~$6/mo (halve with a 1-yr Savings Plan) · EBS gp3
  10 GB ~$1/mo · CloudFront (personal traffic, within free tier) ~$0 · S3
  backups ~pennies · SSM standard params free. **≈ $6-10/mo flat.** Not
  zero-when-idle (a box + cron is never idle), but near-nothing.

## Migration steps (ordered)
1. Google Cloud: publish OAuth app to Production; add the CloudFront callback
   URL as an authorized redirect URI.
2. Build the auth gate in `src/dashboard.js` (Google Sign-In + operator
   allowlist + session) and the combined-scope OAuth; **test locally end-to-end**
   (login required, only the operator's email admitted, send still works).
3. CloudFormation stack up (EC2, role, SG, S3, SSM, CloudFront).
4. Provision the box (Node 20 arm64, clone, systemd units, secrets from SSM).
5. Seed data: copy laptop `pilot.db` + `contracts/` up; enable nightly S3 backup.
6. Point CloudFront at the box **only after** the auth gate is verified live.
7. Responsive/mobile pass; verify on a phone.
8. Run for a few days alongside the laptop (laptop daemon OFF to avoid
   double-send); decommission the laptop daemon once healthy.

## Constraints (non-negotiable)
- **Auth gate before exposure** — never route public traffic to the dashboard
  until Google Sign-In + operator allowlist is verified. It currently assumes
  loopback-only trust.
- **No data loss** — laptop copy retained until verified; versioned S3 backups;
  cutover is copy-up, not move.
- **No double-send** — the laptop daemon is stopped before the AWS daemon goes
  live (both must never tick the same DB/threads). All send-safety invariants
  (two-phase claim, one open escalation/conv, `sendApprovedReply` sole path)
  unchanged.
- **Secrets** only in SSM, never in git/AMI/CloudFront config.
- **Single-user** — exactly one allowed operator email; no general sign-up.

## Out of scope
- Full serverless / DynamoDB rewrite (rejected: SQLite kept on the box).
- Multi-user, autoscaling, custom domain (can add a domain + ACM later).
- Replacing Slack.

## Open items to confirm at build time
- **Which personal AWS account/profile + credentials** to deploy with (the
  global config lists Binogi-prod and a Buzz sandbox; this is a *personal*
  account — need its profile).
- Instance size (start t4g.micro, bump if needed).
- Keep Slack in the loop once the mobile dashboard is the primary surface, or
  dashboard-only?
