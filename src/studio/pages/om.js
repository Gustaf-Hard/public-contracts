// /studio/om (spec §7.5 item 9): how the data is collected and what the
// numbers mean, in plain Swedish. Every number on this page is computed from
// the facts, dataBasis and the status map, never written into the copy.

import { esc } from '../layout.js';
import { fmtInt, fmtPct } from '../format.js';
import { MIN_N, KOMMUNER_TOTAL, ACTIVE_YEARS, isCollectionFinished, elevCoverage } from '../../studio-data.js';
import { SIZE_BANDS } from '../../kommun-stats.js';
import { isIso, isNum, headline, section, nOf, safeAll, notDone, floorText, elevCoverageText } from './common.js';
import { kommunStatus } from './lists.js';
import { knownValue } from './marknad.js';

// A basis figure that could not be read is "okänt", never 0.
const num = (n) => (isNum(n) ? fmtInt(n) : 'okänt');
const nOfU = (n, one, many) => (isNum(n) ? nOf(n, one, many) : `okänt antal ${many}`);
const YEARS_SV = ['noll', 'ett', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio', 'tio'];
const yearsText = (n) => `${YEARS_SV[n] ?? fmtInt(n)} år`;

// "under 10 000, 10 000 till 25 000, ... och över 100 000 invånare"
export function sizeBandsText(bands = SIZE_BANDS) {
  const parts = bands.map((b) => (b.min === 0 || b.min == null ? `under ${fmtInt(b.max)}`
    : b.max == null ? `över ${fmtInt(b.min)}` : `${fmtInt(b.min)} till ${fmtInt(b.max)}`));
  return `${parts.slice(0, -1).join(', ')} och ${parts[parts.length - 1]} invånare`;
}

// Collection status per kommun, by the same rules as the Kommuner directory.
export function statusCounts({ facts, stats, statusMap }) {
  const all = safeAll(stats).map((r) => r.kod);
  const kods = all.length ? all : [...new Set([...statusMap.keys(), ...facts.map((f) => f.kommun_kod)])].filter(Boolean);
  const collected = new Set(facts.map((f) => f.kommun_kod));
  const out = { done: 0, open: 0, partial: 0, dead_end: 0, not_contacted: 0, unknown: 0 };
  for (const kod of kods) out[kommunStatus(statusMap, kod, collected.has(kod))]++;
  return out;
}

// Each collected avtal lands in exactly one bucket.
export function avtalBreakdown(facts, today) {
  const by = new Map();
  for (const f of facts) {
    if (!by.has(f.contract_id)) by.set(f.contract_id, []);
    by.get(f.contract_id).push(f);
  }
  const out = { active: 0, superseded: 0, expired: 0, undated: 0 };
  for (const fs of by.values()) {
    const f = fs[0];
    if (fs.some((x) => x.active && !x.superseded)) out.active++;
    else if (f.active) out.superseded++;
    else if (isIso(f.period_end) && f.period_end.slice(0, 10) < today) out.expired++;
    else out.undated++;
  }
  return { ...out, total: by.size };
}

function basisCounts(facts) {
  const head = headline(facts);
  const priced = head.filter((f) => isNum(f.kr_per_elev));
  const c = { styckpris: 0, avtalets_elevantal: 0, skolverket: 0 };
  for (const f of priced) if (c[f.kr_per_elev_basis] != null) c[f.kr_per_elev_basis]++;
  return { ...c, priced: priced.length, rows: head.length };
}

function fetchedDate(stats) {
  const s = stats?.data?.fetched_at;
  return isIso(s) ? s.slice(0, 10) : null;
}

function bar(parts, total) {
  const segs = parts.filter((p) => p.n > 0).map((p) => `<i class="om-seg ${p.cls}" style="flex-grow:${p.n}" title="${esc(`${p.label}: ${fmtInt(p.n)}`)}"></i>`).join('');
  return `<div class="om-bar" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${p.n}`).join(', '))}">${segs}</div>
  <ul class="om-legend">${parts.map((p) => `<li><i class="om-sw ${p.cls}"></i><span>${esc(p.label)}</span><b>${esc(fmtInt(p.n))}</b><small>${esc(total ? fmtPct(p.n / total) : '')}</small></li>`).join('')}</ul>`;
}

const p = (text) => `<p>${esc(text)}</p>`;

export function renderOm({ facts, stats, statusMap = new Map(), basis = {}, today, ttlMs = 5 * 60 * 1000, purchases = [] }) {
  const b = basis ?? {};
  const br = avtalBreakdown(facts, today);
  const kb = basisCounts(facts);
  const sc = statusCounts({ facts, stats, statusMap });
  const open = sc.open;
  const notContacted = sc.not_contacted;
  const finished = Object.entries(sc).filter(([k]) => isCollectionFinished(k)).reduce((x, [, n]) => x + n, 0);
  const fetched = fetchedDate(stats);
  const laar = stats?.data?.laar ?? null;
  const ttlMin = Math.max(1, Math.round(ttlMs / 60000));

  const header = `<section class="entity-header">
  <div class="entity-grid">
    <div class="eh-main">
      <span class="kicker">Om datan</span>
      <h1 class="page-title">Var siffrorna kommer ifrån</h1>
      <p class="lede">${esc(`Allt i studion bygger på ${nOfU(b.collected, 'avtal', 'avtal')} som ${nOfU(b.kommuner_collected, 'kommun', 'kommuner')} har lämnat ut till oss som allmänna handlingar. ${num(b.active)} av dem är aktiva i dag, och det är de som räknas i marknadens siffror.`)}</p>
    </div>
    <div class="eh-side">
      <dl class="eh-facts">
        <div class="eh-fact"><dt>Insamlade avtal</dt><dd class="eh-val">${esc(num(b.collected))}</dd><dd class="eh-sub">från ${esc(nOfU(b.kommuner_collected, 'kommun', 'kommuner'))}</dd></div>
        <div class="eh-fact"><dt>Aktiva avtal</dt><dd class="eh-val">${esc(num(b.active))}</dd><dd class="eh-sub">i ${esc(nOfU(b.kommuner_with_avtal, 'kommun', 'kommuner'))}</dd></div>
        <div class="eh-fact"><dt>Insamling klar</dt><dd class="eh-val">${esc(fmtInt(finished))}</dd><dd class="eh-sub">av ${esc(fmtInt(KOMMUNER_TOTAL))} kommuner${sc.dead_end || sc.partial ? `, ${esc(notDone(sc.dead_end, sc.partial))}` : ''}</dd></div>
      </dl>
    </div>
  </div>
