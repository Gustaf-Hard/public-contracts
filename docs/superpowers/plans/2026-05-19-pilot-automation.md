# V1 Pilot Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approval-first offentlighetsprincipen request-loop bot specified in `docs/superpowers/specs/2026-05-18-pilot-automation-design.md` — Stage 0 (synthetic Testkommun) and Stage 1 (5 real small kommuner), same code, only config differs.

**Autonomy model (v1):** Every outbound message *except T-INITIAL* is drafted by the bot and posted to Slack for the human to Approve / Edit / Skip before send. State transitions happen automatically (bookkeeping is reversible); only outbound communication is gated. Each decision is logged to a `decisions` table so we can promote classes to auto-handle in v2 based on real unmodified-approval rates.

**Architecture:** Node.js ESM, extends existing repo. Pure-logic modules (`templates`, `classifier`, `conversation`) tested directly. I/O modules (`gmail`, `slack`, `storage`, `attachments`) take dependency-injected clients so tests run fully offline. A `tick` orchestrator wires them. A long-running `daemon` schedules ticks via `node-cron` and serves the Slack interactivity webhook via Express; the webhook handler is where Approve/Edit/Skip actually trigger outbound Gmail sends.

**Tech Stack:** `better-sqlite3` (synchronous, fast, easy to test), `googleapis` (Gmail), `@slack/bolt` (Slack signing + payloads), `express`, `node-cron`, `dotenv`, vitest. No new test framework.

**Spec:** `docs/superpowers/specs/2026-05-18-pilot-automation-design.md`

---

## Task 1: Add dependencies and config scaffolding

**Files:**
- Modify: `package.json`
- Create: `.env.example`
- Modify: `.gitignore`
- Create: `data/pilot-overrides.json`

- [ ] **Step 1: Update package.json**

Add to `dependencies`:

```json
"@slack/bolt": "^4.0.0",
"better-sqlite3": "^11.3.0",
"dotenv": "^16.4.5",
"express": "^4.21.0",
"googleapis": "^144.0.0",
"node-cron": "^3.0.3"
```

Add to `scripts`:

```json
"pilot-auth": "node scripts/pilot-auth.js",
"pilot-init": "node scripts/pilot-init.js",
"pilot-daemon": "node scripts/pilot-daemon.js",
"pilot-resolve": "node scripts/pilot-resolve.js"
```

- [ ] **Step 2: Run install**

Run: `npm install`
Expected: deps install cleanly. `better-sqlite3` may compile native — that's fine.

- [ ] **Step 3: Create .env.example**

```
# Gmail OAuth (register at https://console.cloud.google.com → Workspace project → APIs & Services)
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REDIRECT_URI=http://localhost:3001/oauth2callback
GMAIL_USER_EMAIL=gustaf@mediagraf.se
GMAIL_FROM_NAME=Gustaf Hård af Segerstad
GMAIL_LABEL_PREFIX=mediagraf/pilot

# Slack app (register at https://api.slack.com/apps)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=
SLACK_CHANNEL_ID=
SLACK_INTERACTIVITY_PORT=3000

# Pilot daemon
PILOT_TICK_CRON=*/15 * * * *
PILOT_FOLLOWUP_CRON=0 9 * * *
PILOT_CLOCK_OFFSET_DAYS=0
```

- [ ] **Step 4: Update .gitignore**

Append:

```
# pilot
.env
data/pilot.db
data/pilot.db-journal
data/pilot.db-wal
data/pilot.db-shm
data/contracts/
~/.config/mediagraf/
*.gmail-token.json
```

- [ ] **Step 5: Create data/pilot-overrides.json**

```json
{
  "active_pilot_kommun_kods": ["9999"],
  "rehearsal_kommuner": [
    {
      "kommun_kod": "9999",
      "kommun_namn": "Testkommun",
      "lan": "Testlän",
      "folkmangd": 0,
      "contacts": [
        { "role": "central", "email": "gustaf.hard@gmail.com" },
        { "role": "utbildning", "email": "gustaf.hard@gmail.com" }
      ]
    }
  ],
  "live_kommun_kods": ["2418", "1438", "0509", "2404", "0560"]
}
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .env.example .gitignore data/pilot-overrides.json
git commit -m "chore(pilot): add deps and config scaffolding for v1 pilot"
```

---

## Task 2: Pilot config loader

**Files:**
- Create: `src/pilot-config.js`
- Create: `tests/pilot-config.test.js`

Loads `.env` + `data/pilot-overrides.json`, resolves which kommuner the pilot acts on, and enforces the clock-skew guard (must not fast-forward when live kommuner are active).

- [ ] **Step 1: Write the failing test**

Create `tests/pilot-config.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  resolveActiveKommuner,
  isClockSkewAllowed,
  getEffectiveNow,
} from '../src/pilot-config.js';

const overrides = {
  active_pilot_kommun_kods: ['9999'],
  rehearsal_kommuner: [
    {
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      lan: 'Testlän',
      folkmangd: 0,
      contacts: [
        { role: 'central', email: 'gustaf.hard@gmail.com' },
        { role: 'utbildning', email: 'gustaf.hard@gmail.com' },
      ],
    },
  ],
  live_kommun_kods: ['2418', '1438', '0509', '2404', '0560'],
};

const liveMunicipalities = [
  {
    kommun_kod: '2418',
    kommun_namn: 'Malå',
    lan: 'Västerbottens län',
    folkmangd: 2902,
    contacts: [
      { role: 'central', email: 'kommun@mala.se', forvaltning_namn: null, source_url: '', found_via: 'pattern_match' },
      { role: 'utbildning', email: 'bun@mala.se', forvaltning_namn: 'BUN', source_url: '', found_via: 'pattern_match' },
    ],
  },
];

describe('resolveActiveKommuner', () => {
  it('returns the rehearsal kommun when 9999 is active', () => {
    const result = resolveActiveKommuner(overrides, liveMunicipalities);
    expect(result).toHaveLength(1);
    expect(result[0].kommun_kod).toBe('9999');
    expect(result[0].contacts).toHaveLength(2);
  });

  it('returns live kommuner when their kods are active', () => {
    const flipped = { ...overrides, active_pilot_kommun_kods: ['2418'] };
    const result = resolveActiveKommuner(flipped, liveMunicipalities);
    expect(result).toHaveLength(1);
    expect(result[0].kommun_namn).toBe('Malå');
    expect(result[0].contacts.find((c) => c.role === 'central').email).toBe('kommun@mala.se');
  });

  it('throws when an active kod cannot be resolved from either source', () => {
    const bad = { ...overrides, active_pilot_kommun_kods: ['7777'] };
    expect(() => resolveActiveKommuner(bad, liveMunicipalities)).toThrow(/7777/);
  });

  it('throws when both rehearsal and live kods are mixed', () => {
    const mixed = { ...overrides, active_pilot_kommun_kods: ['9999', '2418'] };
    expect(() => resolveActiveKommuner(mixed, liveMunicipalities)).toThrow(/mix/i);
  });
});

describe('isClockSkewAllowed', () => {
  it('allows skew when active is exactly ["9999"]', () => {
    expect(isClockSkewAllowed(overrides)).toBe(true);
  });

  it('rejects skew when any live kod is active', () => {
    const flipped = { ...overrides, active_pilot_kommun_kods: ['2418'] };
    expect(isClockSkewAllowed(flipped)).toBe(false);
  });

  it('rejects skew when no kods are active', () => {
    const empty = { ...overrides, active_pilot_kommun_kods: [] };
    expect(isClockSkewAllowed(empty)).toBe(false);
  });
});

describe('getEffectiveNow', () => {
  it('returns a Date offset by PILOT_CLOCK_OFFSET_DAYS when skew is allowed', () => {
    const base = new Date('2026-05-19T10:00:00Z');
    const now = getEffectiveNow({ env: { PILOT_CLOCK_OFFSET_DAYS: '7' }, overrides, baseNow: base });
    const diffDays = (now.getTime() - base.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(7);
  });

  it('ignores PILOT_CLOCK_OFFSET_DAYS when skew is not allowed', () => {
    const base = new Date('2026-05-19T10:00:00Z');
    const flipped = { ...overrides, active_pilot_kommun_kods: ['2418'] };
    const now = getEffectiveNow({ env: { PILOT_CLOCK_OFFSET_DAYS: '7' }, overrides: flipped, baseNow: base });
    expect(now.getTime()).toBe(base.getTime());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pilot-config.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/pilot-config.js**

```js
import { readFileSync, existsSync } from 'node:fs';

