# Pilot setup runbook

One-time setup steps before running Stage 0 rehearsal.

## 0. Domain email authentication (MANDATORY before any test sends)

The pilot bot sends from `gustaf@mediagraf.se` (Google Workspace). Without proper email authentication DNS records on mediagraf.se, **Gmail (and every other mail provider) will silently drop or aggressively spam-filter your outbound messages**. This was the single biggest debugging session on the first setup attempt — fix it before you send a single email.

Workspace auto-publishes the DKIM key for you at `google._domainkey.mediagraf.se`. Verify with:

```bash
dig +short TXT google._domainkey.mediagraf.se
```

You must additionally publish two TXT records on mediagraf.se via your DNS provider (one.com for this domain):

| Host | Type | Value |
|---|---|---|
| `@` (root) | TXT | `v=spf1 include:_spf.google.com ~all` |
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:gustaf@mediagraf.se` |

Set TTL to 3600. After publishing, **expect Google's resolver to cache the negative answer for up to 60 minutes** — Cloudflare (`@1.1.1.1`) will see the new records immediately, but Gmail uses Google's DNS internally and won't refresh until its cache expires. Wait until this command shows the SPF record before testing deliverability:

```bash
dig +short TXT mediagraf.se @8.8.8.8
```

## 0a. Google Workspace outbound send limits

Brand-new Workspace domains have very low outbound send caps — often as low as 50 messages/day in the first 1–2 weeks, gradually rising as the domain builds reputation. If you exhaust the limit you'll receive a `mailer-daemon@googlemail.com` bounce: *"You have reached a limit for sending mail. Your message was not sent."* Daily limit refresh is on a ~24-hour rolling window.

**For Stage 0 rehearsal**, plan for ~10 sends total across the day:
- 2 × T-INITIAL (one per role)
- ~6 reply approvals through the FSM scenarios
- a few buffer sends

**For Stage 1 (5 kommuner × 2 roles = 10 conversations)**, ~30–50 sends spread over the 4-week pilot is well under the limit.

**For v2 (290 kommuner)**, you will need either:
- A 2-week warmup period sending small daily volumes from mediagraf.se before scaling, or
- A transactional email provider (Postmark, AWS SES, SendGrid) with higher inherent limits + better-managed reputation

## 1. Google Cloud project + OAuth client

1. Visit https://console.cloud.google.com — sign in as `gustaf@mediagraf.se` (the Workspace admin).
2. Create a new project: "mediagraf-pilot".
3. **APIs & Services → Library** → enable "Gmail API".
4. **APIs & Services → OAuth consent screen**:
   - User Type: **Internal** (only works because mediagraf.se is your Workspace)
   - App name: "Mediagraf Pilot"
   - User support email: `gustaf@mediagraf.se`
   - Save.
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: Web application
   - Name: "pilot-daemon"
   - Authorized redirect URI: `http://localhost:3001/oauth2callback`
   - Copy the Client ID and Client Secret into `.env` as `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET`.

## 2. Slack app

1. Visit https://api.slack.com/apps → "Create New App" → "From scratch".
2. App name: "Mediagraf Pilot", workspace: your Slack workspace.
3. **OAuth & Permissions** → Bot Token Scopes: add `chat:write` and `commands`.
4. Install to workspace. Copy "Bot User OAuth Token" (starts `xoxb-`) → `.env` as `SLACK_BOT_TOKEN`.
5. **Basic Information** → copy "Signing Secret" → `.env` as `SLACK_SIGNING_SECRET`.
6. Create a channel `#pilot-eskaleringar` (or reuse existing). Right-click → View channel details → copy the Channel ID → `.env` as `SLACK_CHANNEL_ID`. Invite the bot to the channel: `/invite @Mediagraf Pilot`.
7. **Interactivity & Shortcuts** → toggle on. Request URL: leave blank for now; you'll fill it after starting ngrok.

## 3. ngrok

1. Install: `brew install ngrok` (macOS).
2. Sign up at ngrok.com, copy your authtoken: `ngrok config add-authtoken <token>`.
3. In a dedicated terminal window: `ngrok http 3000`. Copy the `https://*.ngrok-free.app` URL.
4. Back in Slack app config → Interactivity & Shortcuts → Request URL: `https://<your-ngrok-subdomain>.ngrok-free.app/slack/interactivity` → Save.

Re-run step 3-4 whenever you restart ngrok (free tier rotates URLs).

## 4. Gmail OAuth consent

1. `cp .env.example .env` and fill in the values you've collected above.
2. Run: `npm run pilot-auth`
3. Browser opens → consent (only your gustaf@mediagraf.se can grant because it's Internal).
4. Token saved to `~/.config/mediagraf/pilot-gmail-token.json`.

## 5. Pilot init

1. Confirm `data/pilot-overrides.json` has `"active_pilot_kommun_kods": ["9999"]` for rehearsal.
2. Run: `npm run pilot-init`
3. Expected output: `Created 2 conversations, skipped 0 duplicates.`

## 6. Start the daemon

1. Run: `npm run pilot-daemon`
2. Expected logs:
   - `Cron scheduled: tick=*/15 * * * *, followup=0 9 * * *`
   - `SENT T-INITIAL → Testkommun/central`
   - `SENT T-INITIAL → Testkommun/utbildning` (day 2 — wait or set PILOT_CLOCK_OFFSET_DAYS=1 for rehearsal)
   - `Slack interactivity listener on :3000`
3. Check `gustaf.hard@gmail.com` inbox for the two incoming requests from `gustaf@mediagraf.se`.

## 7. Walk through Stage 0 scenarios

Follow the six scenarios from the spec's "Stage 0" section, replying from `gustaf.hard@gmail.com`. After each, inspect:

```bash
sqlite3 data/pilot.db "select kommun_namn, role, state, arendenummer, followup_count from conversations"
sqlite3 data/pilot.db "select kommun_namn, classification, classification_confidence, attachment_count from messages m join conversations c on c.id=m.conversation_id where direction='inbound'"
ls -la data/contracts/9999/
```

## 8. Stage 0 → Stage 1 cutover

After all six scenarios pass:

```bash
# Clean rehearsal state
rm data/pilot.db data/pilot.db-{journal,wal,shm} 2>/dev/null
rm -rf data/contracts/9999

# Flip to live
# edit data/pilot-overrides.json:
#   "active_pilot_kommun_kods": ["2418","1438","0509","2404","0560"]

# Confirm clock-skew is no longer allowed:
PILOT_CLOCK_OFFSET_DAYS=14 node -e "import('./src/pilot-config.js').then(m => { const o = m.loadOverrides(); console.log('allowed?', m.isClockSkewAllowed(o)); })"
# Expected: allowed? false

# Re-seed and start
npm run pilot-init
npm run pilot-daemon
```

Day 1: Malå. Day 2: Dals-Ed. Day 3: Ödeshög. Day 4: Vindeln. Day 5: Boxholm.
