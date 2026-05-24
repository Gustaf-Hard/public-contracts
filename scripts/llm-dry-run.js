#!/usr/bin/env node
// One-off dry run that calls analyseMessage on three realistic Swedish
// kommun replies and prints the structured output. Confirms the API key,
// model, and JSON schema all wire up correctly before we trust the daemon
// with real inbound mail.

import 'dotenv/config';
import { analyseMessage, isLlmAnalysisEnabled } from '../src/analyse-message.js';

if (!isLlmAnalysisEnabled(process.env)) {
  console.error('ANTHROPIC_API_KEY missing — set it in .env first.');
  process.exit(1);
}

const ctx = {
  kommun_namn: 'Testkommun',
  role: 'utbildning',
  conversation_state: 'SENT',
  days_since_last_outbound: 0,
  today_iso: new Date().toISOString().slice(0, 10),
};

const cases = [
  {
    label: 'auto_ack (Sokigo flexiteBPMS-style mottagningskvitto)',
    body: `Tack för din begäran. Vi har tagit emot ditt ärende och återkommer så snart vi kan.

Ärendenummer: K202642713

Med vänlig hälsning,
Registratur
Testkommuns kommun
`,
  },
  {
    label: 'delay_promise (registrator utlovar svar inom 10 dagar)',
    body: `Hej,

Tack för din begäran. Vi behöver cirka 10 arbetsdagar för att ta fram materialet. Återkommer senast 2026-06-08.

Mvh
Mikaela Eriksson
Registrator, Testkommuns kommun`,
  },
  {
    label: 'clarification (ber om precisering)',
    body: `Hej,

För att kunna hjälpa dig på bästa sätt önskar jag veta:

- Avser begäran en viss tidsperiod?
- Gäller den specifika system eller leverantörer?
- Önskar du en sammanställning eller fullständiga avtalshandlingar?

Mvh
Anna`,
  },
];

console.log(`Model: ${process.env.ANTHROPIC_ANALYSIS_MODEL ?? 'claude-haiku-4-5'}`);
console.log(`Today: ${ctx.today_iso}\n`);

for (const c of cases) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`CASE: ${c.label}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(c.body.trim());
  console.log('───────────────────────────────────────────────────────────');
  const t0 = Date.now();
  const result = await analyseMessage(c.body, ctx);
  const ms = Date.now() - t0;
  if (!result) {
    console.log(`(LLM call returned null — fell back to regex) — ${ms}ms`);
    continue;
  }
  console.log(`Intent:           ${result.intent} (confidence ${result.confidence})`);
  console.log(`Suggested action: ${result.suggested_action}`);
  console.log(`Summary:          ${result.summary}`);
  console.log(`follow_up_at:     ${result.follow_up_at ?? 'null'}`);
  const ex = result.extracted ?? {};
  if (ex.arendenummer) console.log(`arendenummer:     ${ex.arendenummer}`);
  if (ex.promised_response_days != null) console.log(`promised days:    ${ex.promised_response_days}`);
  if (ex.promised_response_date) console.log(`promised date:    ${ex.promised_response_date}`);
  if (ex.handoff_to_email) console.log(`handoff email:    ${ex.handoff_to_email}`);
  if (ex.questions?.length) console.log(`questions:        ${ex.questions.join(' | ')}`);
  console.log('--- draft_reply ---');
  console.log(result.draft_reply);
  console.log(`(${ms}ms)\n`);
}