</section>`;

  const insamling = `<div class="om-prose">
  ${p('Vi skickar en begäran om allmänna handlingar enligt offentlighetsprincipen till varje kommuns registrator och ber om kommunens gällande avtal för skolans digitala verktyg, lärplattformar och läromedel: lärplattformar och LMS, digitala läromedel och licenser, och administrativa system kopplade till undervisningen. Elevhälsans journalsystem ingår inte i begäran, men kommunerna skickar ibland sådana avtal ändå, och då visas de. Avtalen som kommer tillbaka läses rad för rad: leverantör, produkter, period, årsvärde, prismodell och vilka skolformer avtalet gäller.')}
  ${p('Leverantörs- och produktnamn i avtalen skrivs på många sätt. En katalog läser varje namn som ett företag, en produkt, ett tillägg, en rabatt eller ett segment, så att samma produkt räknas som en.')}
  ${p(`I dag är insamlingen klar i ${nOf(finished, 'kommun', 'kommuner')} och pågår i ${fmtInt(open)}${notContacted ? `. I ${nOf(notContacted, 'kommun', 'kommuner')} har vi inte begärt ut avtal än` : ''}${sc.unknown ? `. För ${nOf(sc.unknown, 'kommun', 'kommuner')} vet vi inte hur långt insamlingen har kommit` : ''}. ${sc.dead_end ? `${nOf(sc.dead_end, 'kommun', 'kommuner')} har avslutat ärendet utan att lämna ut några avtal. De räknas inte som klara: vi vet inte vad de köper, så de ingår inte bland liknande kommuner med klar insamling.` : ''}${sc.partial ? ` ${nOf(sc.partial, 'kommun', 'kommuner')} har lämnat ut en del avtal men avslutat resten av begäran utan avtal. De räknas inte heller som klara: det som saknas kan vara ett avtal de har.` : ''}`)}
  ${p('Studion visar vad underlaget innehåller, aldrig att en kommun saknar avtal. Vi kan inte bevisa att ett avtal saknas: mejl, fakturor och sammanställningar nämner ibland leverantörer som vi inte har något avtal för, och en kommun skickar det den hittar. Kartorna skiljer därför bara på aktivt avtal i underlaget, bara utgångna eller ersatta avtal i underlaget, och inget avtal i underlaget. Hur långt insamlingen har kommit visas för sig, som en egen uppgift i varje ruta: insamling klar, pågår, ej påbörjad, inga avtal utlämnade, delvis utlämnat eller underlag ej genomgånget.')}
  ${p('Underlag ej genomgånget betyder att insamlingen är klar men att vi har underlag från kommunen som vi inte har gått igenom: en fil vi inte har kunnat läsa eller inte har läst än, eller en faktura, orderlista eller sammanställning som pekar på kategorin eller leverantören. Elevhälsa och övrigt ingår inte i vår begäran, så där har kommunerna ingen anledning att skicka avtal till oss.')}
  ${p(`Många kommuner köper digitala läromedel som beställningar i en kanal, till exempel Skolon, Atea eller Läromedia, i stället för som egna avtal. När en kommun lämnar ut en inköpslista, en orderhistorik eller en licensöversikt läser vi raderna ur den: leverantör, produkt, antal, belopp och licensperiod. Det visas som en egen nivå, Köpt via kanalen eller Finns i kommunens inköpslista, på kommun-, leverantörs- och produktsidorna och som en egen markering på kartorna.${(purchases ?? []).length ? ` I dag har vi ${nOf((purchases ?? []).length, 'sådan rad', 'sådana rader')} från ${nOf(new Set((purchases ?? []).map((x) => x.kommun_kod)).size, 'kommun', 'kommuner')}.` : ''}`)}
  ${p('En rad i en inköpslista är ett köp, inte ett avtal. Den gör aldrig att en kommun räknas som att den har avtal, och den ingår inte i årsvärden, marknadsandelar eller medianer per elev. Vi summerar aldrig raderna till en totalsumma; en totalsumma visas bara när dokumentet själv anger den. Licensperioden är radens egen slutdag, annars slutet av läsåret den gäller, och annars okänd. En licenslängd som raden anger, till exempel 12 månader, räknas från orderdatum.')}
  ${p('Ett samverkansavtal som flera kommuner har lämnat ut räknas en gång i marknaden. Vi vet sällan alla medlemmar eller hur kostnaden delas, så på kommunsidorna visas det som samverkansavtal med okänd andel och hela avtalets värde, och det räknas inte in i kommunens årsvärde, pris per elev eller jämförelsen med liknande kommuner. Ett avtal för ett kommunalförbund eller flera kommuner som bara en av dem har lämnat ut kan vi inte känna igen, det bokförs då helt på den kommunen.')}
