import * as cheerio from 'cheerio';
import { politeFetch } from './http.js';

const LIST_URL =
  'https://sv.wikipedia.org/wiki/Lista_%C3%B6ver_Sveriges_kommuner';
const WIKI_BASE = 'https://sv.wikipedia.org';

const GENITIVE_CORRECTIONS = new Map([
  ['Stockholms', 'Stockholm'],
  ['Bjurholms', 'Bjurholm'],
  ['Borgholms', 'Borgholm'],
  ['Boxholms', 'Boxholm'],
  ['Gotlands', 'Gotland'],
  ['Hässleholms', 'Hässleholm'],
  ['Katrineholms', 'Katrineholm'],
  ['Laholms', 'Laholm'],
  ['Tidaholms', 'Tidaholm'],
  ['Vaxholms', 'Vaxholm'],
  ['Ängelholms', 'Ängelholm'],
]);

export function parseKommunListPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  // Find any wikitable whose first row contains a "kod" or "kommunkod" header
  $('table.wikitable').each((_, table) => {
    const headerRow = $(table).find('tr').first();
    const headers = headerRow.find('th')
      .map((_, th) => $(th).text().trim().toLowerCase()).get();

    // Detect column indices dynamically
    const kodIdx = headers.findIndex((h) => h === 'kod' || h.includes('kommunkod'));
    if (kodIdx === -1) return; // not a municipality table
    const kommunIdx = headers.findIndex((h) => h === 'kommun' || h.includes('kommunnamn'));
    const lanIdx = headers.findIndex((h) => h === 'län' || h.includes('lan'));

    // Fall back to positional defaults (fixture layout: 0=kod, 1=namn, 2=län)
    const colKod = kodIdx !== -1 ? kodIdx : 0;
    const colNamn = kommunIdx !== -1 ? kommunIdx : 1;
    const colLan = lanIdx !== -1 ? lanIdx : 2;

    $(table).find('tr').slice(1).each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 3) return;
      const kommun_kod = $(tds[colKod]).text().trim().replace(/<!--.*?-->/g, '').trim();
      const nameA = $(tds[colNamn]).find('a').first();
      let kommun_namn = nameA.text().trim() || $(tds[colNamn]).text().trim();
      // Strip trailing " kommun" suffix (present on live Wikipedia page)
      kommun_namn = kommun_namn.replace(/\s+kommun$/i, '').trim();
      // Correct Swedish genitive forms (e.g. "Stockholms" → "Stockholm")
      kommun_namn = GENITIVE_CORRECTIONS.get(kommun_namn) ?? kommun_namn;
      const href = nameA.attr('href') ?? '';
      let wikipedia_url;
      if (href.startsWith('http')) {
        wikipedia_url = href;
      } else if (href.startsWith('//')) {
        wikipedia_url = 'https:' + href;
      } else {
        wikipedia_url = WIKI_BASE + href;
      }
      const lan = $(tds[colLan]).text().trim();
      if (kommun_kod && kommun_namn) {
        out.push({ kommun_kod, kommun_namn, lan, wikipedia_url });
      }
    });
  });
  return out;
}

export function parseKommunInfobox(html) {
  const $ = cheerio.load(html);
  const info = { webbplats: null, org_nr: null };
  $('table.infobox tr').each((_, tr) => {
    const label = $(tr).find('th').text().trim().toLowerCase();
    if (label.includes('webbplats')) {
      const link = $(tr).find('td a[href^="http"]').first().attr('href');
      if (link) info.webbplats = link.trim();
    }
    if (label.includes('org.nr') || label.includes('org.nummer') || label.includes('organisationsnummer')) {
      // Strip footnote references like [4] from the text
      info.org_nr = $(tr).find('td').text().trim().replace(/\[\d+\]/g, '').trim();
    }
  });
  return info;
}

export async function fetchSeed({ log = () => {} } = {}) {
  log(`Fetching kommun list from ${LIST_URL}`);
  const res = await politeFetch(LIST_URL);
  if (!res.ok) throw new Error(`Failed to fetch list: ${res.status}`);
  const html = await res.text();
  const list = parseKommunListPage(html);
  log(`Found ${list.length} kommuner on list page`);

  const enriched = [];
  for (const row of list) {
    try {
      const r = await politeFetch(row.wikipedia_url);
      if (!r.ok) {
        log(`  ${row.kommun_namn}: ${r.status}, skipping infobox`);
        enriched.push({ ...row, webbplats: null, org_nr: null });
        continue;
      }
      const info = parseKommunInfobox(await r.text());
      enriched.push({ ...row, ...info });
      log(`  ${row.kommun_namn}: ${info.webbplats ?? '(no website)'}`);
    } catch (e) {
      log(`  ${row.kommun_namn}: error ${e.message}, skipping`);
      enriched.push({ ...row, webbplats: null, org_nr: null });
    }
  }
  return enriched;
}
