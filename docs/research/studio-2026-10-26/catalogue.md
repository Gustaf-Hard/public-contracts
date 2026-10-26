# Leverantörs- och produktkatalog: förslag

Underlag: snapshot `snap2.db` (228 vendor-rader, 2 105 contracts, 1 877 products, 2 407 line items, 9 139 coverage-rader). Ingen ändring i repo eller live-system. Byggskript och regler: `research/work/catalogue-def.mjs` (katalogen) och `research/work/build.mjs` (klassning), körbara igen med `node build.mjs`.

Filer:
- `catalogue.json`: 106 företag, 199 produkter.
- `catalogue-mapping.json`: `vendors` (alla 228 råa leverantörsnamn) och `names` (alla 2 525 råa produktnamn från products, line items och coverage). När samma namn tolkas olika beroende på leverantör (66 namn, t.ex. "Rabatt" eller "Lärplattform") finns `byVendor`.

## Modellen

| Typ (`kind`) | Vad det är | Exempel |
|---|---|---|
| `company` | En leverantör. `role: service` säljer egna produkter, `role: channel` säljer andras (Atea, Adda, Dustin, Läromedia, mediecentraler). | Tietoevry, Atea |
| `product` | Något med ett namn och ett pris som en kommun köper. En produkt har en ägare, aldrig två. | Edlevo, Polyglutt, Exam.net |
| `addon` | Tilläggstjänst: införande, utbildning, konsulttid, support, drift, integrationer, inloggning, SMS, arkiv, migrering. Raden har `addon` (tjänstetyp) och, när den går att se, `for` (vilken produkt den gäller). | "Införande Edlevo elevregister förskola" → Införande och uppstart, for: Edlevo |
| `discount` | Rabatt, avdrag, kostnadsfria månader, avräkning. Behåller produkten om raden nämner en. | "Rabatt Polyglutt skola" → discount, Polyglutt |
| `segment` | Skolform, årskurs eller licensform utan eget produktnamn. Pekar på leverantörens huvudprodukt när det finns en. | "Kommunlicens" hos Haldor → Haldor Education; "Pedagoglicens" hos Prorenata |
| `noise` | Generisk beskrivning utan produkt ("Lärplattform" utan leverantör, "Programvaror"), hårdvara (datorer, Chromebooks, surfplattor) och återförsäljares volymrader. | "Övriga programvaror" (Dustin) |

Produktnamn är alltid utan segment: "Polyglutt skola F-3", "Polyglutt förskola Huvudmannalicens" och "Abonnemang Polylino skola" blir Polyglutt respektive Polylino. Editions (t.ex. Skolon Basic/Plus/Total, Microsoft 365 A1/A3/A5, Dugga Premium) ligger som `editions` på produkten, inte som egna produkter.

Enproduktsföretag (`singleProduct`, 39 st): Binogi, DigiExam, Haldor (Haldor Education), InfoMentor, Meitner, itslearning, Prorenata (ProReNata Journal), SLI (SLI Play), StudyBee, Quiculum, Musikoteket, Nomp m.fl. Allt hos dem som inte är rabatt eller tilläggstjänst blir den enda produkten.

## Regler, i den ordning de körs