</div>`;

  const aktiv = `<div class="grid-12">
  <div class="span-7 card">
    <div class="viz-head"><span class="viz-label">De ${esc(fmtInt(br.total))} insamlade avtalen</span><span class="viz-n">ett avtal räknas en gång</span></div>
    ${bar([
    { cls: 'om-active', label: 'Aktiva', n: br.active },
    { cls: 'om-expired', label: 'Utgångna', n: br.expired },
    { cls: 'om-undated hatch', label: `Utan slutdatum och äldre än ${yearsText(ACTIVE_YEARS)}, eller helt utan datum`, n: br.undated },
    { cls: 'om-replaced', label: 'Ersatta av ett nyare avtal', n: br.superseded },
  ], br.total)}
  </div>
  <div class="span-5 om-prose">
    ${p(`Ett avtal är aktivt om slutdatumet är i dag eller senare. Saknar avtalet slutdatum räknas det som aktivt om det började för högst ${ACTIVE_YEARS} år sedan.`)}
    ${p(`Därför är bara ${num(b.active)} av ${num(b.collected)} insamlade avtal aktiva: kommunerna lämnar ofta ut gamla avtal som har gått ut, och en del avtal anger inget slutdatum alls. ${num(b.active_unknown_end)} av de aktiva avtalen saknar slutdatum.`)}
    ${p('Har en kommun flera avtal med samma leverantör om samma produkter räknas bara det nyaste. De äldre syns i underlaget men inte i siffrorna.')}
  </div>
