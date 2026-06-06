# Avtalsvisning + leverantörssidor — design

**Datum:** 2026-06-06
**Status:** Godkänd design, väntar på implementationsplan

## Bakgrund

Dashboarden (`src/dashboard.js` + `src/dashboard-views.js`) listar mottagna avtal
(PDF-attachments i `pilot.db`) men filnamnen är ren text — operatören kan inte
öppna en PDF. Leverantörer existerar bara som LLM-extraherade strängar
(`analysis_json.extracted.mentioned_vendors` per inkommande mejl) utan koppling
till de faktiska avtals-PDF:erna.

Två funktioner byggs i ett svep eftersom leverantörssidorna länkar till PDF-visning:

1. **Klickbara avtal** — öppna en sparad PDF i webbläsaren.
2. **Leverantörsregister** — en indexsida över alla leverantörer och en sida per
   leverantör med alla deras avtal, byggd på LLM-analys av varje avtals-PDF.

## Del 1 — Klickbara avtal

### Route: `GET /attachments/:id`

I `src/dashboard.js`, bredvid övriga GET-routes:

- Slår upp `attachments`-raden via id; läser filen från `saved_path`.
- **Containment-guard:** `path.resolve(saved_path)` måste ligga inom
  `path.resolve(contractsDir) + sep` — annars 404. Ingen path går in i URL:en
  (bara DB-id), så traversal är omöjlig by construction.
- Headers: `Content-Type` från `att.mime_type` (fallback `application/pdf`),
  `Content-Disposition: inline; filename="…"` → PDF:en renderas i fliken.
- Alla felfall (ingen DB, ingen rad, fil saknas på disk, utanför contractsDir)
  ger 404 — ingen information om disklayout läcker.
- `contractsDir` blir en ny valfri dep till `createDashboardApp`
  (default `data/contracts`), enligt befintligt injected-deps-mönster så att
  tester kan peka på en tmp-katalog.

### Vyer

1. `aggregateContracts` (`src/dashboard-views.js`) tar med `id: att.id`;
   filnamnscellen i "Mottagna avtal"-tabellen blir
   `<a href="/attachments/${id}" target="_blank">📎 filnamn</a>`.
2. Tidslinjens 📎 "Avtal mottaget"-event får `link: /attachments/${att.id}`;
   `renderTimeline` wrappar `e.sub` i `<a target="_blank">` när `e.link` är satt.
   Övriga eventtyper påverkas inte.

## Del 2 — Leverantörer

### Datamodell (nya tabeller i pilot.db, via `db.migrate()`)

```
vendors            id · name (kanoniskt, UNIQUE case-insensitive) · slug (UNIQUE, för URL) · created_at
products           id · vendor_id → vendors · name        (UNIQUE per vendor_id+name)
contracts          id · attachment_id → attachments (UNIQUE) · vendor_id → vendors (nullable)
                   avtalsvarde (text) · valuta · period_start · period_end (ISO-datum eller null)
                   is_contract (0/1) · summary · confidence · analysis_json · model · analyzed_at
contract_products  contract_id → contracts · product_id → products   (PK på paret)
```

- En leverantör har många produkter; ett avtal kan täcka flera produkter.
- `attachment_id UNIQUE` gör analysen idempotent — en rad per PDF.
- `is_contract = 0` för PDF:er som inte är avtal (bilagor, prislistor,
  sekretessbeslut); de får ingen leverantörskoppling men markeras som analyserade.
- `vendor_id` nullable: analysen kan misslyckas att identifiera leverantör.

### LLM-analys — `src/analyse-contract.js`

Speglar mönstret i `src/analyse-message.js`:

- Anthropic-client cachas per API-nyckel; `isLlmAnalysisEnabled`-style gate på
  `ANTHROPIC_API_KEY`; null-return vid fel (aldrig throw till caller).
