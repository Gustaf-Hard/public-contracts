# Ärende-resa: nästa steg, byt mottagare & prognos-tidslinje — design

**Datum:** 2026-06-10
**Status:** Godkänd design, väntar på implementationsplan

## Bakgrund

Kommun-sidan (`renderKommunDetail` i `src/dashboard-views.js`) är idag en
2-kolumnslayout: sticky vänster-sidebar (`.kommun-sidebar`) + huvudkolumn med
ärende-kort. Varje ärende-kort har en inbäddad meddelande-tidslinje
(`renderTimeline`).

Tre sammanhängande funktioner under temat **"vad händer härnäst för det här
ärendet"**:

1. **Byt mottagare** — kunna omdirigera ett ärendes `contact_email` (t.ex. till
   en handoff-adress kommunen angav), så att framtida utskick går rätt.
2. **Genererat nästa steg** — ett alltid närvarande, härlett förslag på nästa
   åtgärd per ärende.
3. **Prognos-tidslinje** — en polerad högerpanel som visar hela resan: det som
   hänt (känt) plus anticiperade framtida steg (gissade) hela vägen tills alla
   avtal är på plats.

## Layout (kommun-sidan blir 3 kolumner)

```
LEFT SIDEBAR            MAIN COLUMN                 RIGHT PANEL: "Resa"
identitet/status        ▸ Nästa steg-banner          ● 13 apr  Begäran skickad
personer                Mottagare: … [byt ▾][Byt]    ● 14 apr  Autosvar
e-post (källa-badge)    åtgärdsknappar               ● 14 apr  Hänvisning → BoU
leverantörer            (draft/escalering/             ┝━ ◉ NU · Behöver dig
snabbåtgärder            meddelandetexter)            ◌ ~16 jun Påminnelse (uppskattn.)
                                                     ◌ ~20 jun Bekräftelse
                                                     ◌ ~4 jul  Avtal levereras
                                                     ◌ ~8 jul  ✓ Alla avtal in
```

- `.kommun-page` grid blir `320px 1fr 360px` (sidebar | main | resa-panel).
  Vid `max-width: 1200px` faller resa-panelen under huvudkolumnen; vid
  `max-width: 980px` blir allt en kolumn (befintlig brytpunkt behålls).
- Resa-panelen är sticky som vänster-sidebaren.

### Primärt ärende

Panelen visar **ett** ärendes resa: det primära = mest nyligen aktiva
icke-terminala ärendet (`state_changed_at` desc bland icke-`TERMINAL_STATES`),
annars det mest nyligen ändrade ärendet. Har kommunen flera ärenden visas en
liten `<select>`-växlare högst upp i panelen (query-param `?case=<convId>`).
I praktiken har nästan alla kommuner ett ärende.

## Feature 1 — Byt mottagare

- **Storage:** `setConversationRecipient(convId, email)` — uppdaterar
  `contact_email` och stämplar ny nullable-kolumn `recipient_changed_at`
  (idempotent `ALTER TABLE` via PRAGMA-probe, som befintliga).
- **Route:** `POST /conversations/:id/recipient` med `{ email }`. Trimmar och
  validerar icke-tom adress innehållande `@`; uppdaterar; redirectar till
  `/kommun/:kod`. 404 om ärendet saknas, 400 på tom/ogiltig adress.
- **UI (huvudkolumn):** en "Mottagare"-rad i ärende-kortet: nuvarande adress +
  ett formulär med `<select>` av de sammanslagna kontakterna (`mergeContacts`,
  **handoff-adressen förvald** eftersom den har högst trust) plus ett
  fritext-`<input>`-alternativ, och en **Byt mottagare**-knapp.
- Alla utskick (escalation **Skicka** via `sendApprovedReply`, samt
  tick-dispatch) läser redan `conv.contact_email`, så de följer automatiskt med.

## Feature 2 — Nästa steg (deterministiskt)

- **Ren funktion** `nextStepSuggestion(conv, { openEsc, handoffContacts, followUp })`
  → `{ text, urgency }` (`urgency` ∈ `idle` | `waiting` | `action`). Härleds ur
  FSM-tillstånd + öppen eskalering + follow-up:
  - `INITIAL` → "Väntar på schemalagt utskick {scheduled_send_at}."
  - `SENT` (inget svar) → "Inväntar svar. Påminnelse skickas ~{date} om inget kommer."
  - `ACK_RECEIVED` → "Bekräftat. Inväntar handlingar; påminnelse ~{date}."
  - `AWAITING_PRECISION` → "Skicka precisering."
  - `NEEDS_HUMAN` + handoff → "Svara på hänvisningen — skicka till `{handoff_email}` (byt mottagare först)."
  - `NEEDS_HUMAN` (annars) → "Du måste agera — {escalationActionLabel}."
  - `DELIVERING` → "Avtal kommer in — bevaka tills alla mottagits, stäng när klart."
  - `DONE` → "Klart — alla handlingar mottagna." · `DEAD_END` → "Avslutat (återvändsgränd)."