</div>`;

  const krElev = `<div class="om-prose">
  ${p('Pris per elev och år går bara att jämföra när vi vet både vad avtalet kostar och hur många elever det gäller. Vi räknar på ett av tre sätt, i den här ordningen:')}
  <ol class="om-steps">
    <li><b>Styckpris.</b> Avtalet anger ett pris per elev. Ett pris per månad eller termin räknas om till ett år, och ett pris för en period längre än ett år delas upp per år när radens belopp visar det. Går det inte att avgöra används priset inte. <span class="muted">${esc(nOf(kb.styckpris, 'avtalsrad', 'avtalsrader'))}.</span></li>
    <li><b>Avtalets elevantal.</b> Avtalet anger hur många elever det gäller. Årsvärdet delas med det antalet. <span class="muted">${esc(nOf(kb.avtalets_elevantal, 'avtalsrad', 'avtalsrader'))}.</span></li>
    <li><b>Skolverkets elevantal.</b> Avtalet anger vilka skolformer det gäller men inte hur många elever. Årsvärdet delas med antalet elever i kommunens egna skolor i de skolformerna${laar ? `, läsåret ${esc(laar)}` : ''}. <span class="muted">${esc(nOf(kb.skolverket, 'avtalsrad', 'avtalsrader'))}.</span></li>
  </ol>
  ${p(`Ett avtal för hela kommunen utan angivna skolformer räknas inte om till pris per elev, eftersom vi då skulle gissa. Inte heller licenser per användare, per lärare eller personal, avtal efter användning och engångsbelopp: de är inte ett pris för eleverna. Kostnadsfria avtal och avtal på 0 kr ingår inte i prisjämförelsen. Av ${fmtInt(kb.rows)} aktiva avtalsrader har ${fmtInt(kb.priced)} ett pris per elev.`)}
  ${p('En kommun har en prispunkt per produkt, och den kommer från ett enda avtal: det största avtalet för produkten, räknat i årsvärde. Vi lägger aldrig ihop flera avtals värden till ett pris. Ett tilläggsavtal får aldrig ett eget pris per elev, inte heller när det anger ett styckpris. Ett mindre avtal för samma skolformer som huvudavtalet får inget eget pris, och saknar huvudavtalet pris har kommunen inget pris för produkten. Ett avtal för flera produkter ger bara pris för den produkt priset gäller.')}
  ${p('Årsvärdet är avtalets värde omräknat till ett år. Okänt värde räknas aldrig som noll, och varje summa visar hur många avtal värdet är känt för.')}
</div>`;

  const kv = knownValue(headline(facts));
  const cov = elevCoverage(facts, stats);
  const summor = `<div class="om-prose">
  ${p(`Summorna är en lägsta nivå, inte marknadens storlek. En summa i kronor räknar bara aktiva avtal i underlaget med känt värde. I dag har ${nOfU(b.kommuner_with_avtal, 'kommun', 'kommuner')} av ${fmtInt(KOMMUNER_TOTAL)} aktiva avtal i underlaget, och värdet är känt för ${fmtInt(kv.known)} av ${nOf(kv.total, 'aktivt avtal', 'aktiva avtal')}. Det ger ${kv.value == null ? 'inget känt värde än' : floorText(kv.value)}. Kommuner vi inte har avtal från och avtal utan känt värde räknas inte, så den verkliga summan är högre. Därför står det "minst" och "i underlaget" vid varje summa.`)}
  ${p('En leverantörs andel är dess andel av känt värde i underlaget, alltså av summan av de avtal med känt värde som vi har. Den säger inte hur stor leverantörens andel är av hela marknaden.')}
  ${p(`Hur stor del av landet underlaget kommer från räknar vi i elever, inte i kommuner, eftersom kommunerna är olika stora. Vi räknar eleverna i grundskolan åk 1-9 i kommunens egna skolor enligt Skolverket${laar ? `, läsåret ${laar}` : ''}. Grundskolan finns i alla kommuner, så måttet betyder samma sak överallt. Fristående skolor ingår inte. Täckningen är eleverna i de kommuner som har minst ett aktivt avtal i underlaget, delat med eleverna i alla landets kommuner. För en kategori räknas bara kommuner med ett aktivt avtal i den kategorin. En kommun utan känt elevantal räknas inte, varken bland kommunerna med avtal eller i landet, och sidan säger hur många det gäller.`)}
  ${p(`I dag: ${elevCoverageText(cov)}.`)}
  ${p('Vi räknar inte upp underlaget till en uppskattning av hela marknaden. Kommunerna i underlaget är inte ett slumpmässigt urval, så en sådan siffra skulle se säkrare ut än den är. Medianpriser per elev håller bättre när underlaget är ofullständigt, därför visas de först på marknadssidan.')}
</div>`;

  const minN = `<div class="om-prose">
  ${p(`Prisdiagrammen visar en punkt per kommun. Har en kommun flera avtal med känt pris i samma jämförelse räknas den en gång, med medianen av sina egna priser. Median, kvartiler och prisprickar visas bara när minst ${MIN_N} kommuner har känt pris per elev. Med färre visar vi en streckad ruta med texten "för få kommuner" och antalet, och inga enskilda prickar. Det gäller prisdiagrammen, cellerna i prismatriserna och medianpriserna på kategori- och produktkorten. Ett avtal som gäller flera skolformer räknas i varje skolform det omfattar.`)}
  ${p(`På en kommuns sida räknas jämförelserna i kommuner. Kommunens pris för en produkt jämförs med liknande kommuner när minst ${MIN_N} av dem har känt pris för produkten. Är de färre jämför vi med alla kommuner med känt pris, och är också de färre än ${MIN_N} visas bara kommunens eget pris, utan jämförelse. Medianen för vad liknande kommuner lägger per elev och kategori visas från ${MIN_N} kommuner.`)}
  ${p('Kommuners priser visas aldrig som en topplista. På en kommuns sida syns andra kommuner bara som en anonym fördelning. Enskilda avtal med värde finns i underlaget, eftersom avtalen är allmänna handlingar.')}