- PDF:en skickas **direkt som base64 `document`-block** — ingen
  text-extrahering behövs:
  ```js
  { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  ```
- Svensk system-prompt med `cache_control: { type: 'ephemeral' }`.
- Strukturerad output via `output_config.format` med JSON-schema:
  `is_contract` (bool), `vendor_name` (string|null, leverantörens kanoniska
  företagsnamn utan bolagsform — "Skolon", inte "Skolon AB"),
  `products` (string[]), `avtalsvarde` (string|null), `valuta` (string|null),
  `period_start` / `period_end` (ISO-datum|null), `summary` (string),
  `confidence` (number).
- Modell: `claude-opus-4-8`, override via `ANTHROPIC_CONTRACT_MODEL`
  (samma env-mönster som `ANTHROPIC_ANALYSIS_MODEL`).
- Leverantörsmatchning i lagringssteget: case-insensitive mot `vendors.name`;
  skapa annars ny vendor med kebab-case-slug. Manuell merge av dubbletter är
  utanför scope.

### Körning

- **`scripts/06-analyse-contracts.js`** — idempotent runner: hittar alla
  PDF-attachments utan `contracts`-rad, analyserar och skriver.
  Flaggor: `--force` (analysera om även redan analyserade — när prompt/schema
  ändrats), `--only=<attachment_id>` (enstaka).
- **Daemonens tick** anropar samma "analysera väntande avtal"-funktion efter
  att nya attachments sparats, så nya avtal analyseras automatiskt utan
  manuell körning. Fel i analysen får inte fälla ticken (null-fallback).

### UI

- **`GET /leverantorer`** — ny flik i nav. Tabell: leverantör (länk),
  produkter, antal avtal, antal kommuner, senaste avtalsdatum.
- **`GET /leverantor/:slug`** — per leverantör: produkter som taggar,
  avtalstabell (kommun → länk till kommun-sidan, datum, filnamn →
  `/attachments/:id`, värde, avtalstid, aktiv/utgången-badge baserat på
  `period_end` vs idag), lista över kommuner med avtal. 404 vid okänd slug.
- Kommun-sidans "Nämnda leverantörer"-taggar blir länkar till
  `/leverantor/:slug` när namnet matchar en vendor (case-insensitive);
  annars förblir de rena taggar.
- Oanalyserade PDF:er och `is_contract = 0`-PDF:er visas som idag i
  "Mottagna avtal" men utan leverantörsdata.

## Felhantering

- `/attachments/:id`: alla felfall → 404.
- `analyse-contract`: API-/nätverksfel → `null`, varning till stdout,
  attachmenten förblir oanalyserad och plockas upp av nästa körning.
- `/leverantor/:slug` okänd → 404 med samma stil som kommun-404.

## Testning (offline, enligt befintligt mönster)

- **`analyse-contract`:** fake-client (som `analyse-message`-testerna) —
  verifierar request-form (document-block, schema) och parsning/null-fallback.
- **Lagring:** tmp-sqlite — vendor-dedup (case-insensitive), produkt-koppling,
  idempotens (`attachment_id UNIQUE`), `--force`-beteende.
- **Dashboard:** seedad tmp-sqlite + `app.listen(0)`-helpern i
  `tests/dashboard.test.js`:
  - `/attachments/:id` serverar fil med rätt headers; 404 på okänt id;
    404 på `saved_path` utanför contractsDir.
  - Kommun-sidan innehåller `href="/attachments/…"` i både tabell och tidslinje.
  - `/leverantorer` listar seedade vendors; `/leverantor/:slug` visar avtal
    med fil-länkar; okänd slug → 404.

## Utanför scope

- Manuell merge/redigering av leverantörer i UI:t.
- Omanalys-knapp i UI:t (använd `--force`-scriptet).
- OCR för skannade PDF:er utan textlager (Claudes PDF-stöd hanterar även
  bildbaserade sidor, så detta är sannolikt inte ett problem).
