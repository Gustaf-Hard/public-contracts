#!/usr/bin/env node
// Read purchase and licence lists (order histories, licence overviews, cost
// compilations filed as följebrev_sammanställning) into purchase_rows.
// Not part of the 15-minute tick; run by hand.
//
//   node scripts/17-extract-purchases.js                       # dry run: no writes, no LLM calls
//   node scripts/17-extract-purchases.js --apply               # write rows (LLM for PDFs and unmapped sheets)
//   node scripts/17-extract-purchases.js --apply --attachment=<id>
//   options: --force (re-extract done or parked documents)  --limit=N
//            --files-dir=<dir> (copies named <attachment id>.<ext>, checked first)
//            --show=N (print N rows per document)
import 'dotenv/config';
import { openDb } from '../src/storage.js';
import { runPurchaseExtraction } from '../src/purchase-run.js';
import { classifyPurchaseRow } from '../src/purchase-list.js';

function arg(name) {
  const i = process.argv.findIndex((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (i === -1) return null;
  const a = process.argv[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : process.argv[i + 1] ?? null;
}
const flag = (name) => process.argv.includes(`--${name}`);

const apply = flag('apply');
const onlyArg = arg('attachment');
const show = arg('show') ? parseInt(arg('show'), 10) : 0;
const db = openDb(process.env.PILOT_DB_PATH ?? 'data/pilot.db');
db.migrate();

const res = await runPurchaseExtraction({
  db,
  apply,
  force: flag('force'),
  onlyId: onlyArg != null ? parseInt(onlyArg, 10) : null,
  limit: arg('limit') ? parseInt(arg('limit'), 10) : Infinity,
  contractsDir: process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts',
  filesDir: arg('files-dir'),
  log: (m) => console.log(m),
});

const filled = (rows, k) => rows.filter((r) => (Array.isArray(r[k]) ? r[k].length : r[k] != null)).length;
for (const d of res.documents) {
  if (!d.rows) continue;
  const cls = d.rows.map(classifyPurchaseRow);
  console.log(`#${d.id} ${d.method}: ${d.rows.length} rader; leverantör ${filled(d.rows, 'supplier')}, produkt ${filled(d.rows, 'product')}, belopp ${filled(d.rows, 'amount_sek')}, antal ${filled(d.rows, 'quantity')}, period ${filled(d.rows, 'period_end')}, läsår ${filled(d.rows, 'school_year')}, årskurser ${filled(d.rows, 'grades')}; i katalogen: ${cls.filter((c) => c.company_slug).length} företag, ${cls.filter((c) => c.product_slug).length} produkter${d.stated_total_sek != null ? '; angiven totalsumma finns' : ''}`);
  for (const r of d.rows.slice(0, show)) console.log('   ', JSON.stringify(r));
}
console.log(`${apply ? 'Klart' : 'Torrkörning klar (inget skrivet, inga LLM-anrop)'}: ${res.candidates} kandidater, ${res.written} skrivna (${res.partial} delvis), ${res.not_list} inte listor, ${res.skipped} överhoppade, ${res.would_call_llm} skulle läsas av LLM, ${res.failed} misslyckade (${res.parked.length} parkerade${res.backoff ? `, ${res.backoff} uppskjutna utan bokfört försök` : ''}).`);
if (res.env_fault) console.log('VARNING: alla filer saknas på disk. Inget bokfördes. Kontrollera PILOT_CONTRACTS_DIR.');
if (res.systemic) console.log('VARNING: alla försök misslyckades tillfälligt. Kontrollera API-nyckel, modell och schema.');
db.close();