</div>`;

  const peers = `<div class="om-prose">
  ${p(`Liknande kommuner är de som hör till samma kommungrupp enligt SKR:s indelning, till exempel storstäder, pendlingskommuner nära större stad eller landsbygdskommuner. Har en kommun ingen kommungrupp jämför vi med kommuner av samma storlek efter folkmängd: ${sizeBandsText()}.`)}
  ${p('Hur mycket en kommun lägger per elev och år i varje kategori jämförs bara med liknande kommuner där insamlingen är klar, och i en kategori bara när alla deras aktiva avtal där har känt värde. En kommun som fortfarande skickar avtal, eller vars värde bara delvis är känt, skulle annars dra ned medianen med kostnader vi inte har sett. Summan delas med elever i förskoleklass till åk 9, och avtal som bara gäller förskola, gymnasiet eller komvux räknas inte där.')}
  ${p('Priset för en enskild produkt jämförs däremot med alla liknande kommuner som har ett känt pris per elev för produkten, även om insamlingen där pågår. Ett pris per elev påverkas inte av att kommunen ännu inte har skickat sina andra avtal.')}
</div>`;

  const kanal = `<div class="om-prose">
  ${p('Många kommuner köper via en återförsäljare eller en portal, till exempel Skolon, Läromedia eller Atea, och ett sådant avtal kan innehålla produkter från flera leverantörer. Vi delar då avtalet per leverantör efter beloppen på avtalets rader. Det som inte går att fördela ligger kvar på återförsäljaren och märks "ej fördelat".')}
  ${p('Ett delat avtal räknas fortfarande som ett avtal i antalet avtal och förnyelser, men en gång per leverantör när vi räknar en leverantörs kommuner. På en kommuns sida och en återförsäljares sida räknas hela avtalets värde. Tillägg som integrationer, uppstart eller migrering räknas till leverantören vars avtal det är, inte till företaget som nämns i raden.')}
</div>`;

  const kallor = `<div class="om-prose">
  <ul class="om-sources">
    <li><b>Avtalen</b> kommer från kommunerna själva, som allmänna handlingar.</li>
    <li><b>Elevantal</b> per skolform kommer från Skolverket (grundskola, gymnasieskola och komvux) och Kolada (förskola och förskoleklass), räknat på kommunens egna skolor.</li>
    <li><b>Kommungrupper</b> och kommunnamn kommer från Kolada, som bygger på SKR:s kommungruppsindelning.</li>
    <li><b>Folkmängd</b> kommer från Wikipedias lista över Sveriges kommuner, som bygger på SCB:s befolkningsstatistik.</li>
  </ul>
  ${p(fetched ? `Den öppna statistiken hämtades ${fetched}.` : 'Datum för när den öppna statistiken hämtades är okänt.')}
  ${p(`Nya avtal läses in automatiskt när kommunerna skickar dem. Studions siffror räknas om inom ${ttlMin} minuter efter att ett avtal har tolkats.${b.updated ? ` Senast uppdaterad ${b.updated}.` : ''}`)}
</div>`;

  return `${header}
${section({ id: 'insamling', kicker: 'Insamling', title: 'Hur avtalen samlas in', body: insamling })}
${section({ id: 'aktiva', kicker: 'Aktiva avtal', title: 'Vilka avtal som räknas', body: aktiv })}
${section({ id: 'summor', kicker: 'Summor', title: 'Summorna är en lägsta nivå', body: summor })}
${section({ id: 'kr-elev', kicker: 'Pris per elev', title: 'Hur kr per elev räknas', body: krElev })}
${section({ id: 'for-fa', kicker: 'För få kommuner', title: `Inget visas under ${MIN_N} kommuner`, body: minN })}
${section({ id: 'liknande', kicker: 'Liknande kommuner', title: 'Vem en kommun jämförs med', body: peers })}
${section({ id: 'kanaler', kicker: 'Återförsäljare', title: 'Avtal via en kanal', body: kanal })}
${section({ id: 'kallor', kicker: 'Källor', title: 'Källor och uppdatering', body: kallor })}`;
}
