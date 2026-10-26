# Customer research: kommuner as buyers of edtech

Research date: 2026-10-26. Segment: kommun buyers (upphandlare/inköp, IT- and digitaliseringsstrateger, skolchef/förvaltningschef, ekonomer) plus intermediaries (SKR, Adda, Sambruk, regional collaborations). API endpoints marked "tested" were called live on 2026-10-26.

## TL;DR

- **Nothing on the market answers "am I paying the right price for this edtech product?"** The only official cost figure is Kolada/SCB *lärverktyg kr/elev*. That one number lumps together books, school library staff, computers, sewing machines, field trips and software. Skolinspektionen wrote that "Det finns ingen officiell statistik över skolors eller huvudmäns kostnader för läromedel". In June 2024 the government asked Skolverket to develop that statistic, and it has not been published yet.
- **The open data needed for normalization exists, is free, and is machine-readable.** Skolverket SIRIS gives pupils per årskurs per school, with kommunal vs fristående huvudman. Skolverket's PxWeb gives kommun comparison figures. Kolada has the SKR 9 kommungrupper and RKA "Liknande kommuner grundskola" peer sets, one per kommun. SCB PxWeb v2 has population by age.
- **There is evidence of pain, but it is mostly about data lock-in, failed platforms and spending variation.** I found no audit that names "overpaying for licences". That gap is a market opening, but it also means overpayment is not yet a proven pain. Validate it in interviews.
- **Main sensitivities:** staff names and signatures in the avtal, comparisons that look unfair (size class, segments, what the contract covers), and small-sample "league tables". Contract prices are public by default under OSL 31:16, but price appendices are sometimes masked.

---

## 1. How kommuner benchmark costs today