1. **Leverantör → företag.** Normaliserat namn (gemener, å/ä→a, ö→o, skiljetecken bort, "AB"/"Sverige AB" bort) slås upp mot företagets `vendors`. Leverantörsrader som heter som en produkt slås ihop med ägaren (Skola24 → Nova Software, Matteappen → Radish, Exam.net och Kunskapsmatrisen → Teachiq, Aski Raski → ILT Education).
2. **Rabatt** (`rabatt|avdrag|kostnadsfri|gratis|kreditering|avräkning`) → `discount`.
3. **Vuxenutbildningsanordnare** (Hermods, Talenti m.fl.): alla rader är skolformer → `segment`.
4. **Rad som börjar med ett tjänsteord** (Integration, Införande, Implementering, Utbildning, Support, Migrering, Uppstart, Setup, Installation) → `addon`, oavsett vilken produkt den nämner.
5. **Företagets egna tillägg** (t.ex. Unikum Connect, Haldor EU-lagring, Prorenata PMO-överföring) → `addon`.
6. **Produktmatchning.** Varje produkt har två mönster: `m` som bara matchar produktens eget namn och får användas i alla leverantörers rader (så "Unikum" via Crayon eller "Polylino" via Skolon hittar ägaren), och `local` med generiska ord som bara gäller inom ägarens egna rader ("Elevregister" hos Tieto → Edlevo, "KM" hos Teachiq → Kunskapsmatrisen). Ordning: egna `m`, andras `m`, egna `local`. Matchad text maskeras så att en rad som nämner två produkter blir en `bundle` ("KM + Exam.net").
7. **Generiska tjänsteord** (införande, utbildning, konsult, support, drift, förvaltning, integration, SSO/BankID, SMS, migrering, arkiv...) → `addon`. Undantag: raden innehåller ett licensord (licens, abonnemang, årsavgift) och en produkt; då är det produktens pris ("Vklass-närvaro licens inkl support" → Vklass Närvaro). Text efter "inkl" gör inte en produktrad till tillägg.
8. **Bara ett företagsnamn** ("SchoolSoft" via Atea) → företagets huvudprodukt, annars `company`.
9. **Hårdvara** → `noise`.
10. **Bara segment- och licensord kvar** → `segment` med huvudprodukten.
11. **Licens- eller avgiftsrad utan produkt** ("Licensavgift", "Årlig licensavgift") → `segment` med huvudprodukten.
12. **Generisk beskrivning** ("Lärplattform", "Elevadministrativt system") → huvudprodukten bara om beskrivningen passar företagets kategori (en lärplattform ger aldrig ett provverktyg); annars `noise`.
13. Resten: okatalogiserad leverantör → produkt med städat namn och `uncatalogued: true`; katalogiserad → `unresolved: true` (2 namn kvar).

## Före och efter

| | Före | Efter |
|---|---|---|
| Leverantörsnamn | 228 | 144 rader → 102 katalogföretag med data; 84 okatalogiserade (1 avtal var, mest vuxenutbildningsanordnare och enstaka verktyg) |
| Katalogföretag | | 106 (88 service, 18 channel), varav 90 med minst 2 avtal |
| Råa produktnamn | 2 525 | 1 488 → 199 katalogprodukter; 650 → tilläggstjänster; 28 rabatt; 94 segment; 14 bara företagsnamn; 110 noise; 139 okatalogiserade produkter; 2 olösta |

Topp 20 företag (avtal = contracts kopplade till företagets alla vendor-rader):

| Företag | Avtal | Vendor-rader | Råa namn | Produkter | Tilläggsnamn | Segment | Rabatt | Andras produkter i raderna |
|---|---|---|---|---|---|---|---|---|
| ILT Education | 190 | 5 | 62 | 9 | 0 | 0 | 14 | 6 |
| Tietoevry | 105 | 4 | 297 | 2 (Edlevo, Lifecare) | 106 | 2 | 8 | 7 |
| Nova Software (Skola24) | 100 | 2 | 89 | 4 | 37 | 1 | 1 | 0 |
| Unikum | 85 | 2 | 197 | 5 | 64 | 4 | 1 | 8 |
| Skolon | 76 | 1 | 74 | 2 | 27 | 2 | 0 | 7 |
| SchoolSoft | 72 | 1 | 141 | 2 | 54 | 7 | 3 | 3 |
| Radish (Magma) | 64 | 3 | 15 | 2 | 0 | 0 | 0 | 0 |
| Nationalencyklopedin | 59 | 4 | 92 | 7 | 0 | 0 | 1 | 1 |
| IST | 53 | 1 | 165 | 11 | 61 | 2 | 0 | 2 |
| Binogi | 43 | 1 | 27 | 1 | 0 | 0 | 1 | 0 |
| Everway (Oribi) | 42 | 4 | 43 | 6 | 11 | 0 | 0 | 6 |
| Skolplus | 42 | 1 | 18 | 1 (+Rörelseäventyret i andra rader) | 0 | 0 | 0 | 0 |
| Teachiq | 41 | 3 | 12 | 2 | 0 | 0 | 1 | 0 |
| Atea | 36 | 1 | 89 | 0 (channel) | 13 | 2 | 0 | 20 |
| DigiExam | 34 | 1 | 44 | 1 | 5 | 1 | 0 | 0 |
| SLI Education | 33 | 2 | 9 | 1 | 0 | 0 | 0 | 0 |
| Infomentor | 30 | 1 | 40 | 1 | 27 | 0 | 0 | 0 |
| Prorenata | 27 | 1 | 71 | 1 | 25 | 21 | 0 | 0 |
| Symbolbruket | 26 | 1 | 11 | 3 | 3 | 0 | 0 | 0 |
| Vklass | 24 | 1 | 39 | 2 | 11 | 0 | 0 | 1 |

