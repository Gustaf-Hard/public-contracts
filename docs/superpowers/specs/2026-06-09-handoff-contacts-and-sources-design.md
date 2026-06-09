# Handoff-kontakter + kontaktkällor — design

**Datum:** 2026-06-09
**Status:** Godkänd design, väntar på implementationsplan

## Problem

När en kommuns registrator hänvisar vidare ("kontakta barn- och
utbildningsförvaltningen på barn.utbildning@arboga.se") fångar LLM-analysen
adressen perfekt — den lagras som `analysis_json.extracted.handoff_to_email`
och `handoff_to_forvaltning` på det inkommande meddelandet i `pilot.db`, och
fäller ärendet till `NEEDS_HUMAN`.

Men kontaktlistan i UI:t kommer från en **separat** källa:
`data/municipalities.json`, byggd av webb-crawlen (`npm run discover`).
Inget promotar en handoff-adress från mejltråden till kontaktlistan. Resultat:
den mest auktoritativa adressen man har — den kommunen explicit angav — syns
inte bland kontakterna och dyker inte upp som kandidat i compose.

Dessutom: dataset-kontakter bär redan en partiell källa (`source_url`,
`found_via: 'pattern_match'`) men den visas ingenstans, och det finns ingen
rangordning mellan "kommunen sa det" och "vi gissade från webbplatsen".

## Beslut (från brainstorming)

1. **Visa handoff-adresser dynamiskt ur `pilot.db`** — mutera inte
   `municipalities.json` (det ska förbli regenererbart från crawlen och inte
   skrivas över av en ny `discover`).
2. **Källa-badge + trust-rang** — varje kontakt får en synlig källetikett, och
   handoff-källan rankas högst (sorteras/väljs först i compose).

## Datamodell (ingen schemaändring)

Inga nya tabeller. Handoff-kontakter härleds vid render ur befintlig
`messages.analysis_json`. Ett enhetligt kontaktobjekt skapas i vyn:

```
{ email, role, forvaltning, source }
  source ∈ 'kommun_handoff' | 'website'
```

Trust-rang (högst först): `kommun_handoff` > `website`.

Källetiketter (svenska):
- `kommun_handoff` → "kommunen angav i mejl"
- `website` (dataset `found_via=pattern_match`/övrigt) → "hittad på webbplats"

## Komponenter

### 1. `aggregateHandoffContacts(conversations, messagesByConv)` — pure helper

I `src/dashboard-views.js`, samma mönster som `aggregateVendors`:
itererar konversationernas meddelanden, läser
`analysis_json.extracted.handoff_to_email` /
`handoff_to_forvaltning`, dedupar på e-post (lowercase). Returnerar
`[{ email, role, forvaltning, source: 'kommun_handoff' }]`.
Hoppar över rader utan `handoff_to_email`.

### 2. `mergeContacts(datasetContacts, handoffContacts)` — pure helper

Slår ihop till en lista med `source` per kontakt:
- Dataset-kontakter → `source: 'website'` (bevara `role`, `forvaltning_namn`).
- Handoff-kontakter → `source: 'kommun_handoff'`.
- Dedup på e-post (lowercase). **Vid kollision vinner högsta trust**
  (`kommun_handoff` ersätter `website` för samma adress).
- Sortering: trust-rang först, därefter `role`-prioritet (befintlig
  `ROLE_PRIORITY`), därefter e-post.

### 3. Kommun-sidan — "E-postadresser"-sektionen

`renderKommunDetail` använder idag `kommun.contacts` direkt. Byt till den
sammanslagna listan och rendera en källa-badge per rad:

```
barn.utbildning@arboga.se
central · Barn- och utbildningsförvaltningen
[kommunen angav i mejl]      ← grön/hög-trust badge

arboga.kommun@arboga.se
central
[hittad på webbplats]        ← neutral badge
```

Badgen återanvänder befintlig `.tag`/pill-CSS (hög trust = accent/grön,
website = neutral/muted). Rubriken kan bli "E-postadresser" (inte längre bara
"i datasetet" eftersom listan nu blandar källor).

### 4. Compose — kandidatval

`GET /kommun/:kod/compose` och T-INITIAL-draftkorten bygger
`candidate_emails` ur `kommun.contacts`. Utöka till den sammanslagna listan
(dataset + handoff ur `db`), filtrerad på vald roll, **sorterad högsta trust
först** så att den förifyllda mottagaren blir den kommun-angivna adressen när
en sådan finns. Källan visas som hint vid varje kandidat.

`createDashboardApp`-routes har redan `db` — handoff-kontakter hämtas via
helpern för aktuell kommuns konversationer.

## Varför inte mutera datasetet

`data/municipalities.json` regenereras från crawlen och `discover` kan skriva
över en kommuns kontakter. En handoff-adress inskriven där skulle kunna
försvinna vid nästa crawl. `pilot.db` är den varaktiga runtime-sanningen för
vad som hänt i dialogen — handoff-adressen hör hemma där och visas härlett.
(Ett framtida promote-script kan läggas till om permanent dataset-kontakt
önskas — utanför scope nu.)

## Felhantering

- Trasig/oparserbar `analysis_json` → hoppas över (befintlig `parseJsonSafe`).
- Ingen handoff i någon tråd → sektionen visar bara dataset-kontakter, som idag.
- Kommun utan dataset-kontakter men med handoff → handoff-kontakten visas ensam.

## Testning (offline, befintligt mönster)

- **`aggregateHandoffContacts`**: extraherar handoff-mejl ur analysis_json;
  dedupar; ignorerar meddelanden utan handoff.
- **`mergeContacts`**: dedup på e-post med trust-vinst; sorterar handoff först;
  bevarar role/forvaltning.
- **Dashboard (seedad tmp-sqlite + `app.listen(0)`)**:
  - Kommun-sida med en handoff-analys visar handoff-adressen + badgen
    "kommunen angav i mejl".
  - Dataset-kontakt visar "hittad på webbplats".
  - Compose-kandidater för rollen listar handoff-adressen först.

## Utanför scope

- Promote-script som skriver handoff-kontakter till `municipalities.json`.
- Redigering/borttagning av kontakter i UI:t.
- Källa-spårning för crawl-kontakter bortom befintliga `source_url`/`found_via`.