| Tool | Owner | What it gives | Digital tools? |
|---|---|---|---|
| **Kolada** (kolada.se, API v3) | RKA (state + SKR) | 4,000+ KPIs per kommun/year; peer groups | Only the aggregate **N15012 "Kostnad för lärverktyg i kommunal grundskola åk 1-9, kr/elev"**, N17011 (gymnasie), N18031/N18038 (anpassad). Uppsala 2025: 5,131 kr/elev (tested) |
| **KKiK – Kommunens kvalitet i korthet** | SKR/RKA, ~170 kommuner | Short KPI set (e.g. N15027 grundskola F-9 kr/elev) for annual reports ([Laxå KKiK](https://kommun.laxa.se/download/18.1dc3245c18ec64f0b83495de/1713766901943/Resultatrapport%20KKik%202022.pdf), [Alingsås KKiK](https://www.alingsas.se/wp-content/uploads/2023/05/Kommunens-kvalitet-i-korthet-2022-slutlig-2.pdf)) | No |
| **"Vad kostar verksamheten i din kommun" (VKV)** | SKL/SCB | Discontinued as a book in 2013; its key figures moved into Kolada and SCB's Räkenskapssammandrag ([SKR](https://skr.se/download/18.45167e4317e2b341b24bb5b6/1642784019747/7585-069-6.pdf)) | No |
| **RKA effektivitet / referenskostnad** | RKA | Cost vs result, and the structure-adjusted "referenskostnad" (based on kostnadsutjämningen) ([RKA effektivitet](https://skr.se/download/18.6ae4964b17ff33de77299de/1649147152522/RKA-Effektivitet-kommun-2022-2-TGA.pdf), [Piteå](https://pitea.se/Bokhyllan/Protokoll%20-%20n%C3%A4mnder/Barn-%20och%20utbildningsn%C3%A4mnd/Protokoll/Arkiv/2019/2019-09-05/%C2%A7%2098%20F%C3%B6rdjupad%20analys%20kring%20SCBs%20statistikuppgifter.pdf)) | No |
| **Skolverket kostnadsstatistik** | Skolverket/SCB | Per kommun and skolform: total, undervisning, lokaler, måltider, **lärverktyg**, elevhälsa, övrigt per elev. Only kommunal huvudman, because of sekretess. Example: Uppsala 2024, lärverktyg 5,000 kr/elev of 132,800 total (SIRIS, tested) | Aggregate only |
| **Läromedelsbarometern** | Läromedelsföretagen (industry body) | League table of kr/elev spent on läromedel per kommun, built from **Läromedia's** sales data + SCB. 2021: national 859 kr/elev, Göteborg 2,049, Grästorp 63; 2022 spread max−min 1,578 kr/elev ([Skolporten](https://www.skolporten.se/nyhetskategori/laromedel/page/10), [Österåker motion](https://www.osteraker.se/download/18.5ec6f72518715471397bf2b/1696344973260/28.%20Bilaga%202.%20Motion%20nr%201%202023.pdf)) | Partly. Covers one reseller's channel only, no product-level unit prices |
| **Adda ramavtal** | Adda (SKR) | Digitala läromedel 2022: Atea, LäroMedia, Skolon. Pricing is publisher list prices minus a per-reseller discount ("rabattsatser per leverantör"; reported figures 0–5.7%, which I could not verify because the PDF is now empty). Avrop via fördelningsnyckel ([Adda avropsvägledning](https://adda.se/globalassets/1-upphandling-ramavtal/skola-kultur-fritid/utbildning-larande/laromedel-2022/digitala/avropsvagledning-digitala-laromedel-2022.pdf), [Täby tjänsteutlåtande](https://doc.taby.se/handlingar/Barn-%20och%20grundskolen%C3%A4mnden/2023/2023-02-08/Handlingar/04.%20Tj%C3%A4nsteutl%C3%A5tande%20digitala%20l%C3%A4romedel.pdf)). New "Digitala läromedel 2026" from 2027-02-01, four years, Skolon is one of three suppliers, ~70% of kommuner connected ([TED](https://ted.europa.eu/en/notice/329929-2026/pdf), [Placera](https://www.placera.se/telegram/skolon-skolon-far-nytt-fyraarigt-ramavtal-med-adda-20260908)) | Sets discounts only. Says nothing about which products, how many licences, kommunlicens deals, or what peers actually pay |
| **"Kommuner like me"** | SKR 9 kommungrupper (2023) ([SKR PDF](https://primarvardskvalitet.skr.se/download/18.ef4ba7d1849a2f55db2898a/1669978414789/Kommungruppsindelning-2023.pdf)); Kolada "Liknande kommuner grundskola, <kommun>, <år>" (7 peers each, 290 groups, RKA) | Peer sets | Usable as-is for our peer logic |

**What is missing for digital tools specifically:**
1. Product-level spend. Lärverktyg mixes hardware, books, library staff and software. SKR and Konkurrensverket asked in 2021 for läromedel to be reported separately ([SKR remissvar](https://webbutik.skr.se/download/18.117b327517db288a7c823188/1639744937176/WEBB-15-21-01195-Remissyttrande-Laromedelsutredningen-bockernas-betydelse-och-elevernas-tillgan-till-kunskap.pdf)). The government gave Skolverket the task in June 2024 ([regeringen.se](https://regeringen.se/pressmeddelanden/2024/06/regeringen-vill-fa-battre-statistik-om-skolbibliotek-och-kostnader-for-laromedel/)). I found no publication yet, and even when it lands it will not be at product level.
2. Unit prices (kr per licence/elev/year) and pricing models (kommunlicens vs per-school vs per-elev).
3. Which products peers use, and functional substitutes.
4. Contract terms: period, renewal, indexation, exit, data portability.
5. The software layer outside läromedel: lärplattform, skoladmin, prov, stödverktyg. No current source tracks it at all.

## 2. Open data to join for normalization

| Need | Source | How to fetch (tested unless noted) | Format / cadence / licence |
|---|---|---|---|
| **Pupils per årskurs per school, with huvudman type** (kommunal vs fristående), kommun code, huvudman orgnr | Skolverket **SIRIS export API**, export 6 "Grundskola – Antal elever per årskurs" | `https://siris.skolverket.se/siris/reports/export_api/runexport/?pFormat=json&pExportID=6&pAr=2025&pKommun=0380` (pAr = start year of läsår; omit pKommun for all) | JSON (also xml/csv via pFormat). Measured 15 Oct, published ~Feb (leg_uttag 2026-02-10 for 2025/26). Cells under 5 pupils masked "..", missing shown as ".". Open public data. Formal licence not stated in the API; Skolverket open data is normally CC0/free reuse, so verify |
| Gymnasieskola pupils per kommun & skolår, by huvudman | SIRIS export 57 (58 per program, 70 per inriktning) | `...runexport/?pFormat=json&pExportID=57&pAr=2025&pKommun=0380` | same |
| **Kommun cost per elev incl. lärverktyg** | SIRIS exports 32 (grundskola), 33 (gymnasie), 34 (förskola), 37 (förskoleklass), 42–48 (komvux/sfi) | `...runexport/?pFormat=json&pExportID=32&pAr=2024&pKommun=0380` | Annual, calendar year, kommunal regi only |
| Kommun comparison tables (elever, skolenheter, förskola barn, komvux) | Skolverket **PxWeb** statistikdatabas | Tree: `https://statistikdatabasen.skolverket.se/PxWeb/api/v1/sv/Skolverkets_statistikdatabas/Kommunala_jamforelsetal/` → Forskola/Grundskola/Gymnasieskola/Komvux/... ; table e.g. `.../Grundskola/Skolor_och_elever/Grundskola_skolor_elever.px` (GET = metadata, POST JSON query = data) | PxWeb JSON/CSV/px. Annual. Use this for **förskola** (Barn_och_grupper) and **komvux** (Elever_och_kursdeltagare) |
| School register (codes, status, huvudman) | Skolenhetsregistret API v2 | `https://api.skolverket.se/skolenhetsregistret/v2/school-units` | JSON, live |
| Per-school statistics (rounded pupil totals, teacher ratios) | Planned Educations API v3 | `https://api.skolverket.se/planned-educations/v3/school-units/{code}/statistics/gr` with header `Accept: application/vnd.skolverket.plannededucations.api.v3.hal+json` | Totals are rounded ("cirka 160"), so use SIRIS for counts |
| **Kolada KPIs** (lärverktyg kr/elev, pupils, invånare) | Kolada API v3 (Swagger: https://api.kolada.se/v3/docs) | `https://api.kolada.se/v3/data/kpi/N15012/municipality/0380/year/2023,2024,2025`; KPI search `https://api.kolada.se/v3/kpi?title=lärverktyg`. Useful IDs: N15012, N17011, N15008 (kommunal grundskola kr/elev), N15809 (elever kommunal grundskola åk1-9), N17800 (gymnasieelever hemkommun), N11730 (inskrivna förskola kommunal regi), N01951 (invånare) | JSON, no key, paginated (`page`, `per_page`), `from_date` for deltas. Kolada data is free to reuse; check the terms on kolada.se |
| **SKR kommungrupp (9 groups)** | SCB-hosted xlsx | `https://www.scb.se/contentassets/c4b8142033a9440ca53725ca32321a74/kommungruppsindelning-2023.xlsx` (200 OK). Also in Kolada as groups G92786–G92794, e.g. `https://api.kolada.se/v3/municipality_groups?title=Storstäder` → G92787 (Stockholm, Göteborg, Malmö) | Revised roughly every 6 years (2017, 2023) ([SCB page](https://www.scb.se/hitta-statistik/regional-statistik-och-kartor/regionala-indelningar/funktionella-regioner-och-kommungrupper/)) |
| **Peer set "Liknande kommuner grundskola"** | Kolada/RKA | `https://api.kolada.se/v3/municipality_groups?title=Liknande kommuner grundskola` → 290 groups (e.g. G36106 Uppsala 2025, 7 members). Also "Liknande kommuner socioekonomi" | Annual |
| **Population by age** (0–5, 6–15, 16–19, adult) | SCB PxWeb API v2 | Search: `https://api.scb.se/OV0104/v2beta/api/v2/tables?query=folkmängd kommun ålder&lang=sv` → TAB5557 (2025), TAB638 (1968–2024), TAB6471 (monthly to 2026M08) | JSON/CSV, CC0 (SCB open data) |
| Official pupil count statistics | SCB/Skolverket "Grundskolan: elever per 15 oktober" ([SCB UF0104](https://www.scb.se/UF0104)) | Background/definitions | Annual |
| Third-party mirror | Skolkoll (per-school per-årskurs JSON/CSV from SIRIS) ([skolkoll](https://skolkoll.se/en/open-data/elevantal-arskurs/)) | Not needed, go to the source. Note that Skolkoll already publishes kommun reports, so it is an adjacent player | |

**Normalization notes**
- Kommun contracts cover **kommunal regi** pupils, not fristående. Use huvudman type = Kommunal from SIRIS (or Kolada N15809), not hemkommun totals.
- Segment-match the denominator to the contract's covered grades: F–3, 4–6, 7–9, gy, förskola, komvux. Förskoleklass is not in SIRIS export 6; take it from PxWeb/Kolada.
- Use the same läsår as the contract year. Elevantal is 15 Oct; costs are calendar year.

## 3. Pain points and evidence

- **No official cost statistics on läromedel.** Rektorer hold the budgets, levels vary by school, and some huvudmän are moving to central/kommun-wide licences while teachers fear losing influence ([Skolinspektionen 2021](https://www.skolinspektionen.se/globalassets/02-beslut-rapporter-stat/granskningsrapporter/tkg/2021/kvalitetssakring-och-val-av-laromedel/slutrapport-kvalitetssakring-och-val-av-laromedel.pdf), pp. 13, 18, ~30).
- **Large spread between kommuner** in kr/elev on läromedel: 63 to 2,049 kr/elev in 2021, and a 1,578 kr/elev max−min gap in 2022 (Läromedelsbarometern via [Skolporten](https://www.skolporten.se/nyhetskategori/laromedel/page/10)). Österåker politicians used this to argue for more money ([motion](https://www.osteraker.se/download/18.5ec6f72518715471397bf2b/1696344973260/28.%20Bilaga%202.%20Motion%20nr%201%202023.pdf)).
- **Per-school buying vs kommunlicens.** Luleå estimated >9 MSEK for per-school licences vs ~3 MSEK for a kommunlicens for one publisher's material ([Vårt Luleå](https://www.vartlulea.se/arkiv/aktuellt/skolantestargemensamlicenseffektivareochbilligare.5.75652f30174bfa2229018ad0.html), search summary; the page failed TLS on fetch). Eskilstuna keeps an approved list with kommunlicens vs school-bought, explicitly "undvika onödiga licenser", and notes overlap with NE360 ([Eskilstuna](https://pedagog.eskilstuna.se/pedagog-eskilstuna/digitala-resurser/godkanda-och-icke-godkanda-resurser)). Sundsvall runs a request form for new kommunlicenser ([Sundsvall](https://sundsvall.se/kommun/utbildning-och-forskola/kvalitet-och-utveckling/pedagog-sundsvall/digitala-larresurser)). Skolon onboarding templates include "vi gör en inventering av vilka licenser vi har ... på just er skola" ([Skolon](https://support.skolon.com/sv/kb/articles/pdf/information-till-skolledare-rektorer-mailmall)). Together these show licence sprawl and duplication across schools.
- **Vendor lock-in and data exit costs.** Malmö paid 13.75 MSEK in a settlement after extracting historical pupil data from a system it no longer licensed. Kramfors paid its vendor to get its own data out. Schools run 10–30 systems that do not talk to each other ([Vi Lärare/Skolvärlden 2021](https://www.vilarare.se/nyheter/i-skolan/it-snurren-skolor-tvingas-betala-for-att-ta-del-av-egen-data/)).
- **Platform failures.** Stockholm's Skolplattformen cost >1 BSEK since 2012 and is being scrapped. The replacement costs about a fifth, built on standard products ([SVT](https://www.svt.se/nyheter/lokalt/stockholm/hart-kritiserad-skolplattform-skrotas), [Skolporten](https://www.skolporten.se/?p=782107)), and a GDPR sanktionsavgift of 4 MSEK was upheld ([Realtid](https://www.realtid.se/tag/skolplattformen/)).
- **Audits exist but are generic.** PwC's Härryda 2022 audit of grundskola digitalisation found internal control "inte fullt ut tillräcklig" but did not look at licence cost ([Härryda](https://kultur.harryda.se/download/18.2d31670c186a1b2ae437f6b/1678790768829/Revisionsrapport%20Digitalisering%20i%20grundskolan%20H%C3%A4rryda%202022.pdf)). Österåker followed up a 12 MSEK digital/läromedel package ([Österåker](https://www.osteraker.se/download/18.5ec6f72518715471397ee5/1681231692803/6.%20Bilaga%201%20Rapport%20politisk%20satsning%20p%C3%A5%20l%C3%A4romedel%20och%20digitala%20verktyg.pdf)). Uppsala answered an interpellation on digital analysis tools, where three schools continued after a pilot ([Uppsala](https://www.uppsala.se/contentassets/211a94b726b142d1ad557df4d8333d62/36.1.-svar-interpellation-om-digitala-analysverktyg-i-grundskolan.pdf)). **I found no revisionsrapport, JO decision or Konkurrensverket action specifically about overpaying for edtech licences.** Treat that as unproven.
- **New money raises the stakes.** The statsbidrag for läromedel was 755 MSEK in 2025, aimed at one book per elev and subject ([regeringen](https://regeringen.se/artiklar/2024/09/regeringens-budgetsatsningar-pa-skolan-2025/)), and the national policy has swung from screens to books. Buyers need to show that the money went to the right things and at the right price.
- **Procurement churn.** The Adda 2022 → 2026 switch happens 2027-02-01, so every connected kommun re-avropar in 2026–27, and contracts with Atea/LäroMedia/Skolon get re-papered. That is the moment price benchmarks matter most.

## 4. Top 12 questions a kommun buyer would bring (ranked)

Legend: **NOW** = answerable from the current dataset + open data; **PART** = answerable with caveats; **EXTRA** = needs more data.

| # | Question | View / metric | Data needed | Status |
|---|---|---|---|---|
| 1 | Do we pay the right price for product X compared with kommuner like us? | Product page: our kr/elev/år vs peer distribution (median, IQR, n), peers = same SKR kommungrupp and/or Kolada "Liknande kommuner", same segment | Annual value (62% known), covered segment, kommunal-regi elever per segment (SIRIS) | **PART**. Only where n ≥ 5 priced contracts for the product |
| 2 | Which other kommuner use product X, and since when? | Adoption list/map, start year, renewal status | Vendor/product/period (82%) | **NOW** |
| 3 | What do similar kommuner use for category Y (LMS, skoladmin, prov, stödverktyg)? | Category × peer-group matrix: share of peers per product | Category tagging + peer groups | **NOW** |
| 4 | Which products do the same thing as X? | Substitute list per category with typical kr/elev and pricing model | Functional taxonomy (curated KB exists for vendors) | **PART**. Taxonomy needs depth beyond category |
| 5 | What pricing model is normal, and what does a kommunlicens cost vs per-elev? | Pricing-model mix per product; kommunlicens kr/elev vs per-school | Pricing model field + unit prices | **PART**. Unit prices are sparse |
| 6 | When do our and our peers' contracts expire? When should we tender? | Renewal calendar (own + peers); "expiring next 12 months" | Period/renewal (82%) | **NOW** for own, **PART** for peers (82%) |
| 7 | Direct from vendor or via Skolon/Läromedia/Adda/Atea: which is cheaper for X? | Same-product price split by channel | Direct vs reseller flag + value | **PART**. Needs n per channel |
| 8 | How much do we spend on digital tools in total vs peers, and per elev? | Total edtech kr/elev (kommunal regi) vs peers, next to Kolada N15012 lärverktyg | Complete contract set per kommun, + Kolada | **PART**. Only for kommuner where coverage is complete; must show completeness |
| 9 | Are we paying twice for overlapping tools (same category, several products)? | Overlap view: categories with ≥2 active products, with the sum | Category + active periods | **NOW** at kommun level; **EXTRA** at school level (contracts rarely list schools) |
| 10 | How do prices develop over time (indexation, renewals)? | Price-per-elev time series per product, renewal uplift % | Repeated contracts for same kommun-product | **PART**. Needs multiple years per pair |
| 11 | What terms do peers get (exit, data export, GDPR/PUB, price lock, indexation)? | Clause comparison per product | Clause extraction (not in current schema) | **EXTRA** |
| 12 | Do we actually use what we pay for? | Paid licences vs elever in segment; paid vs active users | Licence counts (some) + usage data from vendor/Skolon | **EXTRA**. Usage is not in avtal. Paid-vs-elever is a **PART** proxy |

The minimum product for an upphandlare is #1, #2, #3, #6. IT-strateger care most about #3, #4, #9, #11. Ekonomer and skolchefer care about #8, #9, #12.

## 5. Sensitivities and fair presentation

**What kommuner will object to**
- **Personal data.** Avtal carry names, signatures, emails and phone numbers of staff (skolchef, upphandlare, rektor, vendor contacts). They are public documents, but republishing them in a commercial database is a GDPR question. Strip all personal names and contact details from the studio and show role titles only. Never surface who signed.
- **Price confidentiality claims.** OSL 31:16 presumes openness ("rakt skaderekvisit"), but courts have upheld masking of price appendices ([KamR Göteborg 2764-19](https://fojo.se/dokument/offentlighetsjouren/2764-19-Go%CC%88teborg.pdf), [HFD 7674-23](https://domstol.se/globalassets/filer/domstol/hogstaforvaltningsdomstolen/2024/domar-och-beslut/7674-23.pdf), [HFD 5887-16](https://www.domstol.se/globalassets/filer/domstol/hogstaforvaltningsdomstolen/2017/mal-nr-5887-16.pdf)). Vendors, not kommuner, will push back hardest. Record whether a price was masked, and never infer a masked price.
- **Naming and shaming.** A "most expensive kommun" ranking will trigger defensive reactions and possibly press. Show a kommun its own position privately. Other kommuner appear as anonymous peer distributions unless the buyer explicitly asks for named, public-record contracts.
- **Comparing unlike things.** A kommunlicens covering F–9 plus a teacher module is not the same as a 4–6 single-subject licence. A misleading comparison will kill trust fast.
- **Internal politics.** Rektor-level budget autonomy vs central purchasing (Skolinspektionen). A tool that shows "duplicate tools across schools" can be read as an attack on rektorer.
- **Data honesty.** 62% of values are known. Unknown must not be read as zero or as cheap.

**How to present fairly**
1. Peer definition shown on every chart: SKR kommungrupp, Kolada "Liknande kommuner grundskola", or a size band (kommunal-regi elever). Let the user switch.
2. Normalize per elev **in the segments the contract covers**, kommunal regi only, same läsår. Show the denominator.
3. Compare like with like: same product, same scope (segments, modules), same pricing model. Flag mixed scope.
4. Always show **n** (contracts, kommuner), the range/IQR and the median, not just the mean. Suppress below n = 5, matching Skolverket's own masking rule of thumb.
5. Show a confidence/completeness label per figure: share of value known, share of the kommun's contracts collected, date of latest contract.
6. Show annual value with its derivation (stated vs computed from total/period) and note excl/incl moms.
7. Source link to the underlying public avtal and diarienummer, so any figure can be checked.
8. Offer kommuner a right of reply/correction channel. It builds goodwill and improves the data.

## Open questions to validate in interviews
- Is "overpaying" a felt pain, or is the real pain renewal timing, overlaps, and exit/data terms? No public audit names overpayment.
- Who holds the budget? Central IT/digitalisering vs förvaltning vs rektor. This decides the buyer persona.
- Would SKR/Adda, or a regional collaboration (e.g. Skåne Nordost's joint läromedel procurement, [TED](https://ted.europa.eu/en/notice/606031-2023/pdf)), buy or distribute the studio for members? Sambruk has ~145 members ([Sambruk](https://www.regeringskansliet.se/contentassets/d818e658071b49cbb1a75a6b11fa725d/sambruk.pdf)). I found no edtech procurement by Inera or Sambruk.
