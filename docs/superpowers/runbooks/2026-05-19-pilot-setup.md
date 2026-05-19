# Pilot setup runbook

One-time setup steps before running Stage 0 rehearsal.

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
