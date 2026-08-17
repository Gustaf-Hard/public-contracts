// Contract-validator checklist test over sampled municipal contract PDFs.
// Usage: ANTHROPIC_API_KEY=... node scripts/research/contract-checklist.mjs <workdir>/sample.json
// Expects <workdir>/pdfs/<contract_id>.pdf; writes <workdir>/results/<contract_id>.json (skips existing).
// sample.json rows: {contract_id, kommun, vendor, annual_value_sek, ...} — see docs/superpowers/research/2026-08-17-contract-validator-checklist-test.md
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';

const SAMPLE = process.argv[2] ?? 'sample.json';
const WORKDIR = path.dirname(path.resolve(SAMPLE));
const client = new Anthropic();
const MODEL = 'claude-opus-5';

const CHECKS = [
  ['price_index', 'Prisjustering: finns indexklausul/prisjusteringsregel, vilket index, tak?'],
  ['price_cap', 'Pristak: är årlig prisökning begränsad (t.ex. max X %)?'],
  ['term_length', 'Avtalstid: initial löptid och total maxtid inkl. förlängningar'],
  ['auto_renew', 'Automatisk förlängning: förlängs avtalet automatiskt om ingen säger upp?'],
  ['notice_period', 'Uppsägningstid: hur lång, och när måste kommunen agera?'],
  ['exit_data', 'Exit/dataportabilitet: rätt att få ut sin data i användbart format vid avtalsslut, radering'],
  ['sla_uptime', 'SLA tillgänglighet: utlovad drifttid (%), mätperiod, undantag'],
  ['sla_remedy', 'SLA-vite/kompensation: prisavdrag/vite vid brott mot SLA'],
  ['support', 'Support: svarstider, öppettider, kanaler'],
  ['security', 'Informationssäkerhet: certifiering (ISO 27001 etc), kryptering, backup, incidentrapportering'],
  ['gdpr_pub', 'Personuppgifter: PUB-avtal/personuppgiftsbiträdesavtal refererat eller bilagt; datalagring inom EU/EES'],
  ['subprocessors', 'Underbiträden/underleverantörer: reglerat, tredjelandsöverföring'],
  ['liability', 'Ansvarsbegränsning: leverantörens ansvar begränsat till X; kommunens skydd'],
  ['ip_content', 'Rättigheter till innehåll som kommunen/eleverna skapar'],
  ['accessibility', 'Tillgänglighet (WCAG/DOS-lagen) utlovat'],
  ['change_control', 'Ändringar av tjänsten/villkoren: kan leverantören ändra ensidigt?'],
  ['governing_terms', 'Vilka villkor gäller: kommunens/SKR/Adda-villkor, IT&Telekomföretagens standardavtal, eller leverantörens egna?'],
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_kind', 'pages_read', 'checks', 'red_flags', 'ask_for', 'overall_risk', 'summary'],
  properties: {
    doc_kind: { type: 'string', enum: ['full_agreement', 'order_form_only', 'framework_calloff', 'price_offer', 'other'] },
    pages_read: { type: 'integer' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'finding', 'quote', 'risk'],
        properties: {
          id: { type: 'string', enum: CHECKS.map((c) => c[0]) },
          status: { type: 'string', enum: ['present_ok', 'present_weak', 'absent', 'referenced_elsewhere', 'not_applicable'] },
          finding: { type: 'string' },
          quote: { type: 'string' },
          risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
        },
      },
    },
    red_flags: { type: 'array', items: { type: 'string' } },
    ask_for: { type: 'array', items: { type: 'string' } },
    overall_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
  },
};

const SYSTEM = `Du är en erfaren upphandlingsjurist som granskar IT-/SaaS-avtal åt svenska kommuner innan de skriver på.
Du får ett avtal (eller avtalsliknande dokument) som en kommun har tecknat med en leverantör. Gå igenom checklistan nedan punkt för punkt och svara ENDAST utifrån vad som faktiskt står i dokumentet.

Checklista (id — vad som ska bedömas):
${CHECKS.map(([id, q]) => `- ${id} — ${q}`).join('\n')}

Regler:
- status "present_ok": tydligt reglerat och rimligt för kommunen. "present_weak": reglerat men till kommunens nackdel eller vagt. "absent": inte reglerat alls i dokumentet. "referenced_elsewhere": dokumentet hänvisar till bilaga/villkor som inte finns med. "not_applicable": punkten saknar relevans för dokumenttypen.
- "quote": kort ordagrant citat (max 200 tecken) som belägg, tom sträng om absent.
- "risk": hur allvarlig bristen är för kommunen givet ett per-elev-/licensavtal av denna storlek.
- "red_flags": de 0–5 viktigaste konkreta problemen, en mening var, på svenska, utan utfyllnad.
- "ask_for": de 0–5 konkreta sakerna kommunen borde begära före signering (formulerade som krav, t.ex. "Begär pristak på max 3 % per år kopplat till KPI").
- "doc_kind": "order_form_only" om dokumentet bara är en beställning/orderbekräftelse utan villkorstext; "framework_calloff" om avrop på ramavtal (Adda/GR/Läromedia etc).
- Hitta inte på. Om dokumentet är kort och saknar villkor, säg det (många punkter blir absent/referenced_elsewhere) — det är i sig ett fynd.
- Svara på svenska. Inga tankstreck (—) i löptext.`;

const sample = JSON.parse(fs.readFileSync(path.resolve(SAMPLE), 'utf8'));
fs.mkdirSync(path.join(WORKDIR, 'results'), { recursive: true });

async function runOne(x) {
  const out = path.join(WORKDIR, 'results', `${x.contract_id}.json`);
  if (fs.existsSync(out)) return 'cached';
  const pdf = fs.readFileSync(path.join(WORKDIR, 'pdfs', `${x.contract_id}.pdf`));
  const t0 = Date.now();
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 6000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
          { type: 'text', text: `Kommun: ${x.kommun}\nLeverantör (enligt tidigare extraktion): ${x.vendor ?? 'okänd'}\nÅrsvärde: ${x.annual_value_sek ?? 'okänt'} SEK` },
        ],
      }],
    });
    if (res.stop_reason === 'refusal') throw new Error('refusal');
    const text = res.content.find((b) => b.type === 'text')?.text;
    const parsed = JSON.parse(text);
    fs.writeFileSync(out, JSON.stringify({ meta: x, usage: res.usage, ms: Date.now() - t0, result: parsed }, null, 1));
    return `ok ${res.usage.input_tokens}in/${res.usage.output_tokens}out ${Math.round((Date.now() - t0) / 1000)}s`;
  } catch (e) {
    return `ERR ${e.status ?? ''} ${e.message.slice(0, 120)}`;
  }
}

const CONC = 4;
let i = 0;
async function worker() {
  while (i < sample.length) {
    const x = sample[i++];
    const r = await runOne(x);
    console.log(`[${x.contract_id}] ${x.kommun} / ${x.vendor}: ${r}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