## Täckning

- **Avtal:** 1 588 av 1 672 contracts med leverantör (95,0 %) hamnar på ett katalogföretag; för `document_type = avtal` 1 587 av 1 671 (95,0 %). 433 contracts saknar vendor_id helt.
- **Line items:** 2 213 av 2 407 rader (91,9 %) blir katalogprodukt, eller tillägg/rabatt/segment hos ett katalogföretag. Räknat i kronor 76,9 %; nästan hela resten är ett Dustin-ramavtal ("Övriga programvaror" 40 Mkr, "Microsoft" 25 Mkr) som inte går att bryta ner på produkt.
- **Coverage:** 8 672 av 9 139 rader (94,9 %).
- **Products-tabellen:** 1 549 av 1 877 (82,5 %); resten är mest segment- och tjänsterader som extraktionen sparat som produkter.

## Tveksamheter

Sammanslagna, men bör bekräftas:
1. **Chas Visual Management → Unikum.** Chas Visual Management AB är, så vitt jag vet, bolaget bakom Unikum, och raderna är nästan bara Unikum-moduler. KB:n har Chas som konsultbolag.
2. **Oribi, Oribi Texthelp, Everway, Everway Technology → Everway** (Oribi och Texthelp bytte namn till Everway 2023).
3. **MV-Nordic → Vitec MV** (namnbyte).
4. **Learn-IT Umeå + Samverka.nu**: samma tjänst i raderna; företaget heter Learn-IT Umeå, produkten Samverka.nu.
5. **Slöjd.nu + Textila Idéateljén**: båda säljer Slöjdlexikon.
6. **LäraMera + LäraMera Program i Lund + Skoltavlan**.
7. **SpeedWARE → SpeedAdmin**.
8. **NE Sverige → Nationalencyklopedin**.
9. **Produktnamnbyten:** Procapita / Tieto Education → Edlevo; Extens → IST Administration; Matteappen → Magma; Novaschem → Skola24 Schema; FLOD (Mediecenter Mälardalen "FLOD EXT", "FLOD/SLI") → SLI Play.
10. **NE:s delar** (NE.se, Junior, Play, Ordböcker, Världens länder/religioner, Temapaket, Spelling with NE, Haja, NE Skola) → en produkt, NE Kunskapstjänster. E-språk, NE 360, NE Läromedel, AI-Martin, NE Digitala prov och Britannica School är egna produkter.
11. **Gleerups ämneslicenser** (tyska, spanska, franska, idrott och hälsa) → Gleerups digitala läromedel; namngivna serier (Utkik, Titano, MatteMax, Matematikportalen, Fokus, Entré) är egna produkter.

Inte sammanslagna:
12. **Wizkids och Everway.** Everway-rader säljer AppWriter och EduLife, vilket talar för att Wizkids ingår i Everway. Hålls isär.
13. **Claro Software.** ClaroRead m.fl. ligger under ett eget företag, Claro Software. Svensk TalTeknologi behandlas som svensk säljare; Everway säljer också ClaroRead.
14. **Selessia** (fakturerar Nomp Plus, kan vara Nomps juridiska bolag), **Bayou** (säljer "App förskola (Tyra)"), **Playalong** (egen vendor-rad, men också en modul hos StudyAlong), **Widgit** (Symbolbruket säljer Widgit Online), **Studi** (en rad "Språkprojektet" mappas till Binogi).
15. **WM-data** (Sofia, Treserva) är inte Tieto. Raderna lämnas okatalogiserade.