export function loadOverrides(path = 'data/pilot-overrides.json') {
  if (!existsSync(path)) throw new Error(`Pilot overrides not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function resolveActiveKommuner(overrides, liveMunicipalities) {
  const active = overrides.active_pilot_kommun_kods ?? [];
  if (active.length === 0) return [];

  const rehearsalKods = new Set((overrides.rehearsal_kommuner ?? []).map((k) => k.kommun_kod));
  const hasRehearsal = active.some((k) => rehearsalKods.has(k));
  const hasLive = active.some((k) => !rehearsalKods.has(k));
  if (hasRehearsal && hasLive) {
    throw new Error('active_pilot_kommun_kods must not mix rehearsal (9999) with live kommuner');
  }

  const liveByKod = new Map(liveMunicipalities.map((m) => [m.kommun_kod, m]));
  const out = [];
  for (const kod of active) {
    if (rehearsalKods.has(kod)) {
      const r = overrides.rehearsal_kommuner.find((k) => k.kommun_kod === kod);
      out.push(r);
    } else {
      const live = liveByKod.get(kod);
      if (!live) throw new Error(`Active kommun_kod ${kod} not found in live municipalities`);
      out.push(live);
    }
  }
  return out;
}

export function isClockSkewAllowed(overrides) {
  const active = overrides.active_pilot_kommun_kods ?? [];
  if (active.length !== 1) return false;
  const rehearsalKods = new Set((overrides.rehearsal_kommuner ?? []).map((k) => k.kommun_kod));
  return rehearsalKods.has(active[0]);
}

export function getEffectiveNow({ env = process.env, overrides, baseNow = new Date() } = {}) {
  if (!isClockSkewAllowed(overrides)) return baseNow;
  const days = parseInt(env.PILOT_CLOCK_OFFSET_DAYS ?? '0', 10);
  if (!Number.isFinite(days) || days === 0) return baseNow;
  return new Date(baseNow.getTime() + days * 24 * 60 * 60 * 1000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pilot-config.test.js`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/pilot-config.js tests/pilot-config.test.js
git commit -m "feat(pilot): config loader with clock-skew guard"
```

---

## Task 3: Templates

**Files:**
- Create: `src/templates.js`
- Create: `tests/templates.test.js`

Pure functions returning `{ subject, body }`. One per template named in the spec.

- [ ] **Step 1: Write the failing test**

Create `tests/templates.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  T_INITIAL,
  T_PRECISION,
  T_RECEIPT,
  T_FOLLOWUP_NUDGE,
  T_FOLLOWUP_CLOSE,
} from '../src/templates.js';

const ctx = {
  kommun_namn: 'Malå',
  role: 'utbildning',
  from_email: 'gustaf@mediagraf.se',
  from_name: 'Gustaf Hård af Segerstad',
  thread_subject: 'Begäran om allmänna handlingar – avtal för digitala verktyg',
  days_since_send: 7,
};

describe('T_INITIAL', () => {
  it('renders the offentlighetsprincipen request for utbildning role', () => {
    const m = T_INITIAL(ctx);
    expect(m.subject).toMatch(/Begäran om allmänna handlingar/);
    expect(m.body).toMatch(/offentlighetsprincipen/);
    expect(m.body).toMatch(/utbildningsförvaltningen/);
    expect(m.body).toMatch(/Skolon/);
    expect(m.body).toMatch(/Avtalsvärde eller årskostnad/);
    expect(m.body).toMatch(/Gustaf Hård af Segerstad/);
    expect(m.body).toMatch(/gustaf@mediagraf.se/);
  });

  it('uses "kommunen" as scope when role is central', () => {
    const m = T_INITIAL({ ...ctx, role: 'central' });
    expect(m.body).toMatch(/inom kommunen/);
    expect(m.body).not.toMatch(/utbildningsförvaltningen/);
  });
});

describe('T_PRECISION', () => {
  it('renders the precision reply with reply-style subject', () => {
    const m = T_PRECISION(ctx);
    expect(m.subject).toMatch(/^Re: /);
    expect(m.body).toMatch(/preciserar gärna/);
    expect(m.body).toMatch(/Skolon/);
    expect(m.body).toMatch(/leverantör/);
  });
});

describe('T_RECEIPT', () => {
  it('renders a short tack and asks for completeness', () => {
    const m = T_RECEIPT(ctx);
    expect(m.subject).toMatch(/^Re: /);
    expect(m.body).toMatch(/Tack/);
    expect(m.body).toMatch(/samtliga avtal/);
  });
});

describe('T_FOLLOWUP_NUDGE', () => {
  it('renders a polite follow-up referencing the day count', () => {
    const m = T_FOLLOWUP_NUDGE(ctx);
    expect(m.subject).toMatch(/Påminnelse/);
    expect(m.body).toMatch(/7 dagar sedan/);
  });
});

describe('T_FOLLOWUP_CLOSE', () => {
  it('asks whether the request can be considered fulfilled', () => {
    const m = T_FOLLOWUP_CLOSE(ctx);
    expect(m.body).toMatch(/ytterligare avtal/);
    expect(m.body).toMatch(/slutförd/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/templates.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/templates.js**

```js
function scopeText(role) {
  return role === 'central' ? 'kommunen' : 'utbildningsförvaltningen';
}

function signature({ from_name, from_email }) {
  return `Med vänliga hälsningar,\n${from_name}\n${from_email}`;
}

export function T_INITIAL(ctx) {
  const scope = scopeText(ctx.role);
  return {
    subject: 'Begäran om allmänna handlingar – avtal för digitala verktyg, lärplattformar och läromedel',
    body: [
      'Hej,',
      '',
      'Jag begär härmed att ta del av allmänna handlingar med stöd av offentlighetsprincipen (2 kap. tryckfrihetsförordningen).',
      '',
      `Jag önskar ta del av de faktiska avtalsdokumenten för samtliga gällande avtal avseende digitala verktyg, lärplattformar och läromedel inom ${scope}.`,
      '',
      'Specifikt önskar jag information om aktiva avtal (ej utgångna):',
      '- Lärplattformar och LMS (t.ex. Google Workspace, Microsoft 365, Skolon)',
      '- Digitala läromedel och licenser',
      '- Administrativa system kopplade till undervisning',
      '',
      'Per avtal önskar jag följande uppgifter där möjligt:',
      '- Leverantör',
      '- Produktnamn/tjänst',
      '- Avtalsvärde eller årskostnad',
      '- Avtalstid (start- och slutdatum)',
      '',
      'Handlingarna önskas i digital form (PDF eller motsvarande).',
      '',
      'Om delar av handlingarna bedöms sekretessbelagda ber jag om ett motiverat avslagsbeslut för dessa delar enligt 6 kap. 3 § offentlighets- och sekretesslagen.',
      '',
      signature(ctx),
    ].join('\n'),
  };
}

export function T_PRECISION(ctx) {
  const scope = scopeText(ctx.role);
  return {
    subject: `Re: ${ctx.thread_subject}`,
    body: [
      'Hej,',
      '',
      'Tack för snabbt svar! Jag preciserar gärna min begäran.',
      '',
      `Jag efterfrågar aktiva avtal (ej utgångna) avseende digitala verktyg inom ${scope}:`,
      '- Lärplattformar och LMS (t.ex. Google Workspace, Microsoft 365, Skolon)',
      '- Digitala läromedel och licenser',
      '- Administrativa system kopplade till undervisning',
      '',
      'Per avtal önskar jag: leverantör, produktnamn/tjänst, avtalsvärde eller årskostnad, avtalstid (start- och slutdatum). Dels de fullständiga avtalshandlingarna i PDF-format.',
      '',
      signature(ctx),
    ].join('\n'),
  };
}

export function T_RECEIPT(ctx) {
  return {
    subject: `Re: ${ctx.thread_subject}`,
    body: [
      'Hej,',
      '',
      'Tack så mycket för avtalen — jag har tagit emot dem. Är detta samtliga avtal eller är fler på väg?',
      '',
      signature(ctx),
    ].join('\n'),
  };
}

export function T_FOLLOWUP_NUDGE(ctx) {
  return {
    subject: `Påminnelse: ${ctx.thread_subject}`,
    body: [
      'Hej,',
      '',
      `Jag vill bara följa upp om min begäran om allmänna handlingar (skickad ${ctx.days_since_send} dagar sedan). Behöver ni ytterligare information från min sida för att kunna behandla ärendet?`,
      '',
      signature(ctx),
    ].join('\n'),
  };
}

export function T_FOLLOWUP_CLOSE(ctx) {
  return {
    subject: `Re: ${ctx.thread_subject}`,
    body: [
      'Hej,',
      '',
      'Tack igen för avtalen jag fått. Har ni ytterligare avtal som inte skickats än, eller kan vi betrakta begäran som slutförd från er sida?',
      '',
      signature(ctx),
    ].join('\n'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/templates.test.js`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/templates.js tests/templates.test.js
git commit -m "feat(pilot): email templates"
```

---

## Task 4: Reply classifier

**Files:**
- Create: `src/classifier.js`
- Create: `tests/classifier.test.js`

Pure function `classify(message) → { class, confidence, signals }`. `class` ∈ `{auto_ack, clarification, delivery, dead_end, unknown}`. Confidence is a 0..1 score; below threshold OR margin → `unknown`.

- [ ] **Step 1: Write the failing test**

Create `tests/classifier.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { classify } from '../src/classifier.js';

function msg(overrides = {}) {
  return {
    from: 'registrator@kommun.se',
    subject: 'Re: Begäran om allmänna handlingar',
    body: '',
    attachment_count: 0,
    ...overrides,
  };
}

describe('classify — auto_ack', () => {
  it('catches flexiteBPMS-style auto-ack with Ärendenummer', () => {
    const r = classify(msg({ body: 'Tack för att du hörde av dig\n\nVi har tagit emot ditt ärende.\n\nÄrendenummer: K202642713' }));
    expect(r.class).toBe('auto_ack');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.signals).toContain('arendenummer');
  });

  it('catches "Tack för att du hörde av dig"', () => {
    const r = classify(msg({ body: 'Tack för att du hörde av dig. Vi svarar så fort vi kan.' }));
    expect(r.class).toBe('auto_ack');
  });
});

describe('classify — clarification', () => {
  it('catches Mikaela-style precision request', () => {
    const r = classify(msg({
      body: [
        'Hej',
        '',
        'För att kunna hjälpa dig på bästa sätt, önskar jag veta:',
        '– Om begäran avser en viss tidsperiod',
        '– Om den gäller specifika typer av system eller leverantörer',
        '– Om du är ute efter en sammanställning eller specifika avtal',
        '',
        'Vänligen återkom med förtydligande, så återkommer jag med beräknad handläggningstid.',
      ].join('\n'),
    }));
    expect(r.class).toBe('clarification');
    expect(r.signals.length).toBeGreaterThan(0);
  });

  it('catches "precisera"', () => {
    const r = classify(msg({ body: 'Kan du precisera din begäran?' }));
    expect(r.class).toBe('clarification');
  });
});

describe('classify — delivery', () => {
  it('catches PDF attachment with "bifogat" body', () => {
    const r = classify(msg({
      body: 'Här kommer bifogat det avtal du efterfrågat.',
      attachment_count: 1,
    }));
    expect(r.class).toBe('delivery');
  });

  it('requires at least one attachment', () => {
    const r = classify(msg({
      body: 'Här kommer bifogat det avtal du efterfrågat.',
      attachment_count: 0,
    }));
    expect(r.class).not.toBe('delivery');
  });
});

describe('classify — dead_end', () => {
  it('catches "finns inte"', () => {
    const r = classify(msg({ body: 'Vi har tyvärr inga avtal av detta slag i vår verksamhet, det finns inte hos oss.' }));
    expect(r.class).toBe('dead_end');
  });

  it('catches "hänvisar till"', () => {
    const r = classify(msg({ body: 'Vi hänvisar er till stadsledningskontoret för dessa avtal.' }));
    expect(r.class).toBe('dead_end');
  });

  it('catches the "samtliga avtal" closer as dead_end', () => {
    const r = classify(msg({ body: 'Detta var samtliga avtal vi har att lämna ut.' }));
    expect(r.class).toBe('dead_end');
  });
});

describe('classify — unknown', () => {
  it('returns unknown when no patterns match', () => {
    const r = classify(msg({ body: 'Hej, kan du ringa mig på 070-1234567 så pratar vi om detta?' }));
    expect(r.class).toBe('unknown');
  });

  it('returns unknown when body is empty', () => {
    const r = classify(msg({ body: '' }));
    expect(r.class).toBe('unknown');
  });
});

describe('classify — arendenummer extraction', () => {
  it('exposes the captured Ärendenummer for storage', () => {
    const r = classify(msg({ body: 'Ärendenummer: K202642713\n\nVi svarar inom 4 veckor.' }));
    expect(r.extracted?.arendenummer).toBe('K202642713');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/classifier.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/classifier.js**

```js
const AUTO_ACK_PATTERNS = [
  { name: 'arendenummer', re: /\bÄrendenummer\s*[:\-]\s*[KkA-Z]\d{4,}/i, score: 0.8 },
  { name: 'tack_for_att', re: /Tack för att du hörde av dig/i, score: 0.7 },
  { name: 'flexite', re: /flexiteBPMS/i, score: 0.7 },
  { name: 'kvittens', re: /kvittens/i, score: 0.4 },
  { name: 'tagit_emot', re: /vi har tagit emot/i, score: 0.5 },
];

const CLARIFICATION_PATTERNS = [
  { name: 'precisera', re: /precisera/i, score: 0.8 },
  { name: 'fortydliga', re: /förtydliga|förtydligande/i, score: 0.7 },
  { name: 'tidsperiod', re: /tidsperiod/i, score: 0.5 },
  { name: 'specifika_system', re: /specifika (typer av )?system/i, score: 0.5 },
  { name: 'sammanstallning_eller', re: /sammanställning eller specifika/i, score: 0.7 },
  { name: 'onskar_jag_veta', re: /önskar jag veta/i, score: 0.5 },
  { name: 'behover_jag', re: /behöver (jag |vi )/i, score: 0.3 },
];

const DELIVERY_BODY_PATTERNS = [
  { name: 'bifogat', re: /bifogat|bifogar/i, score: 0.6 },
  { name: 'har_kommer', re: /här kommer/i, score: 0.5 },
  { name: 'avtalet', re: /avtalet|avtalshandlingar/i, score: 0.4 },
];

const DEAD_END_PATTERNS = [
  { name: 'finns_inte', re: /finns inte hos oss|finns ej|inga avtal/i, score: 0.8 },
  { name: 'hanvisar_till', re: /hänvisar (er |dig )?till/i, score: 0.7 },
  { name: 'omfattas_inte', re: /omfattas inte/i, score: 0.6 },
  { name: 'kan_ej_lamna_ut', re: /kan (vi )?inte lämna ut|kan ej lämna ut/i, score: 0.7 },
  { name: 'ligger_hos', re: /ligger hos|hanteras (centralt|hos)/i, score: 0.4 },
  { name: 'samtliga_avtal', re: /(detta var |var )samtliga avtal/i, score: 0.8 },
];

const ARENDENUMMER_RE = /\bÄrendenummer\s*[:\-]\s*([KkA-Z]\d{4,})/i;

const THRESHOLD = 0.6;
const MARGIN = 0.2;

function scoreClass(patterns, body) {
  const hits = [];
  let total = 0;
  for (const p of patterns) {
    if (p.re.test(body)) {
      hits.push(p.name);
      total += p.score;
    }
  }
  return { score: Math.min(total, 1), signals: hits };
}

export function classify(message) {
  const body = message.body ?? '';
  const attachments = message.attachment_count ?? 0;

  const candidates = {
    auto_ack: scoreClass(AUTO_ACK_PATTERNS, body),
    clarification: scoreClass(CLARIFICATION_PATTERNS, body),
    delivery: (() => {
      if (attachments < 1) return { score: 0, signals: [] };
      const r = scoreClass(DELIVERY_BODY_PATTERNS, body);
      return { score: Math.min(r.score + 0.5, 1), signals: ['has_attachment', ...r.signals] };
    })(),
    dead_end: scoreClass(DEAD_END_PATTERNS, body),
  };

  const ranked = Object.entries(candidates)
    .map(([cls, { score, signals }]) => ({ cls, score, signals }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const second = ranked[1];

  const extracted = {};
  const arendeMatch = body.match(ARENDENUMMER_RE);
  if (arendeMatch) extracted.arendenummer = arendeMatch[1];

  if (top.score < THRESHOLD || (top.score - (second?.score ?? 0)) < MARGIN) {
    return {
      class: 'unknown',
      confidence: top.score,
      signals: top.signals,
      extracted,
    };
  }

  return {
    class: top.cls,
    confidence: top.score,
    signals: top.signals,
    extracted,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/classifier.test.js`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add src/classifier.js tests/classifier.test.js
git commit -m "feat(pilot): regex+keyword classifier for incoming replies"
```

---

## Task 5: SQLite storage layer

**Files:**
- Create: `src/storage.js`
- Create: `tests/storage.test.js`

Wraps `better-sqlite3`. Single function `openDb(path)` returns a thin object exposing helpers: `migrate()`, `createConversation()`, `getConversation()`, `listConversations()`, `updateConversationState()`, `recordMessage()`, `recordAttachment()`, `recordEscalation()`, `resolveEscalation()`, plus a few queries the daemon needs.

- [ ] **Step 1: Write the failing test**

Create `tests/storage.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-storage-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('migrate', () => {
  it('creates the four tables idempotently', () => {
    expect(() => db.migrate()).not.toThrow();
    expect(() => db.migrate()).not.toThrow();
  });
});

describe('conversations', () => {
  it('creates and retrieves a conversation', () => {
    const id = db.createConversation({
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com',
      scheduled_send_at: '2026-05-19T10:00:00Z',
    });
    const conv = db.getConversation(id);
    expect(conv.state).toBe('INITIAL');
    expect(conv.kommun_kod).toBe('9999');
    expect(conv.role).toBe('utbildning');
  });

  it('enforces unique (kommun_kod, role)', () => {
    const args = {
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com',
      scheduled_send_at: '2026-05-19T10:00:00Z',
    };
    db.createConversation(args);
    expect(() => db.createConversation(args)).toThrow();
  });

  it('updates state and stamps state_changed_at', () => {
    const id = db.createConversation({
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      role: 'central',
      contact_email: 'gustaf.hard@gmail.com',
      scheduled_send_at: '2026-05-19T10:00:00Z',
    });
    const before = db.getConversation(id).state_changed_at;
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'tid1', last_outbound_at: '2026-05-19T10:01:00Z' });
    const after = db.getConversation(id);
    expect(after.state).toBe('SENT');
    expect(after.gmail_thread_id).toBe('tid1');
    expect(after.state_changed_at).not.toBe(before);
  });

  it('lists conversations in a given state', () => {
    db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'utbildning', contact_email: 'b@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    expect(db.listConversationsByState('INITIAL')).toHaveLength(2);
    expect(db.listConversationsByState('SENT')).toHaveLength(0);
  });
});

describe('messages', () => {
  it('records inbound and outbound messages tied to a conversation', () => {
    const id = db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    db.recordMessage({
      conversation_id: id,
      gmail_message_id: 'm1',
      direction: 'outbound',
      from_email: 'gustaf@mediagraf.se',
      to_email: 'a@x.se',
      subject: 'Begäran',
      body_text: 'Hej',
      classification: null,
      classification_confidence: null,
      received_at: '2026-05-19T10:00:00Z',
      attachment_count: 0,
    });
    db.recordMessage({
      conversation_id: id,
      gmail_message_id: 'm2',
      direction: 'inbound',
      from_email: 'a@x.se',
      to_email: 'gustaf@mediagraf.se',
      subject: 'Re: Begäran',
      body_text: 'Tack',
      classification: 'auto_ack',
      classification_confidence: 0.85,
      received_at: '2026-05-19T10:05:00Z',
      attachment_count: 0,
    });
    const messages = db.listMessages(id);
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.direction === 'inbound').classification).toBe('auto_ack');
  });

  it('hasGmailMessageId returns true for stored ids', () => {
    const id = db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    db.recordMessage({
      conversation_id: id, gmail_message_id: 'mX', direction: 'inbound',
      from_email: 'a@x.se', to_email: 'gustaf@mediagraf.se',
      subject: 's', body_text: 'b', classification: 'auto_ack',
      classification_confidence: 0.9, received_at: '2026-05-19T10:00:00Z', attachment_count: 0,
    });
    expect(db.hasGmailMessageId('mX')).toBe(true);
    expect(db.hasGmailMessageId('mY')).toBe(false);
  });
});

describe('escalations', () => {
  it('records and resolves an escalation with subject + body', () => {
    const cid = db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    const eid = db.recordEscalation({
      conversation_id: cid,
      message_id: null,
      reason: 'classifier returned clarification',
      draft_template: 'T_PRECISION',
      draft_subject: 'Re: Begäran',
      draft_body: 'Tack för...',
      slack_ts: '1234.5678',
    });
    const list = db.listOpenEscalations();
    expect(list).toHaveLength(1);
    expect(list[0].draft_body).toBe('Tack för...');
    expect(list[0].draft_template).toBe('T_PRECISION');
    db.resolveEscalation(eid, { status: 'resolved_send', resolved_text: 'Tack för...' });
    expect(db.listOpenEscalations()).toHaveLength(0);
  });
});

describe('decisions', () => {
  it('records a decision tied to an escalation', () => {
    const cid = db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'utbildning', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    const eid = db.recordEscalation({
      conversation_id: cid, reason: 'r', draft_template: 'T_PRECISION',
      draft_subject: 'Re: x', draft_body: 'body',
    });
    const did = db.recordDecision({
      escalation_id: eid,
      conversation_id: cid,
      conversation_state: 'ACK_RECEIVED',
      classifier_class: 'clarification',
      classifier_confidence: 0.85,
      draft_template: 'T_PRECISION',
      draft_body: 'body',
      decision: 'approve_unmodified',
      final_body: 'body',
    });
    expect(did).toBeGreaterThan(0);
    const list = db.listDecisions();
    expect(list).toHaveLength(1);
    expect(list[0].decision).toBe('approve_unmodified');
    expect(list[0].classifier_class).toBe('clarification');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/storage.js**

```js
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  kommun_kod TEXT NOT NULL,
  kommun_namn TEXT NOT NULL,
  role TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  scheduled_send_at TEXT NOT NULL,
  gmail_thread_id TEXT,
  state TEXT NOT NULL DEFAULT 'INITIAL',
  state_changed_at TEXT NOT NULL,
  last_outbound_at TEXT,
  arendenummer TEXT,
  followup_count INTEGER NOT NULL DEFAULT 0,
  receipt_sent INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE(kommun_kod, role)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  gmail_message_id TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL,
  from_email TEXT,
  to_email TEXT,
  subject TEXT,
  body_text TEXT,
  classification TEXT,
  classification_confidence REAL,
  received_at TEXT NOT NULL,
  attachment_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  filename TEXT NOT NULL,
  saved_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  message_id INTEGER REFERENCES messages(id),
  reason TEXT NOT NULL,
  draft_template TEXT,
  draft_subject TEXT,
  draft_body TEXT,
  slack_ts TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TEXT,
  resolved_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  escalation_id INTEGER NOT NULL REFERENCES escalations(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  conversation_state TEXT NOT NULL,
  classifier_class TEXT,
  classifier_confidence REAL,
  draft_template TEXT,
  draft_body TEXT NOT NULL,
  decision TEXT NOT NULL,
  final_body TEXT,
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_class_state ON decisions(classifier_class, conversation_state, decision);
`;

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  function migrate() {
    db.exec(SCHEMA);
  }

  function createConversation({ kommun_kod, kommun_namn, role, contact_email, scheduled_send_at }) {
    const stmt = db.prepare(`
      INSERT INTO conversations (kommun_kod, kommun_namn, role, contact_email, scheduled_send_at, state_changed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    const result = stmt.run(kommun_kod, kommun_namn, role, contact_email, scheduled_send_at);
    return Number(result.lastInsertRowid);
  }

  function getConversation(id) {
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  function listConversationsByState(state) {
    return db.prepare('SELECT * FROM conversations WHERE state = ? ORDER BY id').all(state);
  }

  function listAllConversations() {
    return db.prepare('SELECT * FROM conversations ORDER BY id').all();
  }

  function listConversationsDueForInitialSend(nowIso) {
    return db.prepare(`
      SELECT * FROM conversations
      WHERE state = 'INITIAL' AND scheduled_send_at <= ?
      ORDER BY scheduled_send_at, id
    `).all(nowIso);
  }

  function updateConversationState(id, state, patch = {}) {
    const allowed = ['gmail_thread_id', 'last_outbound_at', 'arendenummer', 'notes', 'followup_count', 'receipt_sent'];
    const sets = ["state = ?", "state_changed_at = datetime('now')"];
    const values = [state];
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        sets.push(`${k} = ?`);
        values.push(patch[k]);
      }
    }
    values.push(id);
    db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  function recordMessage(m) {
    const stmt = db.prepare(`
      INSERT INTO messages (
        conversation_id, gmail_message_id, direction, from_email, to_email,
        subject, body_text, classification, classification_confidence,
        received_at, attachment_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      m.conversation_id, m.gmail_message_id, m.direction, m.from_email, m.to_email,
      m.subject, m.body_text, m.classification, m.classification_confidence,
      m.received_at, m.attachment_count
    );
    return Number(r.lastInsertRowid);
  }

  function listMessages(conversationId) {
    return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY received_at, id').all(conversationId);
  }

  function hasGmailMessageId(gmailMessageId) {
    return !!db.prepare('SELECT 1 FROM messages WHERE gmail_message_id = ?').get(gmailMessageId);
  }

  function recordAttachment(a) {
    const r = db.prepare(`
      INSERT INTO attachments (message_id, filename, saved_path, mime_type, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run(a.message_id, a.filename, a.saved_path, a.mime_type, a.size_bytes);
    return Number(r.lastInsertRowid);
  }

  function recordEscalation(e) {
    const r = db.prepare(`
      INSERT INTO escalations (conversation_id, message_id, reason, draft_template, draft_subject, draft_body, slack_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.conversation_id, e.message_id ?? null, e.reason,
      e.draft_template ?? null, e.draft_subject ?? null, e.draft_body ?? null,
      e.slack_ts ?? null
    );
    return Number(r.lastInsertRowid);
  }

  function recordDecision(d) {
    const r = db.prepare(`
      INSERT INTO decisions (
        escalation_id, conversation_id, conversation_state,
        classifier_class, classifier_confidence,
        draft_template, draft_body, decision, final_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      d.escalation_id, d.conversation_id, d.conversation_state,
      d.classifier_class ?? null, d.classifier_confidence ?? null,
      d.draft_template ?? null, d.draft_body, d.decision, d.final_body ?? null
    );
    return Number(r.lastInsertRowid);
  }

  function listDecisions() {
    return db.prepare('SELECT * FROM decisions ORDER BY id').all();
  }

  function listOpenEscalations() {
    return db.prepare("SELECT * FROM escalations WHERE status = 'open' ORDER BY id").all();
  }

  function getEscalationBySlackTs(ts) {
    return db.prepare('SELECT * FROM escalations WHERE slack_ts = ?').get(ts);
  }

  function resolveEscalation(id, { status, resolved_text = null }) {
    db.prepare(`
      UPDATE escalations
      SET status = ?, resolved_text = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(status, resolved_text, id);
  }

  function close() {
    db.close();
  }

  return {
    raw: db,
    migrate,
    createConversation,
    getConversation,
    listConversationsByState,
    listAllConversations,
    listConversationsDueForInitialSend,
    updateConversationState,
    recordMessage,
    listMessages,
    hasGmailMessageId,
    recordAttachment,
    recordEscalation,
    listOpenEscalations,
    getEscalationBySlackTs,
    resolveEscalation,
    recordDecision,
    listDecisions,
    close,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storage.test.js`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/storage.js tests/storage.test.js
git commit -m "feat(pilot): SQLite storage layer for conversations + messages + escalations"
```

---

## Task 6: Conversation state machine

**Files:**
- Create: `src/conversation.js`
- Create: `tests/conversation.test.js`

Pure function `nextActionForState(state, classification)` → `{ nextState, action }` where `action` ∈ `{ send_precision, send_receipt, none, escalate, mark_done }`. Plus a helper `staleAction(state, daysInState, followupCount)` for the daily follow-up tick.

- [ ] **Step 1: Write the failing test**

Create `tests/conversation.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { nextActionForClassification, staleAction } from '../src/conversation.js';

describe('nextActionForClassification', () => {
  it('SENT + auto_ack → ACK_RECEIVED, no outbound', () => {
    const r = nextActionForClassification('SENT', 'auto_ack');
    expect(r.nextState).toBe('ACK_RECEIVED');
    expect(r.action).toBe('none');
  });

  it('SENT + clarification → AWAITING_PRECISION, send_precision', () => {
    const r = nextActionForClassification('SENT', 'clarification');
    expect(r.nextState).toBe('AWAITING_PRECISION');
    expect(r.action).toBe('send_precision');
  });

  it('ACK_RECEIVED + clarification → AWAITING_PRECISION', () => {
    const r = nextActionForClassification('ACK_RECEIVED', 'clarification');
    expect(r.nextState).toBe('AWAITING_PRECISION');
    expect(r.action).toBe('send_precision');
  });

  it('ACK_RECEIVED + delivery → DELIVERING, send_receipt (first delivery)', () => {
    const r = nextActionForClassification('ACK_RECEIVED', 'delivery', { receipt_sent: 0 });
    expect(r.nextState).toBe('DELIVERING');
    expect(r.action).toBe('send_receipt');
  });

  it('DELIVERING + delivery → DELIVERING, none (no second receipt)', () => {
    const r = nextActionForClassification('DELIVERING', 'delivery', { receipt_sent: 1 });
    expect(r.nextState).toBe('DELIVERING');
    expect(r.action).toBe('none');
  });

  it('any state + dead_end → DEAD_END (terminal), none', () => {
    for (const state of ['SENT', 'ACK_RECEIVED', 'AWAITING_PRECISION', 'DELIVERING']) {
      const r = nextActionForClassification(state, 'dead_end');
      expect(r.nextState).toBe('DEAD_END');
      expect(r.action).toBe('none');
    }
  });

  it('DELIVERING + dead_end ("samtliga avtal" closer) → DONE', () => {
    const r = nextActionForClassification('DELIVERING', 'dead_end', { is_closer: true });
    expect(r.nextState).toBe('DONE');
    expect(r.action).toBe('none');
  });

  it('any state + unknown → NEEDS_HUMAN, escalate', () => {
    const r = nextActionForClassification('SENT', 'unknown');
    expect(r.nextState).toBe('NEEDS_HUMAN');
    expect(r.action).toBe('escalate');
  });
});

describe('staleAction', () => {
  it('SENT for ≥7 days → send_followup_nudge (1st)', () => {
    expect(staleAction('SENT', 7, 0)).toBe('send_followup_nudge');
  });

  it('SENT for 6 days → none', () => {
    expect(staleAction('SENT', 6, 0)).toBe('none');
  });

  it('ACK_RECEIVED for ≥14 days → send_followup_nudge', () => {
    expect(staleAction('ACK_RECEIVED', 14, 0)).toBe('send_followup_nudge');
    expect(staleAction('ACK_RECEIVED', 13, 0)).toBe('none');
  });

  it('AWAITING_PRECISION for ≥10 days → send_followup_nudge', () => {
    expect(staleAction('AWAITING_PRECISION', 10, 0)).toBe('send_followup_nudge');
  });

  it('DELIVERING for ≥14 days → send_followup_close', () => {
    expect(staleAction('DELIVERING', 14, 0)).toBe('send_followup_close');
  });

  it('escalates to NEEDS_HUMAN after 2 nudges', () => {
    expect(staleAction('SENT', 30, 2)).toBe('escalate');
  });

  it('terminal states never produce action', () => {
    expect(staleAction('DONE', 365, 0)).toBe('none');
    expect(staleAction('DEAD_END', 365, 0)).toBe('none');
    expect(staleAction('NEEDS_HUMAN', 365, 0)).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/conversation.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/conversation.js**

```js
export function nextActionForClassification(state, classification, opts = {}) {
  if (classification === 'unknown') {
    return { nextState: 'NEEDS_HUMAN', action: 'escalate' };
  }

  if (classification === 'dead_end') {
    if (state === 'DELIVERING' && opts.is_closer) {
      return { nextState: 'DONE', action: 'none' };
    }
    return { nextState: 'DEAD_END', action: 'none' };
  }

  if (classification === 'auto_ack') {
    if (state === 'SENT' || state === 'AWAITING_PRECISION') {
      return { nextState: 'ACK_RECEIVED', action: 'none' };
    }
    return { nextState: state, action: 'none' };
  }

  if (classification === 'clarification') {
    if (state === 'SENT' || state === 'ACK_RECEIVED' || state === 'AWAITING_PRECISION') {
      return { nextState: 'AWAITING_PRECISION', action: 'send_precision' };
    }
    return { nextState: state, action: 'none' };
  }

  if (classification === 'delivery') {
    const action = opts.receipt_sent ? 'none' : 'send_receipt';
    return { nextState: 'DELIVERING', action };
  }

  return { nextState: state, action: 'none' };
}

const STALE_RULES = {
  SENT: { days: 7, action: 'send_followup_nudge' },
  ACK_RECEIVED: { days: 14, action: 'send_followup_nudge' },
  AWAITING_PRECISION: { days: 10, action: 'send_followup_nudge' },
  DELIVERING: { days: 14, action: 'send_followup_close' },
};

const MAX_NUDGES = 2;
const TERMINAL = new Set(['DONE', 'DEAD_END', 'NEEDS_HUMAN']);

export function staleAction(state, daysInState, followupCount) {
  if (TERMINAL.has(state)) return 'none';
  const rule = STALE_RULES[state];
  if (!rule) return 'none';
  if (daysInState < rule.days) return 'none';
  if (followupCount >= MAX_NUDGES && rule.action === 'send_followup_nudge') return 'escalate';
  return rule.action;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/conversation.test.js`
Expected: 15 passed.

- [ ] **Step 5: Commit**

```bash
git add src/conversation.js tests/conversation.test.js
git commit -m "feat(pilot): conversation FSM (classification + staleness rules)"
```

---

## Task 7: Attachment storage

**Files:**
- Create: `src/attachments.js`
- Create: `tests/attachments.test.js`

`saveAttachment(buffer, metadata, { baseDir })` → `{ saved_path }`. Sidecar JSON written next to PDF. Filenames sanitized.

- [ ] **Step 1: Write the failing test**

Create `tests/attachments.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveAttachment, safeFilename } from '../src/attachments.js';

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'pilot-att-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('safeFilename', () => {
  it('strips path separators and special chars', () => {
    expect(safeFilename('../../../etc/passwd')).toBe('etc_passwd');
    expect(safeFilename('My Avtal (slutligt).pdf')).toBe('My_Avtal_slutligt_.pdf');
  });

  it('truncates very long names', () => {
    const long = 'a'.repeat(300) + '.pdf';
    expect(safeFilename(long).length).toBeLessThanOrEqual(120);
  });
});

describe('saveAttachment', () => {
  it('saves the file and writes a .meta.json sidecar', async () => {
    const metadata = {
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      role: 'utbildning',
      received_at: '2026-05-19T10:00:00Z',
      from_email: 'a@x.se',
      from_name: 'Registrator',
      gmail_message_id: 'msg-1',
      gmail_thread_id: 'thr-1',
      subject: 'Re: Begäran',
      original_filename: 'avtal Skolon.pdf',
      mime_type: 'application/pdf',
    };
    const result = await saveAttachment(Buffer.from('%PDF-1.4 fake'), metadata, { baseDir: tmp });
    expect(existsSync(result.saved_path)).toBe(true);
    const meta = JSON.parse(readFileSync(result.saved_path + '.meta.json', 'utf8'));
    expect(meta.kommun_kod).toBe('9999');
    expect(meta.original_filename).toBe('avtal Skolon.pdf');
    expect(result.saved_path).toContain('9999');
    expect(result.saved_path).toContain('avtal_Skolon.pdf');
  });

  it('creates the kommun directory if missing', async () => {
    const result = await saveAttachment(Buffer.from('x'), {
      kommun_kod: '2418',
      kommun_namn: 'Malå',
      role: 'central',
      received_at: '2026-05-19T10:00:00Z',
      from_email: 'a@x.se',
      gmail_message_id: 'mX',
      gmail_thread_id: 'tX',
      subject: 's',
      original_filename: 'doc.pdf',
      mime_type: 'application/pdf',
    }, { baseDir: tmp });
    expect(existsSync(join(tmp, '2418'))).toBe(true);
    expect(existsSync(result.saved_path)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/attachments.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/attachments.js**

```js
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function safeFilename(name) {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const sanitized = base.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (sanitized.length <= 120) return sanitized;
  const dot = sanitized.lastIndexOf('.');
  if (dot === -1) return sanitized.slice(0, 120);
  const ext = sanitized.slice(dot);
  return sanitized.slice(0, 120 - ext.length) + ext;
}

export async function saveAttachment(buffer, metadata, { baseDir }) {
  const dir = join(baseDir, metadata.kommun_kod);
  mkdirSync(dir, { recursive: true });
  const date = metadata.received_at.slice(0, 10);
  const safeName = safeFilename(metadata.original_filename);
  const filename = `${date}__${metadata.gmail_message_id}__${safeName}`;
  const savedPath = join(dir, filename);
  writeFileSync(savedPath, buffer);

  const meta = {
    kommun_kod: metadata.kommun_kod,
    kommun_namn: metadata.kommun_namn,
    role: metadata.role,
    received_at: metadata.received_at,
    from_email: metadata.from_email,
    from_name: metadata.from_name ?? null,
    gmail_message_id: metadata.gmail_message_id,
    gmail_thread_id: metadata.gmail_thread_id,
    subject: metadata.subject,
    original_filename: metadata.original_filename,
    mime_type: metadata.mime_type,
    size_bytes: buffer.length,
  };
  writeFileSync(savedPath + '.meta.json', JSON.stringify(meta, null, 2));

  return { saved_path: savedPath, size_bytes: buffer.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/attachments.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/attachments.js tests/attachments.test.js
git commit -m "feat(pilot): attachment storage with metadata sidecar"
```

---

## Task 8: Gmail client wrapper

**Files:**
- Create: `src/gmail.js`
- Create: `tests/gmail.test.js`

Wraps `googleapis` with a dependency-injected client so tests can mock it. Exposes: `buildOAuthClient(env)`, `loadStoredToken(path)`, `saveToken(path, tokens)`, `makeGmail(authClient)`, plus operations: `sendMessage(gmail, {to, subject, body, threadId?, inReplyTo?, references?})`, `listInboundSince(gmail, { historyId? })`, `getMessage(gmail, id)`, `fetchAttachment(gmail, messageId, attachmentId)`, `ensureLabel(gmail, name)`, `addLabel(gmail, messageId, labelId)`.

- [ ] **Step 1: Write the failing test**

Create `tests/gmail.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import {
  buildMimeMessage,
  parseInboundMessage,
  parseBase64Url,
} from '../src/gmail.js';

describe('buildMimeMessage', () => {
  it('produces a base64url-encoded RFC 822 message with required headers', () => {
    const raw = buildMimeMessage({
      from: 'Gustaf <gustaf@mediagraf.se>',
      to: 'registrator@kommun.se',
      subject: 'Begäran',
      body: 'Hej!\n\nText\n',
    });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toMatch(/^From: Gustaf <gustaf@mediagraf.se>/m);
    expect(decoded).toMatch(/^To: registrator@kommun.se/m);
    expect(decoded).toMatch(/^Subject: =\?UTF-8\?B\?/m); // base64 subject for åäö-safety
    expect(decoded).toMatch(/^Content-Type: text\/plain; charset="UTF-8"/m);
  });

  it('adds threading headers when provided', () => {
    const raw = buildMimeMessage({
      from: 'a@b.se', to: 'c@d.se', subject: 'Re: X', body: 'Y',
      inReplyTo: '<msg1@gmail.com>',
      references: '<msg0@gmail.com> <msg1@gmail.com>',
    });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toMatch(/^In-Reply-To: <msg1@gmail.com>/m);
    expect(decoded).toMatch(/^References: <msg0@gmail.com> <msg1@gmail.com>/m);
  });
});

describe('parseInboundMessage', () => {
  it('extracts plain text body from a Gmail message payload', () => {
    const payload = {
      id: 'm1',
      threadId: 't1',
      payload: {
        headers: [
          { name: 'From', value: 'Mikaela <m@vasteras.se>' },
          { name: 'To', value: 'gustaf@mediagraf.se' },
          { name: 'Subject', value: 'Re: Begäran' },
          { name: 'Date', value: 'Mon, 19 May 2026 10:00:00 +0200' },
        ],
        mimeType: 'text/plain',
        body: { data: parseBase64Url.encode('Hej Gustaf,\n\nPrecisera tack.\n') },
      },
    };
    const parsed = parseInboundMessage(payload);
    expect(parsed.from).toBe('Mikaela <m@vasteras.se>');
    expect(parsed.subject).toBe('Re: Begäran');
    expect(parsed.body).toContain('Precisera tack');
    expect(parsed.attachments).toEqual([]);
  });

  it('extracts attachments from a multipart message', () => {
    const payload = {
      id: 'm2',
      threadId: 't2',
      payload: {
        headers: [
          { name: 'From', value: 'm@vasteras.se' },
          { name: 'To', value: 'gustaf@mediagraf.se' },
          { name: 'Subject', value: 'Re: Begäran' },
          { name: 'Date', value: 'Mon, 19 May 2026 10:00:00 +0200' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: parseBase64Url.encode('Här kommer avtalet bifogat.') } },
          { mimeType: 'application/pdf', filename: 'avtal.pdf', body: { attachmentId: 'att-1', size: 1024 } },
        ],
      },
    };
    const parsed = parseInboundMessage(payload);
    expect(parsed.body).toContain('Här kommer avtalet');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: 'avtal.pdf', mime_type: 'application/pdf', attachment_id: 'att-1', size_bytes: 1024 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmail.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/gmail.js**

```js
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const parseBase64Url = {
  decode(s) {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  },
  encode(s) {
    return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
};

function encodeSubject(s) {
  // RFC 2047 base64-encode the subject so åäö survive
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export function buildMimeMessage({ from, to, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('', body);
  const raw = lines.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function headerValue(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function walkParts(payload, plainOut, attsOut) {
  if (!payload) return;
  if (payload.parts) {
    for (const p of payload.parts) walkParts(p, plainOut, attsOut);
    return;
  }
  if (payload.filename && payload.body?.attachmentId) {
    attsOut.push({
      filename: payload.filename,
      mime_type: payload.mimeType,
      attachment_id: payload.body.attachmentId,
      size_bytes: payload.body.size ?? 0,
    });
    return;
  }
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    plainOut.push(parseBase64Url.decode(payload.body.data));
  }
}

export function parseInboundMessage(message) {
  const headers = message.payload?.headers ?? [];
  const plain = [];
  const attachments = [];
  walkParts(message.payload, plain, attachments);
  return {
    gmail_message_id: message.id,
    gmail_thread_id: message.threadId,
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    message_id_header: headerValue(headers, 'Message-Id'),
    in_reply_to: headerValue(headers, 'In-Reply-To'),
    references: headerValue(headers, 'References'),
    body: plain.join('\n'),
    attachments,
  };
}

export function buildOAuthClient(env) {
  const oauth2Client = new google.auth.OAuth2(
    env.GMAIL_OAUTH_CLIENT_ID,
    env.GMAIL_OAUTH_CLIENT_SECRET,
    env.GMAIL_OAUTH_REDIRECT_URI
  );
  return oauth2Client;
}

export function loadStoredToken(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveToken(path, tokens) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2));
}

export function makeGmail(authClient) {
  return google.gmail({ version: 'v1', auth: authClient });
}

export async function sendMessage(gmail, opts) {
  const raw = buildMimeMessage(opts);
  const params = { userId: 'me', requestBody: { raw } };
  if (opts.threadId) params.requestBody.threadId = opts.threadId;
  const res = await gmail.users.messages.send(params);
  return { id: res.data.id, threadId: res.data.threadId };
}

export async function listInboundQuery(gmail, query) {
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100 });
  return res.data.messages ?? [];
}

export async function getMessage(gmail, id) {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  return res.data;
}

export async function fetchAttachment(gmail, messageId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  const data = res.data.data;
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export async function ensureLabel(gmail, name) {
  const list = await gmail.users.labels.list({ userId: 'me' });
  const existing = list.data.labels?.find((l) => l.name === name);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name } });
  return created.data.id;
}

export async function addLabel(gmail, messageId, labelId) {
  await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: [labelId] } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gmail.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/gmail.js tests/gmail.test.js
git commit -m "feat(pilot): gmail client wrapper with MIME builder + payload parser"
```

---

## Task 9: Slack client

**Files:**
- Create: `src/slack.js`
- Create: `tests/slack.test.js`

Two responsibilities: (a) post an escalation message with Approve / Edit / Skip buttons to a channel via Web API; (b) verify the Slack signing-secret HMAC on incoming interactivity webhooks and parse the payload.

Uses `@slack/bolt`'s underlying primitives (`WebClient` for posting, manual signature verification for the webhook — cheaper than booting the full Bolt app).

- [ ] **Step 1: Write the failing test**

Create `tests/slack.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  buildEscalationBlocks,
  verifySlackSignature,
  parseInteractivityPayload,
} from '../src/slack.js';
import crypto from 'node:crypto';

describe('buildEscalationBlocks', () => {
  it('produces Block Kit JSON with Approve/Edit/Skip buttons', () => {
    const blocks = buildEscalationBlocks({
      escalation_id: 42,
      kommun_namn: 'Testkommun',
      from_email: 'gustaf.hard@gmail.com',
      reply_text: 'Hej, kan du ringa mig?',
      draft_reply: 'Hej, jag föredrar e-post.',
      gmail_thread_id: 'thr-1',
    });
    expect(Array.isArray(blocks)).toBe(true);
    const buttonBlock = blocks.find((b) => b.type === 'actions');
    expect(buttonBlock.elements).toHaveLength(3);
    expect(buttonBlock.elements.map((e) => e.action_id)).toEqual(['esc_approve', 'esc_edit', 'esc_skip']);
    for (const e of buttonBlock.elements) {
      expect(e.value).toBe('42');
    }
  });
});

describe('verifySlackSignature', () => {
  it('accepts a correctly signed request', () => {
    const secret = 'shh';
    const ts = String(Math.floor(Date.now() / 1000));
    const body = 'payload=%7B%22foo%22%3A1%7D';
    const sigBase = `v0:${ts}:${body}`;
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, body, signature: sig })).toBe(true);
  });

  it('rejects a bad signature', () => {
    const secret = 'shh';
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, body: 'x', signature: 'v0=bad' })).toBe(false);
  });

  it('rejects stale timestamps (>5 min)', () => {
    const secret = 'shh';
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const body = 'x';
    const sigBase = `v0:${ts}:${body}`;
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, body, signature: sig })).toBe(false);
  });
});

describe('parseInteractivityPayload', () => {
  it('extracts action_id, value, and trigger_id from form-encoded payload', () => {
    const payload = {
      actions: [{ action_id: 'esc_approve', value: '42' }],
      trigger_id: 'trig-1',
      user: { id: 'U1', name: 'gustaf' },
      message: { ts: '1234.5678' },
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const parsed = parseInteractivityPayload(body);
    expect(parsed.action_id).toBe('esc_approve');
    expect(parsed.escalation_id).toBe('42');
    expect(parsed.trigger_id).toBe('trig-1');
    expect(parsed.message_ts).toBe('1234.5678');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/slack.js**

```js
import { WebClient } from '@slack/web-api';
import crypto from 'node:crypto';

export function makeSlackClient(token) {
  return new WebClient(token);
}

export function buildEscalationBlocks({ escalation_id, kommun_namn, from_email, reply_text, draft_reply, gmail_thread_id }) {
  const idStr = String(escalation_id);
  return [
    { type: 'header', text: { type: 'plain_text', text: `Eskalering: ${kommun_namn}` } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Från:*\n${from_email}` },
        { type: 'mrkdwn', text: `*Tråd:*\n${gmail_thread_id}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*Inkommande:*\n>${reply_text.replace(/\n/g, '\n>').slice(0, 1500)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Förslag på svar:*\n>${(draft_reply ?? '(ingen draft)').replace(/\n/g, '\n>').slice(0, 1500)}` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'esc_approve', value: idStr, text: { type: 'plain_text', text: 'Approve' }, style: 'primary' },
        { type: 'button', action_id: 'esc_edit', value: idStr, text: { type: 'plain_text', text: 'Edit' } },
        { type: 'button', action_id: 'esc_skip', value: idStr, text: { type: 'plain_text', text: 'Skip' }, style: 'danger' },
      ],
    },
  ];
}

export async function postEscalation(slack, { channel, blocks, fallbackText }) {
  const res = await slack.chat.postMessage({ channel, blocks, text: fallbackText ?? 'Eskalering' });
  return { ts: res.ts, channel: res.channel };
}

export async function openEditModal(slack, { trigger_id, escalation_id, draft_reply }) {
  await slack.views.open({
    trigger_id,
    view: {
      type: 'modal',
      callback_id: 'esc_edit_modal',
      private_metadata: String(escalation_id),
      title: { type: 'plain_text', text: 'Redigera svar' },
      submit: { type: 'plain_text', text: 'Skicka' },
      close: { type: 'plain_text', text: 'Avbryt' },
      blocks: [
        {
          type: 'input',
          block_id: 'reply_input',
          label: { type: 'plain_text', text: 'Svarstext' },
          element: { type: 'plain_text_input', action_id: 'reply_text', multiline: true, initial_value: draft_reply ?? '' },
        },
      ],
    },
  });
}

export function verifySlackSignature({ signingSecret, timestamp, body, signature, maxSkewSeconds = 300 }) {
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > maxSkewSeconds) return false;
  const sigBase = `v0:${timestamp}:${body}`;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBase).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function parseInteractivityPayload(rawBody) {
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get('payload');
  if (!payloadStr) throw new Error('No payload in interactivity body');
  const payload = JSON.parse(payloadStr);
  const action = payload.actions?.[0];
  return {
    type: payload.type,
    action_id: action?.action_id,
    escalation_id: action?.value,
    trigger_id: payload.trigger_id,
    user_id: payload.user?.id,
    user_name: payload.user?.name,
    message_ts: payload.message?.ts,
    view: payload.view,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack.test.js`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/slack.js tests/slack.test.js
git commit -m "feat(pilot): slack client (escalation blocks, signature verification, payload parser)"
```

---

## Task 10: Tick orchestrator

**Files:**
- Create: `src/tick.js`
- Create: `tests/tick.test.js`

Pure-ish function `runTick({ db, gmail, slack, templates, classifier, attachments, now, env, log })` — given DI'd clients, does one tick: send any due initial mails, fetch new inbound messages, classify, transition state, take action, escalate.

This is the heart of the system. Tests use mocked Gmail / Slack / fs.

- [ ] **Step 1: Write the failing test**

Create `tests/tick.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runTick } from '../src/tick.js';

let tmp, db, baseDir, contractsDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-tick-'));
  baseDir = tmp;
  contractsDir = join(tmp, 'contracts');
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function fakeGmail(opts = {}) {
  return {
    sendCalls: [],
    listResult: opts.listResult ?? [],
    getResult: opts.getResult ?? {},
    sendMessage: vi.fn(async function (gmail, msg) {
      this.sendCalls.push(msg);
      return { id: `out-${this.sendCalls.length}`, threadId: msg.threadId ?? `thr-${this.sendCalls.length}` };
    }),
    listInboundQuery: vi.fn(async () => opts.listResult ?? []),
    getMessage: vi.fn(async (gmail, id) => opts.getResult?.[id] ?? null),
    fetchAttachment: vi.fn(async () => Buffer.from('%PDF-1.4')),
  };
}

function fakeSlack() {
  return {
    posts: [],
    postEscalation: vi.fn(async function (slack, { blocks }) {
      this.posts.push({ blocks });
      return { ts: `slack-${this.posts.length}`, channel: 'C1' };
    }),
  };
}

const env = {
  GMAIL_USER_EMAIL: 'gustaf@mediagraf.se',
  GMAIL_FROM_NAME: 'Gustaf',
  GMAIL_LABEL_PREFIX: 'mediagraf/pilot',
  SLACK_CHANNEL_ID: 'C1',
};

describe('runTick — initial dispatch', () => {
  it('sends T-INITIAL to conversations whose scheduled_send_at <= now and state=INITIAL', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    const gmail = fakeGmail();
    const slack = fakeSlack();
    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T10:00:00Z'),
    });
    expect(gmail.sendCalls).toHaveLength(1);
    expect(gmail.sendCalls[0].to).toBe('gustaf.hard@gmail.com');
    expect(gmail.sendCalls[0].subject).toMatch(/Begäran om allmänna handlingar/);
    expect(db.getConversation(id).state).toBe('SENT');
  });

  it('does not send before scheduled_send_at', async () => {
    db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'central',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-20T09:00:00Z',
    });
    const gmail = fakeGmail();
    const slack = fakeSlack();
    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T10:00:00Z'),
    });
    expect(gmail.sendCalls).toHaveLength(0);
  });
});

describe('runTick — inbound processing', () => {
  it('classifies auto_ack and transitions SENT → ACK_RECEIVED without outbound', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-X', last_outbound_at: '2026-05-19T10:00:00Z' });

    const gmail = fakeGmail({
      listResult: [{ id: 'in-1' }],
      getResult: {
        'in-1': {
          id: 'in-1', threadId: 'thr-X',
          payload: {
            headers: [
              { name: 'From', value: 'a@x.se' },
              { name: 'To', value: 'gustaf@mediagraf.se' },
              { name: 'Subject', value: 'Re: Begäran' },
              { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Ärendenummer: K9999001').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
          },
        },
      },
    });
    const slack = fakeSlack();

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T11:00:00Z'),
    });

    const conv = db.getConversation(id);
    expect(conv.state).toBe('ACK_RECEIVED');
    expect(conv.arendenummer).toBe('K9999001');
    expect(gmail.sendCalls).toHaveLength(0);
  });

  it('classifies clarification and posts T-PRECISION DRAFT to Slack (no autosend)', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'ACK_RECEIVED', { gmail_thread_id: 'thr-Y', last_outbound_at: '2026-05-19T10:00:00Z' });

    const gmail = fakeGmail({
      listResult: [{ id: 'in-2' }],
      getResult: {
        'in-2': {
          id: 'in-2', threadId: 'thr-Y',
          payload: {
            headers: [
              { name: 'From', value: 'a@x.se' }, { name: 'To', value: 'gustaf@mediagraf.se' },
              { name: 'Subject', value: 'Re: Begäran' }, { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
              { name: 'Message-Id', value: '<msg-2@x.se>' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Kan du precisera din begäran?').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
          },
        },
      },
    });
    const slack = fakeSlack();

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T11:00:00Z'),
    });

    // No autosend in v1 — only T-INITIAL ships without approval
    expect(gmail.sendCalls).toHaveLength(0);
    // Slack post with T-PRECISION draft for human approval
    expect(slack.posts).toHaveLength(1);
    const esc = db.listOpenEscalations()[0];
    expect(esc.draft_template).toBe('T_PRECISION');
    expect(esc.draft_body).toMatch(/preciserar gärna/);
    // State transition still happens automatically (bookkeeping)
    expect(db.getConversation(id).state).toBe('AWAITING_PRECISION');
  });

  it('classifies unknown and escalates to Slack without outbound', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'central',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-Z', last_outbound_at: '2026-05-19T10:00:00Z' });

    const gmail = fakeGmail({
      listResult: [{ id: 'in-3' }],
      getResult: {
        'in-3': {
          id: 'in-3', threadId: 'thr-Z',
          payload: {
            headers: [
              { name: 'From', value: 'a@x.se' }, { name: 'To', value: 'gustaf@mediagraf.se' },
              { name: 'Subject', value: 'Re: Begäran' }, { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Hej, kan du ringa mig?').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
          },
        },
      },
    });
    const slack = fakeSlack();

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T11:00:00Z'),
    });

    expect(gmail.sendCalls).toHaveLength(0);
    expect(slack.posts).toHaveLength(1);
    expect(db.getConversation(id).state).toBe('NEEDS_HUMAN');
    const escs = db.listOpenEscalations();
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('free_form');
  });

  it('does not re-process a message it already saw', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-X', last_outbound_at: '2026-05-19T10:00:00Z' });

    const list = [{ id: 'in-dup' }];
    const getResult = {
      'in-dup': {
        id: 'in-dup', threadId: 'thr-X',
        payload: {
          headers: [
            { name: 'From', value: 'a@x.se' }, { name: 'To', value: 'gustaf@mediagraf.se' },
            { name: 'Subject', value: 'Re: Begäran' }, { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
          ],
          mimeType: 'text/plain',
          body: { data: Buffer.from('Ärendenummer: K9999001').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
        },
      },
    };
    const gmail = fakeGmail({ listResult: list, getResult });
    const slack = fakeSlack();
    const args = {
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T11:00:00Z'),
    };
    await runTick(args);
    await runTick(args);
    expect(gmail.getMessage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tick.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/tick.js**

> **Design note (v1 approval-first):** every outbound *except T-INITIAL* is drafted by the bot and posted to Slack for the human to approve. There is no autosend path for T-PRECISION / T-RECEIPT / T-FOLLOWUP-NUDGE / T-FOLLOWUP-CLOSE in v1. State transitions still happen automatically based on classifier output — those are bookkeeping and reversible. Only outbound communication is gated.

```js
import { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE } from './templates.js';
import { classify } from './classifier.js';
import { nextActionForClassification, staleAction } from './conversation.js';
import { parseInboundMessage } from './gmail.js';
import { buildEscalationBlocks } from './slack.js';
import { saveAttachment } from './attachments.js';

const TEMPLATES = { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE };

function fromHeader(env) {
  return `${env.GMAIL_FROM_NAME} <${env.GMAIL_USER_EMAIL}>`;
}

function tplCtx(conv, env, extra = {}) {
  return {
    kommun_namn: conv.kommun_namn,
    role: conv.role,
    from_email: env.GMAIL_USER_EMAIL,
    from_name: env.GMAIL_FROM_NAME,
    thread_subject: extra.thread_subject ?? 'Begäran om allmänna handlingar – avtal för digitala verktyg',
    days_since_send: extra.days_since_send ?? 0,
  };
}

async function dispatchInitial(conv, { db, gmailClient, gmailOps, env, now, log }) {
  const ctx = tplCtx(conv, env);
  const msg = T_INITIAL(ctx);
  const sent = await gmailOps.sendMessage(gmailClient.gmail, {
    from: fromHeader(env), to: conv.contact_email, subject: msg.subject, body: msg.body,
  });
  db.updateConversationState(conv.id, 'SENT', {
    gmail_thread_id: sent.threadId,
    last_outbound_at: now.toISOString(),
  });
  db.recordMessage({
    conversation_id: conv.id, gmail_message_id: sent.id, direction: 'outbound',
    from_email: env.GMAIL_USER_EMAIL, to_email: conv.contact_email,
    subject: msg.subject, body_text: msg.body,
    classification: null, classification_confidence: null,
    received_at: now.toISOString(), attachment_count: 0,
  });
  log?.(`SENT T-INITIAL → ${conv.kommun_namn}/${conv.role}`);
}

async function escalateWithDraft({ conv, parsedInbound, classification, draftTemplate, reason, deps }) {
  const { db, slackClient, slackOps, env, log } = deps;
  let subject = '(no subject)';
  let body = '';
  if (draftTemplate === 'free_form') {
    const baseSubject = parsedInbound?.subject?.replace(/^Re: /, '') ?? 'Begäran om allmänna handlingar';
    subject = `Re: ${baseSubject}`;
    body = '(ingen draft — skriv själv via Edit)';
  } else if (TEMPLATES[draftTemplate]) {
    const ctx = tplCtx(conv, env, {
      thread_subject: parsedInbound?.subject?.replace(/^Re: /, '') ?? undefined,
      days_since_send: deps.daysSinceSend ?? 0,
    });
    const rendered = TEMPLATES[draftTemplate](ctx);
    subject = rendered.subject;
    body = rendered.body;
  }

  const escId = db.recordEscalation({
    conversation_id: conv.id,
    message_id: null,
    reason,
    draft_template: draftTemplate,
    draft_subject: subject,
    draft_body: body,
  });

  if (slackOps && env.SLACK_CHANNEL_ID) {
    const blocks = buildEscalationBlocks({
      escalation_id: escId,
      kommun_namn: conv.kommun_namn,
      from_email: parsedInbound?.from ?? '(no inbound — proactive draft)',
      reply_text: parsedInbound?.body ?? '(no inbound)',
      draft_reply: `Subject: ${subject}\n\n${body}`,
      gmail_thread_id: conv.gmail_thread_id ?? '(no thread)',
    });
    const posted = await slackOps.postEscalation(slackClient, {
      channel: env.SLACK_CHANNEL_ID,
      blocks,
      fallbackText: `Eskalering: ${conv.kommun_namn} (${draftTemplate})`,
    });
    db.raw.prepare('UPDATE escalations SET slack_ts = ? WHERE id = ?').run(posted.ts, escId);
  }
  log?.(`ESCALATED (${draftTemplate}) → ${conv.kommun_namn}/${conv.role}: ${reason}`);
  return escId;
}

export async function runTick(deps) {
  const { db, gmailClient, gmailOps, env, now } = deps;

  // 1. Initial dispatch — anything scheduled for now or earlier
  const dueInitial = db.listConversationsDueForInitialSend(now.toISOString());
  for (const conv of dueInitial) {
    await dispatchInitial(conv, deps);
  }

  // 2. Inbound processing — fetch new messages on tracked threads
  const active = db.listAllConversations().filter((c) => c.gmail_thread_id);
  for (const conv of active) {
    const list = await gmailOps.listInboundQuery(gmailClient.gmail, `to:${env.GMAIL_USER_EMAIL} -from:${env.GMAIL_USER_EMAIL} newer_than:7d`);
    for (const m of list) {
      if (db.hasGmailMessageId(m.id)) continue;
      // we can't know thread without fetching, so fetch then filter
      const full = await gmailOps.getMessage(gmailClient.gmail, m.id);
      if (!full || full.threadId !== conv.gmail_thread_id) continue;
      // we already fetched, so process inline rather than calling processInboundForConversation (which would re-fetch)
      const parsed = parseInboundMessage(full);
      const classification = classify({
        from: parsed.from, subject: parsed.subject, body: parsed.body,
        attachment_count: parsed.attachments.length,
      });
      const isCloser = /samtliga avtal/i.test(parsed.body);
      const transition = nextActionForClassification(conv.state, classification.class, {
        receipt_sent: !!conv.receipt_sent, is_closer: isCloser,
      });
      const messageId = db.recordMessage({
        conversation_id: conv.id, gmail_message_id: m.id, direction: 'inbound',
        from_email: parsed.from, to_email: parsed.to,
        subject: parsed.subject, body_text: parsed.body,
        classification: classification.class, classification_confidence: classification.confidence,
        received_at: now.toISOString(), attachment_count: parsed.attachments.length,
      });
      for (const att of parsed.attachments) {
        if (att.mime_type !== 'application/pdf' && !att.filename?.toLowerCase().endsWith('.pdf')) continue;
        const buf = await gmailOps.fetchAttachment(gmailClient.gmail, m.id, att.attachment_id);
        const saved = await saveAttachment(buf, {
          kommun_kod: conv.kommun_kod, kommun_namn: conv.kommun_namn, role: conv.role,
          received_at: now.toISOString(), from_email: parsed.from, from_name: null,
          gmail_message_id: m.id, gmail_thread_id: parsed.gmail_thread_id,
          subject: parsed.subject, original_filename: att.filename, mime_type: att.mime_type,
        }, { baseDir: deps.contractsDir });
        db.recordAttachment({ message_id: messageId, filename: att.filename, saved_path: saved.saved_path, mime_type: att.mime_type, size_bytes: saved.size_bytes });
      }
      // State transition is bookkeeping — happens automatically. Outbound is gated.
      const patch = {};
      if (classification.extracted?.arendenummer) patch.arendenummer = classification.extracted.arendenummer;
      db.updateConversationState(conv.id, transition.nextState, patch);
      const updated = db.getConversation(conv.id);

      // Outbound: never auto-sent in v1. Draft a template and escalate to Slack.
      let draftTemplate = null;
      if (transition.action === 'send_precision') draftTemplate = 'T_PRECISION';
      else if (transition.action === 'send_receipt' && !updated.receipt_sent) draftTemplate = 'T_RECEIPT';
      else if (transition.action === 'escalate') draftTemplate = 'free_form';

      if (draftTemplate) {
        await escalateWithDraft({
          conv: updated, parsedInbound: parsed, classification,
          draftTemplate,
          reason: `classifier=${classification.class} confidence=${classification.confidence.toFixed(2)}`,
          deps,
        });
      }
    }
  }
}

export async function runDailyFollowup(deps) {
  const { db, now, log } = deps;
  const all = db.listAllConversations();
  for (const conv of all) {
    const days = daysBetween(new Date(conv.state_changed_at), now);
    const action = staleAction(conv.state, days, conv.followup_count);
    if (action === 'none') continue;

    let draftTemplate = null;
    let reason = `stale ${conv.state} for ${days} days`;
    if (action === 'send_followup_nudge') draftTemplate = 'T_FOLLOWUP_NUDGE';
    else if (action === 'send_followup_close') draftTemplate = 'T_FOLLOWUP_CLOSE';
    else if (action === 'escalate') {
      reason = `stale ${conv.state} for ${days} days, ${conv.followup_count} nudges already sent`;
      draftTemplate = 'free_form';
    }

    if (draftTemplate) {
      await escalateWithDraft({
        conv,
        parsedInbound: null,
        classification: null,
        draftTemplate,
        reason,
        deps: { ...deps, daysSinceSend: days },
      });
      log?.(`FOLLOWUP drafted (${draftTemplate}) → ${conv.kommun_namn}/${conv.role}`);
    }
  }
}

function daysBetween(then, now) {
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}
```

> **Note:** `followup_count` increments only when the human approves the follow-up draft in Slack — that happens in the daemon's interactivity handler (Task 11), not here. Otherwise click-Skip wouldn't reset the count properly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tick.test.js`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/tick.js tests/tick.test.js
git commit -m "feat(pilot): tick orchestrator (initial dispatch + inbound processing + escalation)"
```

---

## Task 11: Daemon process

**Files:**
- Create: `src/daemon.js`
- Create: `scripts/pilot-daemon.js`

The long-running daemon. Schedules `runTick` via `node-cron` at `PILOT_TICK_CRON`, runs `runDailyFollowup` at `PILOT_FOLLOWUP_CRON`, and hosts an Express server on `SLACK_INTERACTIVITY_PORT` that receives Slack button clicks. Not unit-tested (it's glue) — verified manually in Stage 0.

- [ ] **Step 1: Implement src/daemon.js**

```js
import express from 'express';
import cron from 'node-cron';
import { google } from 'googleapis';
import { runTick, runDailyFollowup } from './tick.js';
import { openDb } from './storage.js';
import { buildOAuthClient, loadStoredToken, makeGmail, sendMessage as gmailSend, listInboundQuery, getMessage as gmailGet, fetchAttachment } from './gmail.js';
import { makeSlackClient, verifySlackSignature, parseInteractivityPayload, postEscalation, openEditModal } from './slack.js';
import { loadOverrides, getEffectiveNow } from './pilot-config.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const CONTRACTS_DIR = process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts';

async function sendApprovedReply({ db, gmail, env, conv, esc, finalBody, decision }) {
  const sent = await gmailSend(gmail, {
    from: `${env.GMAIL_FROM_NAME} <${env.GMAIL_USER_EMAIL}>`,
    to: conv.contact_email,
    subject: esc.draft_subject ?? 'Re: Begäran om allmänna handlingar',
    body: finalBody,
    threadId: conv.gmail_thread_id,
  });
  const nowIso = new Date().toISOString();
  db.recordMessage({
    conversation_id: conv.id, gmail_message_id: sent.id, direction: 'outbound',
    from_email: env.GMAIL_USER_EMAIL, to_email: conv.contact_email,
    subject: esc.draft_subject ?? 'Re: Begäran om allmänna handlingar', body_text: finalBody,
    classification: null, classification_confidence: null,
    received_at: nowIso, attachment_count: 0,
  });
  // Side-effects per template type
  const patch = { last_outbound_at: nowIso };
  if (esc.draft_template === 'T_RECEIPT') patch.receipt_sent = 1;
  if (esc.draft_template === 'T_FOLLOWUP_NUDGE' || esc.draft_template === 'T_FOLLOWUP_CLOSE') {
    patch.followup_count = (conv.followup_count ?? 0) + 1;
  }
  db.updateConversationState(conv.id, conv.state, patch);
  db.resolveEscalation(esc.id, { status: decision === 'edit' ? 'resolved_edit' : 'resolved_send', resolved_text: finalBody });
  db.recordDecision({
    escalation_id: esc.id, conversation_id: conv.id, conversation_state: conv.state,
    classifier_class: null, classifier_confidence: null,
    draft_template: esc.draft_template, draft_body: esc.draft_body,
    decision, final_body: finalBody,
  });
}

export async function startDaemon({ env = process.env, log = console.log } = {}) {
  const overrides = loadOverrides();
  const oauth = buildOAuthClient(env);
  const stored = loadStoredToken(TOKEN_PATH);
  if (!stored) throw new Error(`No Gmail token at ${TOKEN_PATH}. Run \`npm run pilot-auth\` first.`);
  oauth.setCredentials(stored);
  const gmail = makeGmail(oauth);
  const slack = makeSlackClient(env.SLACK_BOT_TOKEN);
  const db = openDb(DB_PATH);
  db.migrate();

  const gmailOps = {
    sendMessage: gmailSend,
    listInboundQuery,
    getMessage: gmailGet,
    fetchAttachment,
  };
  const slackOps = { postEscalation };

  async function tickOnce() {
    const now = getEffectiveNow({ env, overrides });
    try {
      await runTick({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
      });
    } catch (e) {
      log(`tick error: ${e.message}`);
    }
  }

  async function followupOnce() {
    const now = getEffectiveNow({ env, overrides });
    try {
      await runDailyFollowup({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
      });
    } catch (e) {
      log(`followup error: ${e.message}`);
    }
  }

  cron.schedule(env.PILOT_TICK_CRON ?? '*/15 * * * *', tickOnce);
  cron.schedule(env.PILOT_FOLLOWUP_CRON ?? '0 9 * * *', followupOnce);
  log(`Cron scheduled: tick=${env.PILOT_TICK_CRON}, followup=${env.PILOT_FOLLOWUP_CRON}`);

  // Run one tick immediately on startup
  await tickOnce();

  // Slack interactivity webhook
  const app = express();
  app.post('/slack/interactivity', express.raw({ type: '*/*' }), async (req, res) => {
    const body = req.body.toString('utf8');
    const ts = req.header('X-Slack-Request-Timestamp');
    const sig = req.header('X-Slack-Signature');
    if (!verifySlackSignature({ signingSecret: env.SLACK_SIGNING_SECRET, timestamp: ts, body, signature: sig })) {
      return res.status(401).send('bad signature');
    }
    res.status(200).send(''); // ack immediately

    try {
      const parsed = parseInteractivityPayload(body);
      if (parsed.type === 'block_actions') {
        const escId = parseInt(parsed.escalation_id, 10);
        const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
        if (!esc) return;
        const conv = db.getConversation(esc.conversation_id);
        if (parsed.action_id === 'esc_approve') {
          await sendApprovedReply({ db, gmail, env, conv, esc, finalBody: esc.draft_body, decision: 'approve_unmodified' });
        } else if (parsed.action_id === 'esc_edit') {
          await openEditModal(slack, { trigger_id: parsed.trigger_id, escalation_id: escId, draft_reply: esc.draft_body });
        } else if (parsed.action_id === 'esc_skip') {
          db.resolveEscalation(escId, { status: 'resolved_skip' });
          db.recordDecision({
            escalation_id: escId, conversation_id: conv.id, conversation_state: conv.state,
            classifier_class: null, classifier_confidence: null,
            draft_template: esc.draft_template, draft_body: esc.draft_body,
            decision: 'skip', final_body: null,
          });
        }
      } else if (parsed.type === 'view_submission' && parsed.view?.callback_id === 'esc_edit_modal') {
        const escId = parseInt(parsed.view.private_metadata, 10);
        const text = parsed.view.state.values.reply_input.reply_text.value;
        const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
        const conv = db.getConversation(esc.conversation_id);
        await sendApprovedReply({ db, gmail, env, conv, esc, finalBody: text, decision: 'edit' });
      }
    } catch (e) {
      log(`slack interactivity error: ${e.message}`);
    }
  });

  const port = parseInt(env.SLACK_INTERACTIVITY_PORT ?? '3000', 10);
  app.listen(port, () => log(`Slack interactivity listener on :${port}`));
}
```

- [ ] **Step 2: Create scripts/pilot-daemon.js**

```js
#!/usr/bin/env node
import 'dotenv/config';
import { startDaemon } from '../src/daemon.js';
await startDaemon({ env: process.env });
```

- [ ] **Step 3: Quick smoke run**

Run: `node -e "import('./src/daemon.js').then(m => console.log(Object.keys(m)))"`
Expected: prints `[ 'startDaemon' ]`. (Just confirming the module loads.)

- [ ] **Step 4: Commit**

```bash
git add src/daemon.js scripts/pilot-daemon.js
git commit -m "feat(pilot): daemon process (cron + slack interactivity webhook)"
```

---

## Task 12: pilot-auth script

**Files:**
- Create: `scripts/pilot-auth.js`

One-time Gmail OAuth flow. Opens browser, captures the code at `http://localhost:3001/oauth2callback`, exchanges for tokens, saves to `~/.config/mediagraf/pilot-gmail-token.json`. Verified live (not unit-tested).

- [ ] **Step 1: Create scripts/pilot-auth.js**

```js
#!/usr/bin/env node
import 'dotenv/config';
import http from 'node:http';
import { exec } from 'node:child_process';
import { buildOAuthClient, saveToken } from '../src/gmail.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const oauth = buildOAuthClient(process.env);

const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\nOpening browser for Gmail OAuth consent…');
console.log(`If it does not open automatically, visit:\n${authUrl}\n`);

const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
exec(`${opener} "${authUrl}"`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:3001`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404); res.end('not found'); return;
  }
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400); res.end('no code'); return; }
  try {
    const { tokens } = await oauth.getToken(code);
    saveToken(TOKEN_PATH, tokens);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>OAuth complete</h1><p>You can close this window.</p>');
    console.log(`\nTokens saved to ${TOKEN_PATH}`);
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.writeHead(500); res.end(`error: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
});

server.listen(3001, () => console.log('Listening on http://localhost:3001 for OAuth callback…'));
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pilot-auth.js
git commit -m "feat(pilot): one-time gmail OAuth script"
```

---

## Task 13: pilot-init script

**Files:**
- Create: `scripts/pilot-init.js`

Reads `data/pilot-overrides.json` + `data/municipalities.json`, resolves active kommuner, creates a `conversation` row per `(kommun_kod, role)` pair with staggered `scheduled_send_at` (1 per day starting today at 10:00 local).

- [ ] **Step 1: Create scripts/pilot-init.js**

```js
#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/storage.js';
import { loadOverrides, resolveActiveKommuner } from '../src/pilot-config.js';

const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const overrides = loadOverrides();
const live = JSON.parse(readFileSync('data/municipalities.json', 'utf8'));
const active = resolveActiveKommuner(overrides, live);

if (active.length === 0) {
  console.error('No active kommuner — check data/pilot-overrides.json');
  process.exit(1);
}

const db = openDb(DB_PATH);
db.migrate();

const today = new Date();
today.setHours(10, 0, 0, 0);

const ELIGIBLE_ROLES = new Set(['central', 'utbildning', 'gymnasie', 'vuxenutbildning']);

let created = 0;
let skipped = 0;
active.forEach((kommun, dayIdx) => {
  const scheduledSendAt = new Date(today);
  scheduledSendAt.setDate(today.getDate() + dayIdx);
  const seenRoles = new Set();
  for (const c of kommun.contacts) {
    if (!ELIGIBLE_ROLES.has(c.role)) continue;
    const roleKey = c.role === 'gymnasie' || c.role === 'vuxenutbildning' ? 'utbildning' : c.role;
    if (seenRoles.has(roleKey)) continue;
    seenRoles.add(roleKey);
    try {
      db.createConversation({
        kommun_kod: kommun.kommun_kod,
        kommun_namn: kommun.kommun_namn,
        role: roleKey,
        contact_email: c.email,
        scheduled_send_at: scheduledSendAt.toISOString(),
      });
      created++;
    } catch (e) {
      if (/UNIQUE/.test(e.message)) { skipped++; continue; }
      throw e;
    }
  }
});

console.log(`Created ${created} conversations, skipped ${skipped} duplicates.`);
console.log(`First dispatch: ${today.toISOString()}; last: day +${active.length - 1}`);
db.close();
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pilot-init.js
git commit -m "feat(pilot): pilot-init script seeds SQLite with staggered initial sends"
```

---

## Task 14: pilot-resolve script (Slack-free fallback)

**Files:**
- Create: `scripts/pilot-resolve.js`

CLI to apply an escalation decision from the terminal — useful when ngrok is down or you just want to fix something without leaving the shell.

- [ ] **Step 1: Create scripts/pilot-resolve.js**

```js
#!/usr/bin/env node
import 'dotenv/config';
import { google } from 'googleapis';
import { openDb } from '../src/storage.js';
import { buildOAuthClient, loadStoredToken, makeGmail, sendMessage } from '../src/gmail.js';

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

const escId = parseInt(arg('escalation'), 10);
const action = arg('action');
const text = arg('text');

if (!escId || !['send', 'edit', 'skip'].includes(action)) {
  console.error('Usage: pilot-resolve --escalation=<id> --action=send|edit|skip [--text="..."]');
  process.exit(1);
}

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const db = openDb(process.env.PILOT_DB_PATH ?? 'data/pilot.db');
db.migrate();

const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
if (!esc) { console.error(`Escalation ${escId} not found`); process.exit(1); }
if (esc.status !== 'open') { console.error(`Escalation ${escId} already resolved as ${esc.status}`); process.exit(1); }
const conv = db.getConversation(esc.conversation_id);

if (action === 'skip') {
  db.resolveEscalation(escId, { status: 'resolved_skip' });
  db.recordDecision({
    escalation_id: escId, conversation_id: conv.id, conversation_state: conv.state,
    classifier_class: null, classifier_confidence: null,
    draft_template: esc.draft_template, draft_body: esc.draft_body,
    decision: 'skip', final_body: null,
  });
  console.log(`Escalation ${escId} skipped (decision logged).`);
  process.exit(0);
}

const replyText = action === 'edit' ? (text ?? '') : (esc.draft_body ?? '');
if (!replyText) { console.error(`No reply text. Use --text="..." with --action=edit.`); process.exit(1); }

const oauth = buildOAuthClient(process.env);
const stored = loadStoredToken(TOKEN_PATH);
if (!stored) { console.error(`No Gmail token at ${TOKEN_PATH}`); process.exit(1); }
oauth.setCredentials(stored);
const gmail = makeGmail(oauth);

const sent = await sendMessage(gmail, {
  from: `${process.env.GMAIL_FROM_NAME} <${process.env.GMAIL_USER_EMAIL}>`,
  to: conv.contact_email,
  subject: esc.draft_subject ?? 'Re: Begäran om allmänna handlingar',
  body: replyText,
  threadId: conv.gmail_thread_id,
});
const nowIso = new Date().toISOString();
db.recordMessage({
  conversation_id: conv.id, gmail_message_id: sent.id, direction: 'outbound',
  from_email: process.env.GMAIL_USER_EMAIL, to_email: conv.contact_email,
  subject: esc.draft_subject ?? 'Re: Begäran om allmänna handlingar', body_text: replyText,
  classification: null, classification_confidence: null,
  received_at: nowIso, attachment_count: 0,
});
const patch = { last_outbound_at: nowIso };
if (esc.draft_template === 'T_RECEIPT') patch.receipt_sent = 1;
if (esc.draft_template === 'T_FOLLOWUP_NUDGE' || esc.draft_template === 'T_FOLLOWUP_CLOSE') {
  patch.followup_count = (conv.followup_count ?? 0) + 1;
}
db.updateConversationState(conv.id, conv.state, patch);
db.resolveEscalation(escId, { status: action === 'edit' ? 'resolved_edit' : 'resolved_send', resolved_text: replyText });
db.recordDecision({
  escalation_id: escId, conversation_id: conv.id, conversation_state: conv.state,
  classifier_class: null, classifier_confidence: null,
  draft_template: esc.draft_template, draft_body: esc.draft_body,
  decision: action === 'edit' ? 'edit' : 'approve_unmodified',
  final_body: replyText,
});

console.log(`Escalation ${escId} resolved (${action}). Sent gmail message ${sent.id}. Decision logged.`);
db.close();
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pilot-resolve.js
git commit -m "feat(pilot): CLI fallback to resolve escalations without Slack"
```

---

## Task 15: Setup runbook + Stage 0 readiness

**Files:**
- Create: `docs/superpowers/runbooks/2026-05-19-pilot-setup.md`

This task wraps up everything with the manual setup steps you (the human) need to do once before the bot can run live. After this task, you're ready to walk through the six Stage 0 scenarios from the spec.

- [ ] **Step 1: Create the runbook**

Create `docs/superpowers/runbooks/2026-05-19-pilot-setup.md` with the exact content below:

````markdown
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
````

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/2026-05-19-pilot-setup.md
git commit -m "docs(pilot): setup runbook for Google Cloud + Slack + ngrok + Stage 0 walkthrough"
```

---

## Self-review checklist (already run)

- ✅ Spec coverage:
  - Stage 0/1 toggle → Task 1 (`pilot-overrides.json`) + Task 2 (`resolveActiveKommuner`, `isClockSkewAllowed`).
  - **Approval-first autonomy model** → Tasks 10 (tick drafts, never autosends except T-INITIAL) + 11 (daemon's Slack handler is where Approve/Edit triggers actual Gmail send and writes a decisions row) + 14 (CLI fallback also records decisions).
  - **`decisions` table** logging classifier_class + state + draft_template + decision + final_body → Task 5 schema + `recordDecision` helper + dedicated test.
  - State machine → Task 6 (`nextActionForClassification`, `staleAction`) — unchanged shape; tick.js reinterprets `action` as "draft this template" instead of "send this template".
  - SQLite schema (5 tables: conversations, messages, attachments, escalations, decisions) → Task 5.
  - Reply classifier with the documented Swedish patterns → Task 4.
  - Five templates → Task 3.
  - Gmail send + read + attachments + threading → Task 8.
  - Slack escalation with Block Kit + signature verification + modal edit → Task 9 + 11.
  - 15-min tick + 09:00 follow-up cron → Task 11.
  - PDF storage with sidecar JSON → Task 7.
  - Staggered 1/day initial dispatch → Task 13 (`pilot-init.js` schedules days 0..N-1).
  - Slack CLI fallback → Task 14.
  - Manual OAuth + Slack app + ngrok runbook → Task 15.

- ✅ No placeholders, no TODO/TBD/"similar to" patterns.

- ✅ Type consistency:
  - Classifier output `{ class, confidence, signals, extracted }` consistent across classifier.js, conversation.js (uses `class`), and tick.js (uses `class` + `confidence`).
  - `nextActionForClassification(state, classification.class, opts)` signature matches usage in tick.js.
  - DB column names match across storage.js / tick.js / daemon.js (`followup_count`, `receipt_sent`, `arendenummer`, `gmail_thread_id`, `draft_subject`, `draft_body`, `draft_template`).
  - Template context fields (`kommun_namn`, `role`, `from_email`, `from_name`, `thread_subject`, `days_since_send`) consistent between templates.js tests and tick.js usage.
  - `recordDecision({ escalation_id, conversation_id, conversation_state, classifier_class, classifier_confidence, draft_template, draft_body, decision, final_body })` signature matches usage in daemon.js and pilot-resolve.js.