- **UI (huvudkolumn):** en framträdande **"Nästa steg:"**-banner högst upp i
  ärende-kortet, färgad efter `urgency`. Konsoliderar den spridda
  `caseTooltip`/next-hint-logiken till en testad källa.

## Feature 3 — Prognos-tidslinje

### State-transition-logg (ny tabell)

```sql
CREATE TABLE state_transitions (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`updateConversationState` skriver en rad per faktisk tillståndsändring
(när `nextState !== conv.state`). Loggen byggs upp framåt.

### Prognosmotor (`src/forecast.js`, rena funktioner)

- `FORECAST_DURATIONS` — förväntat antal dagar per steg (skild från `STALE_RULES`
  som är *påminnelse*-trösklar): t.ex. `{ ack: 3, precision: 5, delivery: 14, close: 4 }`.
  Konstanterna är medvetet grova uppskattningar.
- `historicalMedians(transitions)` — median-dagar per `from_state→to_state` ur
  `state_transitions`. När en övergång har **≥5** sampel ersätter medianen
  konstanten för det steget.
- `forecastTimeline(conv, { now, durations })` → ordnad lista av **återstående**
  milstolpar med uppskattade ISO-datum, från nuvarande tillstånd genom varje kvar-
  varande steg fram till **avtal levererat / DONE** ("alla avtal där"). Varje
  milstolpe: `{ date, label, estimate: true }`. Terminala tillstånd → tom lista
  (inget kvar att förutspå).
- Hela prognosen märks **"uppskattning – få datapunkter"** tills medianer tagit
  över för de ingående stegen.

### Enhetlig resa-tidslinje (högerpanel)

- En ny `renderJourney({ conv, events, forecast, cases, selectedCaseId })` i
  `dashboard-views.js` ritar **en** vertikal tidslinje:
  1. **Förflutet** (`●`, solid) — de faktiska händelserna (samma data som
     `buildTimeline` ger: utgående/inkommande/bilagor), snyggt renderade med
     prickar på en vertikal linje.
  2. **NU-markör** (`◉`, framhävd) — nuvarande FSM-tillstånd ("du är här").
  3. **Framtid** (`◌`, streckad/dämpad) — `forecastTimeline`-milstolparna med
     `~`-datum, ned till terminalnoden **"✓ Alla avtal in / Klart"**.
- Visuellt: vertikal linje, solida prickar för förflutet, håldragna/streckade
  för prognos, distinkt NU-nod. Ny CSS-klass `.journey` (återanvänder
  `--good`/`--fg-muted`-paletten).
- Bilage-/avtalsnoder i förflutet länkar till `/attachments/:id` (befintligt).

## Arkitektur / filer

- **Nytt:** `src/forecast.js` — `FORECAST_DURATIONS`, `historicalMedians`,
  `forecastTimeline`, `nextStepSuggestion` (alla rena, testbara isolerat).
- **`src/storage.js`** — `recordStateTransition` (anropas i
  `updateConversationState`), `listStateTransitions()`, `setConversationRecipient`,
  `recipient_changed_at`-kolumn.
- **`src/dashboard.js`** — `POST /conversations/:id/recipient`; kommun-route
  väljer primärt ärende, bygger forecast + nästa steg, väljer `?case`.
- **`src/dashboard-views.js`** — `renderJourney` (högerpanel), nästa-steg-banner,
  mottagar-formulär, 3-kolumns-grid + CSS.
- **Byggordning:** F1 → F2 → F3 (F2:s text refererar F1:s mottagare; F3:s panel
  omsluter F2:s NU-tillstånd).

## Felhantering

- Byt-mottagare: tom/ogiltig adress → 400; okänt ärende → 404.
- Forecast på terminalt ärende → tom framtidslista; panelen visar bara förflutet
  + "Klart"-nod.
- Inga `state_transitions` än → `historicalMedians` tom → konstanterna används,
  prognosen märks som uppskattning.
- `getEffectiveNow`/`new Date()`: forecast tar `now` som parameter (testbart).

## Testning (offline)

- **`src/forecast.js`**: `nextStepSuggestion` per tillstånd; `forecastTimeline`
  projicerar rätt milstolpar/datum från ett givet `now`; terminalt → tomt;
  `historicalMedians` tar över vid ≥5 sampel, annars konstant.
- **Storage**: `recordStateTransition` skrivs vid faktisk ändring (inte vid
  no-op); `setConversationRecipient` uppdaterar + stämplar; `listStateTransitions`.
- **Dashboard**: `POST /conversations/:id/recipient` (lyckad/400/404); kommun-sidan
  renderar nästa-steg-banner, mottagar-select med handoff förvald, och en
  resa-panel som innehåller både förflutna händelser och `~`-prognosnoder;
  primärt-ärende-val + `?case`-växling.

## Utanför scope

- Retroaktiv historik (transition-loggen börjar tom; medianer aktiveras med tiden).
- Konfidensintervall/sannolikheter på prognosdatum (enbart punktestimat nu).
- Att förutsäga *antalet* avtal — terminalnoden är "alla avtal in / Klart",
  inte ett antal.
- Redigering av prognosen i UI:t.