Taxonomival att ta ställning till:
16. **Polyglutt Home Access** är en egen produkt, som i KB:n; kan i stället vara ett tillägg till Polyglutt.
17. **Dugga AI Exam Engine** och **Skolup AI** är egna produkter, inte tillägg.
18. **Hej Syv:** HejSyv och Hej framtidsval är två produkter; kan vara en.
19. **Dexter** är skild från IST Lärande; **Unikum Flow** är en egen produkt (oklart vad den gör).
20. **Drift och support som huvudavgift.** Hos InfoMentor och SchoolSoft klassas "Drift"- och "Supportavtal"-rader som tillägg, fast de ibland är den löpande grundavgiften. `for` behåller kopplingen till produkten.
21. **Microsofts avtalsformer** (EES, Campus och School, Enterprise-registrering, Software Assurance) är `segment`, inte produkter.
22. **Återsålda partnertitlar hos ILT** (Zcooly, Tiki Reader, The English Minnits, TextIT Premium) och en vendorlös Ystad-beställning hos Läromedia (Vässa språket, Rik matematik, Ärtan Pärtan m.fl.) är okatalogiserade. Förlaget är okänt för flera av dem.
23. **Skolon** har `role: channel` som i KB:n men äger två produkter (Skolon, Skolup AI). Mediapoolen och GR (AV Media) är också channel med egna tjänster.
24. **Vuxenutbildningsanordnare** (Hermods, Bergstrands, Talenti, Agila Institutet) och **Upplands-Bro kommun** finns med bara för att de har minst 2 avtal. De har inga produkter och bör döljas i köparvyn.
25. Vendorlösa rader av typen "Lärplattform", "Elevadministrativt system" och "Införande" blir noise eller tillägg utan företag. 433 contracts har ingen vendor_id, så de kan inte attribueras.

## Rekommenderade regler för nya namn

1. **Spara typen på raden.** Line items och coverage bör få `kind` (product/addon/discount/segment), `addon_type` och `for_product`, och segmentet i en egen kolumn (skolform, årskurs, licensform). Produktnamnet ska aldrig bära "förskola", "F-3", "huvudmannalicens" eller "12 mån".
2. **Ge extraktionsprompten katalogen.** När leverantören är känd: ge LLM:en företagets produktlista och be den välja ett namn ur listan eller svara `null`. Rabatter blir egna rader med negativt belopp och `kind: discount`. Licensform och skolform blir egna fält.
3. **Skapa aldrig en produkt automatiskt.** Ett nytt namn som inte matchar hamnar i en granskningskö (`unresolved`/`uncatalogued`). En ny produkt finns bara när någon lagt in den i katalogen med ägare, kategori och en rad om vad den är.
4. **Två sorters alias per produkt.** Produktens eget namn (`m`) gäller i alla leverantörers rader. Generiska ord (`local`) gäller bara inom ägarens rader. "Lärplattform" får aldrig bli Unikum bara för att raden står på ett Chas-avtal om prov.
5. **Återförsäljare äger inga andras produkter.** Vendor = kanalen (Atea, Skolon, Läromedia), produktens företag = ägaren. Prisanalyser bör räknas per produktägare och kunna filtreras på kanal.
6. **Leverantörsrader som heter som en produkt** (Matteappen, Exam.net, Skola24, Aski Raski) slås upp via produktalias till ägaren innan en ny vendor-rad skapas.
7. **Tjänsteord vinner över produktnamn**, utom när raden är en licens- eller abonnemangsrad för produkten. Text efter "inkl" räknas inte.
8. **Generisk beskrivning → huvudprodukt bara när kategorin stämmer**, och bara för företag med en tydlig huvudprodukt (`defaultProduct`/`singleProduct`).
9. **Namnbyten är alias, inte nya produkter** (Procapita → Edlevo, Extens → IST Administration, Matteappen → Magma, Oribi → Everway). Historiska avtal behåller sitt råa namn i `aliases`.
10. **Följ de 2 olösta och 139 okatalogiserade namnen.** Det är arbetskön; resten av datan följer reglerna ovan.
