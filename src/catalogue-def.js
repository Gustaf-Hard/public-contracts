// Curated vendor and product catalogue for the studio (read-time only, no DB).
// Ported from docs/research/studio-2026-10-26/catalogue-def.mjs; the rules that
// read it live in src/catalogue.js. The back office keeps src/vendor-kb.js.
//
// Regexes run on normName(name): lowercase, å/ä->a, ö->o, é->e, ü->u, every
// non [a-z0-9] run -> one space.
// Product fields: m = brand-safe pattern (valid in ANY vendor's rows),
// local = extra pattern valid only inside the owning company's own rows.
// `category` here is the research taxonomy (incl. bedömning, integration,
// utbildningsanordnare); src/catalogue.js maps it onto the seven studio
// CATEGORIES. Rules read the research value, so keep it as is.
//
// Doubts from catalogue.md "Tveksamheter", with the decision applied (spec
// §6.1). Reverse any of them by editing the entry it names.
// Merged (applied):
//  1. Chas Visual Management -> Unikum (Chas is the company behind Unikum; the
//     KB lists Chas as a consultancy).
//  2. Oribi, Oribi Texthelp, Everway, Everway Technology -> Everway (renamed 2023).
//  3. MV-Nordic -> Vitec MV (rename).
//  4. Learn-IT Umeå + Samverka.nu: company Learn-IT Umeå, product Samverka.nu.
//  5. Slöjd.nu + Textila Idéateljén: both sell Slöjdlexikon.
//  6. LäraMera + LäraMera Program i Lund + Skoltavlan.
//  7. SpeedWARE -> SpeedAdmin.
//  8. NE Sverige -> Nationalencyklopedin.
//  9. Product renames are aliases: Procapita / Tieto Education -> Edlevo;
//     Extens -> IST Administration; Matteappen -> Magma; Novaschem -> Skola24
//     Schema; FLOD -> SLI Play.
// 10. NE's parts (NE.se, Junior, Play, Ordböcker, ...) -> one product, NE
//     Kunskapstjänster. E-språk, NE 360, NE Läromedel, AI-Martin, NE Digitala
//     prov and Britannica School stay separate products.
// 11. Gleerups subject licences -> Gleerups digitala läromedel; named series
//     (Utkik, Titano, MatteMax, Matematikportalen, Fokus, Entré) are products.
// Kept separate:
// 12. Wizkids and Everway (Everway rows sell AppWriter and EduLife).
// 13. Claro Software is its own company; Svensk TalTeknologi is treated as a
//     Swedish seller; Everway also sells ClaroRead.
// 14. Selessia (Nomp Plus), Bayou (Tyra app), Playalong (also a StudyAlong
//     module), Widgit (sold by Symbolbruket), Studi ("Språkprojektet" maps to
//     Binogi) are not catalogued as companies.
// 15. WM-data (Sofia, Treserva) is not Tieto; its rows stay uncatalogued.
// Taxonomy choices, as proposed:
// 16. Polyglutt Home Access is its own product (could be a Polyglutt add-on).
// 17. Dugga AI Exam Engine and Skolup AI are products, not add-ons.
// 18. HejSyv and Hej framtidsval are two products.
// 19. Dexter is separate from IST Lärande; Unikum Flow is its own product.
// 20. "Drift"/"Supportavtal" lines at InfoMentor and SchoolSoft are add-ons,
//     even when they are the running base fee.
// 21. Microsoft agreement forms (EES, Campus och School, Enterprise, Software
//     Assurance) are segments, not products.
// 22. ILT's resold partner titles (Zcooly, Tiki Reader, ...) and Läromedia's
//     vendorless Ystad order are uncatalogued (see MINOR_BRANDS).
// 23. Skolon keeps role: channel but owns two products (Skolon, Skolup AI);
//     Mediapoolen and GR are channels with their own services.
// 24. Adult-education providers (Hermods, Bergstrands, Talenti, Agila) and
//     Upplands-Bro kommun have no products: hiddenInStudio: true.
// 25. Vendorless "Lärplattform", "Elevadministrativt system", "Införande" lines
//     become noise or add-ons without a company.

const P = (name, category, what, m, local = null, extra = {}) => ({ name, category, what_it_is: what, m, local, ...extra });
const A = (name, m) => ({ name, m });

export const COMPANIES = [
  // ---------------- Läromedel ----------------
  { canonical: 'ILT Education', slug: 'ilt', category: 'läromedel', role: 'service', website: 'https://ilteducation.se',
    vendors: ['ilt education', 'ilt inlasningstjanst', 'inlasningstjanst', 'ilt', 'aski raski'],
    brand: /\bilt\b|inlasningstjanst/,
    defaultProduct: 'Inlästa läromedel',
    products: [
      P('Studiestöd på modersmål', 'läromedel', 'Inlästa läromedel och studiestöd på elevernas modersmål.', /studiestod pa modersmal/),
      P('Polyglutt Home Access', 'läromedel', 'Tillägg som ger barnens familjer tillgång till Polyglutt hemma.', /(polyglutt )?(forskola )?home access( polyglutt forskola hemma)?|polyglutt forskola hemma/),
      P('Polyglutt', 'läromedel', 'Digitalt bilderboksbibliotek för förskola och förskoleklass.', /polyglutt/),
      P('Polylino', 'läromedel', 'Digitalt bilderboksbibliotek för de yngre åren i grundskolan.', /polylino/),
      P('Begreppa', 'läromedel', 'Ämnesbegrepp förklarade med bild, ljud och text på flera språk.', /begreppa/),
      P('Aski Raski', 'läromedel', 'Lässpel för att lära sig läsa, F-3.', /aski ?raski/),
      P('Fonologia', 'läromedel', 'Digitalt läromedel för fonologisk medvetenhet och tidig läsinlärning.', /fonologia/),
      P('Trovy', 'läromedel', 'Digitalt bibliotek med inlästa skönlitterära böcker.', /trovy/),
      P('Inlästa läromedel', 'läromedel', 'Inlästa versioner av tryckta läroböcker, som ljud i appen.', /inlasta laromedel|ilt digital/, /^(kommun)?abonnemang|^kommunabonnemang|^inlasningstjanst$|\bil\b/),
    ] },
  { canonical: 'Radish', slug: 'radish', category: 'läromedel', role: 'service', website: null, probeLabel: 'Magma',
    vendors: ['radish', 'matteappen', 'radish magma'],
    brand: /radish|magma|matteappen/,
    defaultProduct: 'Magma',
    products: [
      P('Magma Insight', 'läromedel', 'Huvudmannaplattform med uppföljning av elevernas resultat i Magma.', /magma (insights?|huvudmannaplattform|kommunplattform)|(?<=och )insights?\b|(?<=och )magma insight/),
      P('Magma', 'läromedel', 'Digitalt matematikläromedel (tidigare Matteappen).', /matteappen( magma)?|magma( pedagogik)?/),
    ] },
  { canonical: 'Binogi', slug: 'binogi', category: 'läromedel', role: 'service', website: 'https://binogi.se',
    vendors: ['binogi'], brand: /binogi/, singleProduct: 'Binogi',
    products: [P('Binogi', 'läromedel', 'Digitalt läromedel med animerade ämnesfilmer och quiz på flera språk.', /binogi|sprakprojektet/)] },
  { canonical: 'Nationalencyklopedin', slug: 'ne', category: 'läromedel', role: 'service', website: 'https://ne.se', probeLabel: 'NE',
    vendors: ['ne', 'nationalencyklopedin', 'ne nationalencyklopedin', 'ne sverige'],
    brand: /\bne\b|nationalencyklopedin/,
    products: [
      P('NE 360', 'läromedel', 'Samlad plattform med NE:s kunskapstjänster och digitala läromedel.', /\bne ?360\b/, /\b360\b/),
      P('AI-Martin', 'läromedel', 'AI-baserad studiehjälp från NE.', /ai martin/),
      P('NE Digitala prov', 'prov', 'Färdiga digitala prov kopplade till NE:s läromedel.', /ne digitala prov/, /digitala prov/),
      P('Britannica School', 'läromedel', 'Engelskspråkigt uppslagsverk (Encyclopaedia Britannica) som NE säljer.', /britannica/),
      P('E-språk', 'läromedel', 'Digital språkträning i moderna språk och engelska.', /\be spr?ak\b/),
      P('NE Kunskapstjänster', 'läromedel', 'Uppslagsverket NE.se med Junior, Play, ordböcker och tematjänster.', /kunskapstjanst|ne skola|ne se\b|ne junior|ne play|ne ordbocker|ne fakta|ne internettjanst|spelling with ne/,
        /kunskapstjanst|uppslagsverk|\bjunior\b|\bplay\b|ordbo(k|cker)|spraklexikon|varldens (lander|religioner|klimat)|temapaket|haja|appar for de yngre|pedagogiska appar|filmtjanst|fria laromedel|ne bibliotek|norstedts|ordbokstjanst|ne nationalencyklopedin/),
      P('NE Läromedel', 'läromedel', 'NE:s digitala läromedel, även tryckta böcker med digitala delar.', /ne digitala laromedel/, /laromedel|laroboc?ker/),
    ] },
  { canonical: 'Skolplus', slug: 'skolplus', category: 'läromedel', role: 'service', website: 'https://skolplus.se',
    vendors: ['skolplus'], brand: /skolplus/, defaultProduct: 'Skolplus',
    products: [
      P('Rörelseäventyret', 'läromedel', 'Rörelsepass för de yngre eleverna från Skolplus.', /rorelseaventyret/),
      P('Skolplus', 'läromedel', 'Webbtjänst med övningar och spel i flera ämnen (Basutbud eller Komplett).', /skolplus|basutbud/, /komplett/, { editions: ['Basutbud', 'Komplett'] }),
    ] },
  { canonical: 'SLI Education', slug: 'sli', category: 'läromedel', role: 'service', website: 'https://sli.se',
    vendors: ['sli education', 'sli'], brand: /\bsli\b/, singleProduct: 'SLI Play',
    products: [P('SLI Play', 'läromedel', 'Strömmad utbildningsfilm och media för skolan.', /\bsli\b|\bflod\b/, /strommande media|mediedistribution/)] },
  { canonical: 'Natur & Kultur', slug: 'natur-kultur', category: 'läromedel', role: 'service', website: 'https://www.nok.se',
    vendors: ['natur kultur', 'natur och kultur'], brand: /natur (och )?kultur/,
    products: [
      P('PULS', 'läromedel', 'Läromedelsserie i NO, SO och teknik för åk 4-6.', /\bpuls (no|so|teknik)\b/),
      P('Flex Matematik', 'läromedel', 'Matematikläromedel för mellanstadiet.', /flex matematik/),
      P('Skills', 'läromedel', 'Engelskläromedel för mellanstadiet.', /\bskills ak\b/),
      P('Fördel', 'läromedel', 'Läromedel i svenska som andraspråk för nyanlända.', /fordel sva/),
      P('Lärarens guide till hem- och konsumentkunskap', 'läromedel', 'Lärarstöd i hem- och konsumentkunskap åk 4-6.', /hem o(ch)? konsumentkunskap/),
    ] },
  { canonical: 'Gleerups', slug: 'gleerups', category: 'läromedel', role: 'service', website: 'https://www.gleerups.se',
    vendors: ['gleerups', 'gleerups utbildning'], brand: /gleerups/, defaultProduct: 'Gleerups digitala läromedel',
    products: [
      P('Utkik', 'läromedel', 'SO-läromedel (och NO-ämnen) för grundskolan.', /\butkik\b/),
      P('Titano', 'läromedel', 'NO-läromedel för högstadiet.', /\btitano\b/),
      P('MatteMax', 'läromedel', 'Digitalt matematikläromedel.', /mattemax/),
      P('Matematikportalen', 'läromedel', 'Digitalt matematikläromedel F-9.', /matematikportalen/),
      P('Fokus', 'läromedel', 'Läromedelsserie i svenska, SO och NO för åk 1-3.', /\bfokus (svenska|so|no)\b/),
      P('Entré', 'läromedel', 'Läromedel i svenska som andraspråk.', /\bentre a\b/),
      P('Gleerups digitala läromedel', 'läromedel', 'Gleerups digitala läromedel per ämne eller i paket med alla ämnen.', /gleerups digitala laromedel|gleerups (tyska|spanska|franska|idrott)/, /^digitala laromedel$/, { editions: ['alla ämnen', 'per ämne'] }),
    ] },
  { canonical: 'Liber', slug: 'liber', category: 'läromedel', role: 'service', website: 'https://www.liber.se',
    vendors: ['liber'], brand: /\bliber\b/,
    products: [P('Liber Svenska', 'läromedel', 'Svenskläromedel för grundskolan, digitalt.', /liber svenska/)] },
  { canonical: 'Sanoma Utbildning', slug: 'sanoma', category: 'läromedel', role: 'service', website: 'https://www.sanomautbildning.se',
    vendors: ['sanoma', 'sanoma utbildning'], brand: /sanoma/,
    products: [
      P('Bingel', 'läromedel', 'Övningsplattform i matematik och svenska för F-6.', /bingel/),
      P('Lexia Provia', 'läromedel', 'Kartläggning och träning av läs- och skrivförmåga.', /lexia|provia/),
      P('Champ', 'läromedel', 'Engelskläromedel för grundskolan.', /\bchamp\b/),
      P('Milli Matematik', 'läromedel', 'Matematikläromedel för lågstadiet.', /milli matematik/),
    ] },
  { canonical: 'Studentlitteratur', slug: 'studentlitteratur', category: 'läromedel', role: 'service', website: 'https://www.studentlitteratur.se',
    vendors: ['studentlitteratur'], brand: /studentlitteratur/,
    products: [P('Förskoleforum', 'läromedel', 'Digital kompetensutvecklingstjänst för förskolans personal.', /forskoleforum/)] },
  { canonical: 'Clio', slug: 'clio', category: 'läromedel', role: 'service', website: 'https://www.clio.me',
    vendors: ['clio'], brand: /\bclio\b/, singleProduct: 'Clio',
    products: [P('Clio', 'läromedel', 'Digitala läromedel i många ämnen (paketet Mixa och Maxa).', /\bclio\b/, null, { editions: ['Mixa och Maxa'] })] },
  { canonical: 'Teachiq', slug: 'teachiq', category: 'prov', role: 'service', website: 'https://teachiq.com',
    vendors: ['teachiq', 'exam net', 'kunskapsmatrisen'], brand: /teachiq/,
    products: [
      P('Kunskapsmatrisen', 'bedömning', 'Verktyg för bedömning och återkoppling mot kunskapskraven.', /kunskapsmatris/, /\bkm\b/),
      P('Exam.net', 'prov', 'Plattform för säkra digitala prov.', /exam ?net/, /digital provplattform|digitala prov|provbank|it stod for undervisning prov/),
    ] },
  { canonical: 'Musikoteket', slug: 'musikoteket', category: 'läromedel', role: 'service', website: 'https://musikoteket.se',
    vendors: ['musikoteket'], brand: /musikoteket/, singleProduct: 'Musikoteket',
    products: [P('Musikoteket', 'läromedel', 'Digitalt läromedel i musik.', /musikoteket/)] },
  { canonical: 'Nomp', slug: 'nomp', category: 'läromedel', role: 'service', website: 'https://nomp.se',
    vendors: ['nomp'], brand: /\bnomp\b/, singleProduct: 'Nomp Plus',
    products: [P('Nomp Plus', 'läromedel', 'Matematikträning med filmer och övningar.', /\bnomp\b/)] },
  { canonical: 'Swedish Film', slug: 'swedish-film', productFirst: true, category: 'läromedel', role: 'service', website: 'https://www.swedishfilm.se',
    vendors: ['swedish film'], brand: /swedish ?film/, defaultProduct: 'Swedish Film-licens',
    products: [
      P('Film och Skola', 'läromedel', 'Strömningstjänst med spelfilm och utbildningsfilm för skolan.', /film och skola/, null, { editions: ['Spelfilm', 'Spelfilm Plus', 'Utbildningsfilm', 'Komplett'] }),
      P('Swedish Film-licens', 'läromedel', 'Licens för att visa film offentligt i skolan.', /swedish film|visningsratt/),
    ] },
  { canonical: 'Sveriges Utbildningsradio', slug: 'ur', category: 'läromedel', role: 'service', website: 'https://urplay.se',
    vendors: ['sveriges utbildningsradio'], brand: /utbildningsradio|\bur\b/, singleProduct: 'UR-program',
    products: [P('UR-program', 'läromedel', 'UR:s program och filmer för undervisning, enligt normalavtal.', /\bur (program|film)/)] },
  { canonical: 'Kide Science', slug: 'kide-science', category: 'läromedel', role: 'service', website: 'https://www.kidescience.com',
    vendors: ['kide science'], brand: /kide science/, singleProduct: 'Kide Science',
    products: [P('Kide Science', 'läromedel', 'Naturvetenskap och teknik genom lek för förskolan.', /kide science/)] },
  { canonical: 'Creaza', slug: 'creaza', category: 'läromedel', role: 'service', website: 'https://www.creaza.com',
    vendors: ['creaza'], brand: /creaza/, singleProduct: 'Creaza',
    products: [P('Creaza', 'läromedel', 'Digitala skapandeverktyg för film, serier och tankekartor.', /creaza/)] },
  { canonical: 'iMAL', slug: 'imal', category: 'läromedel', role: 'service', website: null,
    vendors: ['imal'], brand: /\bimal\b/, singleProduct: 'iMAL',
    products: [P('iMAL', 'läromedel', 'Digitalt läromedel.', /\bimal\b/)] },
  { canonical: 'LäraMera', slug: 'laramera', category: 'läromedel', role: 'service', website: 'https://www.laramera.se',
    vendors: ['laramera', 'laramera program i lund', 'skoltavlan'], brand: /laramera/, singleProduct: 'Skoltavlan',
    products: [P('Skoltavlan', 'läromedel', 'Pedagogiska program och övningar för interaktiv tavla och dator.', /skoltavlan/, null, { editions: ['Plus'] })] },
  { canonical: 'Slöjd.nu', slug: 'slojd-nu', category: 'läromedel', role: 'service', website: 'https://slojd.nu',
    vendors: ['slojd nu', 'textila ideateljen', 'textila ideateljen slojd'], brand: /slojd ?nu/,
    defaultProduct: 'Slöjdlexikon',
    products: [
      P('Slöjdlexikon', 'läromedel', 'Digitalt uppslagsverk med instruktioner för slöjd.', /slojdlexikon/),
      P('Slöjd- och bildportfolio', 'läromedel', 'Digital portfolio för elevarbeten i slöjd och bild.', /(slojd|bild)( och| )?(bild)?portfolio|slojdportfolio|bildportfolio/),
    ] },
  { canonical: 'NTA Skolutveckling', slug: 'nta', category: 'läromedel', role: 'service', website: 'https://www.ntaskolutveckling.se',
    vendors: ['nta skolutveckling', 'nta produktion och service'], brand: /\bnta\b/, singleProduct: 'NTA',
    products: [P('NTA', 'läromedel', 'Tema-lådor med material och lärarhandledning i naturvetenskap och teknik.', /\bnta\b/, /lador|lararhandledningar/)] },
  { canonical: 'Hej Syv', slug: 'hej-syv', category: 'stödverktyg', role: 'service', website: 'https://hejsyv.se',
    vendors: ['hej syv'], brand: /hej ?syv/,
    products: [
      P('Hej framtidsval', 'stödverktyg', 'Elevtjänst för studie- och yrkesval.', /hejframtidsval|hej framtidsval/),
      P('HejSyv', 'stödverktyg', 'Verktyg för studie- och yrkesvägledare.', /hej ?syv/),
    ] },
  { canonical: 'PictureMyLife', slug: 'picturemylife', category: 'stödverktyg', role: 'service', website: 'https://picturemylife.se',
    vendors: ['picturemylife'], brand: /picturemylife/, singleProduct: 'PictureMyLife',
    addOns: [A('Kom igång-paket', /kom igang/)],
    products: [P('PictureMyLife', 'stödverktyg', 'Digital bilddagbok som stöd för kommunikation.', /picturemylife/, /\bdagbok/)] },

  // ---------------- Stödverktyg ----------------
  { canonical: 'Everway', slug: 'everway', category: 'stödverktyg', role: 'service', website: 'https://everway.com',
    note: 'Oribi och Texthelp heter Everway sedan 2023.',
    vendors: ['oribi', 'oribi texthelp', 'everway', 'everway technology', 'ewerway'], brand: /oribi|everway|texthelp/,
    addOns: [A('Synk och provisionering', /provisionering|\bsynk\b|oribi idp|writeback/)],
    products: [
      P('LexiFlow', 'stödverktyg', 'Läs- och skrivstöd med talsyntes och ordprediktion.', /lexiflow/),
      P('SkrivaText', 'stödverktyg', 'Skrivstöd med rättstavning för svenska.', /skriva ?text/),
      P('Stava Rex', 'stödverktyg', 'Rättstavningsprogram för svenska.', /stava ?rex/),
      P('SpellRight', 'stödverktyg', 'Rättstavningsprogram för engelska.', /spell ?right/),
      P('Oribi Speak', 'stödverktyg', 'Talsyntes som läser upp text.', /oribi speak/),
      P('Oribi Habitat', 'stödverktyg', 'Samlat abonnemang på Oribis läs- och skrivverktyg.', /oribi habitat/),
    ] },
  { canonical: 'Wizkids', slug: 'wizkids', category: 'stödverktyg', role: 'service', website: 'https://wizkids.se',
    vendors: ['wizkids'], brand: /wizkids/,
    products: [
      P('AppWriter', 'stödverktyg', 'Läs- och skrivstöd för Chromebook, iPad och webb.', /appwriter/),
      P('TxtAnalyser', 'stödverktyg', 'Grammatik- och stilkontroll för skrivande.', /txtanalyser/),
      P('EduLife', 'stödverktyg', 'Administration och synk av Chromebooks och Google Workspace i skolan.', /edu ?life|fleet management|chromebook (tracker|mover)|classroom manager/),
    ] },
  { canonical: 'Claro Software', slug: 'claro', category: 'stödverktyg', role: 'service', website: 'https://www.clarosoftware.com',
    vendors: ['claro software'], brand: /\bclaro/,
    products: [
      P('Claro Valfrihet', 'stödverktyg', 'Paketlicens med alla Claros läs- och skrivverktyg.', /claro valfrihet/),
      P('ClaroRead', 'stödverktyg', 'Uppläsning och skrivstöd för PC, Mac och Chrome.', /claro ?read|claro ios|claro ?studieverktyg/),
      P('ClaroSpeak', 'stödverktyg', 'Uppläsningsapp för iOS och webb.', /claro ?speak/),
      P('ClaroIdeas', 'stödverktyg', 'Tankekartor med talstöd.', /claro ?ideas/),
      P('ClaroCapture', 'stödverktyg', 'Verktyg för att samla in och strukturera text.', /claro ?capture/),
      P('Claro BookReader', 'stödverktyg', 'Uppläsning av inskannade böcker och dokument.', /claro ?bookreader/),
      P('Claro AudioNote', 'stödverktyg', 'Anteckningar med ljudinspelning.', /claro ?audionote/),
      P('ScreenRuler', 'stödverktyg', 'Läslinjal på skärmen.', /screen ?ruler/),
    ] },
  { canonical: 'Svensk TalTeknologi', slug: 'svensk-talteknologi', category: 'stödverktyg', role: 'service', website: 'https://www.stt.se',
    note: 'Svensk återförsäljare av Claro-verktygen.',
    vendors: ['svensk talteknologi'], brand: /svensk talteknologi|\bstt\b/,
    products: [
      P('STT Valfrihet', 'stödverktyg', 'Paketlicens med STT:s läs- och skrivverktyg.', /stt valfrihet/),
      P('WordRead', 'stödverktyg', 'Uppläsning och skrivstöd för Mac.', /wordread/),
      P('SpeakIT', 'stödverktyg', 'Talsyntes som läser upp markerad text.', /speakit/),
    ] },
  { canonical: 'Vitec MV', slug: 'vitec-mv', category: 'stödverktyg', role: 'service', website: 'https://www.vitecmv.com/se',
    note: 'MV-Nordic heter Vitec MV.',
    vendors: ['vitec mv', 'mv nordic', 'vitec'], brand: /vitec|mv nordic/, defaultProduct: 'IntoWords',
    addOns: [A('Extra röster', /\brost\b|digital rost/)],
    products: [
      P('IntoWords', 'stödverktyg', 'Läs- och skrivstöd med uppläsning och ordprediktion på alla plattformar.', /intowords/, /las upp|las logg|las har|\bgrammatik\b/),
      P('CD-ORD', 'stödverktyg', 'Äldre läs- och skrivstöd för Windows.', /cd ord/),
      P('10Fingrar', 'stödverktyg', 'Träning i tangentbordsskrivning.', /10 ?fingrar/),
      P('Skanread', 'stödverktyg', 'App som skannar text och läser upp den.', /skanread/),
      P('Ordboken', 'stödverktyg', 'Digital ordbok med uppläsning.', /^ordboken$/),
      P('Precodia', 'stödverktyg', 'Ordprediktion för PC.', /precodia/),
      P('Den talande boken', 'stödverktyg', 'Uppläsning av läromedel i DTB-format.', /talande boken|dtb media/),
    ] },
  { canonical: 'Symbolbruket', slug: 'symbolbruket', category: 'stödverktyg', role: 'service', website: 'https://www.symbolbruket.se',
    note: 'Svensk leverantör av Widgits bildstödsprogram.',
    vendors: ['symbolbruket'], brand: /symbolbruket/,
    addOns: [A('Mallar för två språk', /mallar/)],
    products: [
      P('Widgit Online', 'stödverktyg', 'Webbtjänst för att skapa material med bildstöd.', /widgit( online)?(?! writer)/),
      P('InPrint', 'stödverktyg', 'Program för att göra tryckt material med bildstöd.', /inprint/),
      P('SymWriter', 'stödverktyg', 'Ordbehandlare med bildstöd.', /symwriter|widgit writer/),
    ] },
  { canonical: 'ReadSpeaker', slug: 'readspeaker', category: 'stödverktyg', role: 'service', website: 'https://www.readspeaker.com',
    vendors: ['readspeaker'], brand: /readspeaker/, singleProduct: 'ReadSpeaker TextAid',
    products: [P('ReadSpeaker TextAid', 'stödverktyg', 'Uppläsning och läs- och skrivstöd i webbläsaren.', /readspeaker|textaid/)] },
  { canonical: 'Lexplore', slug: 'lexplore', category: 'bedömning', role: 'service', website: 'https://lexplore.com',
    vendors: ['lexplore'], brand: /lexplore/, defaultProduct: 'Lexplore Impact',
    addOns: [A('Eye tracker', /eye trackers?/)],
    products: [
      P('Lexplore Assessment', 'bedömning', 'Screening av läsförmåga med ögonrörelsemätning.', /lexplore assessment/, /^assessment/),
      P('Lexplore Impact', 'bedömning', 'Lässcreening, insikter och läsflytsträning för hela skolan.', /lexplore impact/, /impact|screening|insikter|lasflyt|bibliotek|lasdagbok|kartlaggning|resultatportal/),
    ] },

  // ---------------- Prov ----------------
  { canonical: 'DigiExam', slug: 'digiexam', category: 'prov', role: 'service', website: 'https://www.digiexam.com',
    vendors: ['digiexam'], brand: /digiexam/, singleProduct: 'DigiExam',
    products: [P('DigiExam', 'prov', 'Plattform för digitala prov.', /digiexam/)] },
  { canonical: 'Dugga', slug: 'dugga', category: 'prov', role: 'service', website: 'https://dugga.com',
    vendors: ['dugga'], brand: /dugga/, defaultProduct: 'Dugga',
    addOns: [A('Support SLA', /\bsla\b/), A('Plagiatkontroll', /plagiat/)],
    products: [
      P('Dugga AI Exam Engine', 'prov', 'AI-assistent som hjälper läraren att skapa och rätta prov.', /ai exam engine/),
      P('Dugga', 'prov', 'Plattform för digitala prov (Premium).', /dugga/, /digitala prov|provsystem|assessment/, { editions: ['Premium'] }),
    ] },
  { canonical: 'Trelson', slug: 'trelson', category: 'prov', role: 'service', website: 'https://trelson.com',
    vendors: ['trelson'], brand: /trelson/, defaultProduct: 'Trelson Assessment',
    products: [
      P('Trelson Mail Switch', 'övrigt', 'Tjänst för att flytta e-post mellan domäner i Google Workspace.', /trelson mail switch/),
      P('Trelson Assessment', 'prov', 'Plattform för digitala prov med låst provläge (fokusrum).', /trelson/, /fokusrum|app|adminverktyg/),
    ] },
  { canonical: 'StudyBee', slug: 'studybee', category: 'bedömning', role: 'service', website: 'https://studybee.io',
    vendors: ['studybee'], brand: /studybee/, singleProduct: 'StudyBee',
    products: [P('StudyBee', 'bedömning', 'Bedömningsstöd och uppföljning av elevers kunskapsutveckling.', /studybee/, /early warning|examensprognos/)] },

  // ---------------- Lärplattform ----------------
  { canonical: 'Unikum', slug: 'unikum', category: 'lärplattform', role: 'service', website: 'https://unikum.net',
    note: 'Unikum ägs av Chas Visual Management AB.',
    vendors: ['unikum', 'chas visual management', 'chas'], brand: /unikum/, defaultProduct: 'Unikum',
    addOns: [
      A('Unikum Connect', /connect|ber api|\bsynk|provisionering|single sign on|\bsso\b|teams|\bapi\b/),
      A('Unikum Arkiv och gallring', /arkiv|gallring/),
      A('BankID-inloggning', /bankid|stark autentisering/),
    ],
    products: [
      P('Unikum Stödinsatser', 'lärplattform', 'Dokumentation av extra anpassningar och särskilt stöd.', /unikum.*stodinsatser|stodinsatser.*unikum/, /stodinsatser/),
      P('Unikum Närvaro och frånvaro', 'lärplattform', 'Närvaro i förskola och fritids och frånvaro i skolan.', /unikum.*(narvaro|franvaro)/, /narvaro|franvaro|schemavisning/),
      P('Unikum Kvalitet', 'lärplattform', 'Stöd för systematiskt kvalitetsarbete.', /unikum kvalitet/, /kvalitet/),
      P('Unikum Flow', 'lärplattform', 'Modul i Unikum (Flow Mini).', /unikum flow/, /\bflow\b/),
      P('Unikum', 'lärplattform', 'Lärplattform för förskola till gymnasium: planering, bedömning, IUP och vårdnadshavarkontakt.', /unikum/,
        /larplattform|\biup\b|blogg|\bbas\b|portfolio|bedomning|betyg|direktmeddelanden|pedagogisk|unikt larande|samlad larresa|familj|dialog med hemmet|elevmapp|skolbanken|ledighetsansokan|plattform|lararesa|verksamhetssystem|formativt|lms|learning management|fortroende|e forvaltning|saas tjanst/),
    ] },
  { canonical: 'Haldor', slug: 'haldor', category: 'lärplattform', role: 'service', website: 'https://haldor.se',
    vendors: ['haldor'], brand: /haldor/, singleProduct: 'Haldor Education',
    addOns: [A('SMS-utskick', /\bsms\b/), A('API-tjänst', /\bapi\b/), A('EU-lagring', /lagring/), A('Vårdnadshavarinloggning via IdP', /autentisering|\bidp\b/), A('Analys via Power BI', /\bpbi\b/), A('Schemaintegration', /schemaintegration|integration schema/)],
    products: [P('Haldor Education', 'lärplattform', 'Lärplattform byggd på Microsoft Teams, med moduler för planering, bedömning och närvaro.', /haldor/)] },
  { canonical: 'Infomentor', slug: 'infomentor', category: 'lärplattform', role: 'service', website: 'https://www.infomentor.se',
    vendors: ['infomentor', 'informentor'], brand: /infomentor/, singleProduct: 'InfoMentor',
    products: [P('InfoMentor', 'lärplattform', 'Lärplattform för förskola och grundskola.', /infomentor/, /p o d b/)] },
  { canonical: 'Vklass', slug: 'vklass', suite: true, category: 'lärplattform', role: 'service', website: 'https://www.vklass.se',
    vendors: ['vklass'], brand: /vklass/, defaultProduct: 'Vklass',
    products: [
      P('Vklass Närvaro', 'lärplattform', 'Närvaro och in- och utcheckning på fritids.', /vklass( )?narvaro/, /narvaro|in och utcheck|incheckning|fritids/),
      P('Vklass', 'lärplattform', 'Lärplattform med kommunikation, schema och dokumentation.', /vklass/, /larplattform|skolplattform|larportal|grundschema|elevadministr|systemkostnad/),
    ] },
  { canonical: 'itslearning', slug: 'itslearning', category: 'lärplattform', role: 'service', website: 'https://itslearning.com',
    vendors: ['itslearning'], brand: /itslearning/, singleProduct: 'itslearning',
    addOns: [A('Plagiatkontroll', /plagiar|simcheck|ephorus|turnitin/), A('Advanced Reporting', /reporting|rapporter/), A('Extra lagring', /storage/), A('Integrationer', /ims|e login|middleware|\bsso\b|dexter arena/), A('Timbank', /timbank/)],
    products: [P('itslearning', 'lärplattform', 'Lärplattform för grundskola och gymnasium.', /itslearning/)] },
  { canonical: 'Meitner', slug: 'meitner', suite: true, category: 'lärplattform', role: 'service', website: 'https://meitner.se',
    vendors: ['meitner'], brand: /meitner/, singleProduct: 'Meitner',
    products: [P('Meitner', 'lärplattform', 'Lärplattform och elevadministration för alla skolformer.', /meitner/)] },
  { canonical: 'Showbie', slug: 'showbie', category: 'lärplattform', role: 'service', website: 'https://www.showbie.com',
    vendors: ['showbie'], brand: /showbie/, singleProduct: 'Showbie',
    products: [P('Showbie', 'lärplattform', 'App för uppgifter och återkoppling, främst på iPad.', /showbie/, null, { editions: ['Complete'] })] },
  { canonical: 'Aleido Learning', slug: 'aleido', category: 'lärplattform', role: 'service', website: null,
    vendors: ['aleido learning', 'aleido learning sweden', 'aleido'], brand: /aleido/, products: [] },
  { canonical: 'Microsoft', slug: 'microsoft', category: 'lärplattform', role: 'service', website: 'https://www.microsoft.com/sv-se/education',
    vendors: ['microsoft'], brand: /microsoft|\bm365\b|o365/,
    products: [
      P('Microsoft Copilot', 'övrigt', 'AI-assistent i Microsoft 365.', /microsoft copilot for microsoft 365( a3 and a5)?|copilot/),
      P('Microsoft 365', 'lärplattform', 'Office-program, Teams och e-post för skolan (A1, A3, A5).', /microsoft 365|\bm365\b|\bo365\b|office 365|office professional/, null, { editions: ['A1', 'A3', 'A5'] }),
      P('Power BI', 'övrigt', 'Verktyg för rapporter och dataanalys.', /power bi/),
      P('Power Automate', 'övrigt', 'Automatisering av arbetsflöden.', /power automate/),
      P('Visio', 'övrigt', 'Program för diagram och flödesscheman.', /\bvisio\b/),
      P('Planner och Project', 'övrigt', 'Planering och projektstyrning.', /planner and project|project plan/),
      P('Microsoft Entra ID', 'övrigt', 'Identitets- och behörighetshantering.', /entra id/),
      P('Microsoft Defender', 'övrigt', 'Skydd mot skadlig kod för datorer och e-post.', /defender/),
      P('Windows', 'övrigt', 'Windows operativsystem och Windows Server med CAL-licenser.', /windows|core cal/),
      P('SQL Server', 'övrigt', 'Databasserver.', /sql server/),
    ] },
  { canonical: 'Google', slug: 'google', category: 'lärplattform', role: 'service', website: 'https://edu.google.com',
    vendors: ['google'], brand: /google/,
    products: [
      P('Chrome Education Upgrade', 'övrigt', 'Licens för central hantering av Chromebooks.', /chrome education/),
      P('Google Workspace for Education', 'lärplattform', 'E-post, dokument och Classroom för skolan (Fundamentals, Standard, Plus).', /google workspace|g suite|\bgafe\b|google apps|education plus|google education|google wsfe/, null, { editions: ['Fundamentals', 'Standard', 'Plus'] }),
    ] },
  { canonical: 'Adobe', slug: 'adobe', category: 'övrigt', role: 'service', website: 'https://www.adobe.com', vendors: ['adobe'], brand: /adobe/, products: [] },

  // ---------------- Skoladministration ----------------
  { canonical: 'Tietoevry', slug: 'tietoevry', suite: true, category: 'skoladministration', role: 'service', website: 'https://www.tietoevry.com',
    vendors: ['tieto', 'tietoevry', 'tieto evry', 'tietoenator', 'tietoenator healthcare welfare'], brand: /tieto/, defaultProduct: 'Edlevo',
    addOns: [A('Testmiljö', /testmiljo/), A('Dokumentation', /^dokumentation$/), A('Driftsplattform', /driftsplattform/), A('Integrationer', /skolvalskoppling/)],
    products: [
      P('Lifecare', 'övrigt', 'Verksamhetssystem för vård och omsorg.', /lifecare/),
      P('Edlevo', 'skoladministration', 'Elevregister och skoladministration för alla skolformer (tidigare Tieto Education och Procapita).', /edlevo|tieto edu(cation)?|procapita/,
        /elevregist|verksamhetssystem|vardnadshavarportal|skolportal|entreprenorsportal|app for vh|grundmodul|kulturskola|vuxenutbildning|gymnasieskola|forskola|grundskola|betyg|synpunkter|taxibestallning|klassuppflyttning|gymnasieantagning|skolval|aviseringar|edu (mlo|bes)|specialkost|barnomsorg|platserbjudande|registrera inkomst|familjeforhallanden|inkomstuppgift|franvaro|narvaro|kalenderschema|planering forskola|^rum$|elevdata|systemstod|elevhantering|elevadministr|skoladministr|barn och elevregister|foraldrakonto|webmodul|^web |paketpris|grundsystem|nationella prov/),
    ] },
  { canonical: 'IST', slug: 'ist', suite: true, category: 'skoladministration', role: 'service', website: 'https://www.ist.com/sv',
    vendors: ['ist', 'ist education', 'ist sverige'], brand: /\bist\b/, defaultProduct: 'IST Administration',
    addOns: [A('ASP-drift', /\basp\b/), A('Historiklicens', /historik/), A('IST Navet', /navet/), A('Databaslicens Sybase', /sybase/), A('Digitala nationella prov', /nationella prov|\bdnp\b/)],
    products: [
      P('IST Analys', 'skoladministration', 'Statistik och analys av skolans data.', /ist analys|ist statistik/, /analys|statistik/),
      P('IST Schema', 'skoladministration', 'Schemaläggning.', /ist schema/, /schema/),
      P('IST Lärande', 'lärplattform', 'Lärplattform kopplad till IST Administration.', /ist larande/, /larande|larplattform/),
      P('Dexter', 'skoladministration', 'Webbportal för lärare och vårdnadshavare till Extens.', /dexter/),
      P('hypernet', 'skoladministration', 'Skolportal och intranät.', /hypernet/),
      P('PingPong', 'lärplattform', 'Äldre lärplattform.', /ping ?pong/),
      P('EduCloud', 'integration', 'Integrationsplattform för skolans system.', /educloud/),
      P('SkolID', 'integration', 'Inloggningstjänst för elever och personal.', /skolid/),
      P('TextLink', 'övrigt', 'Tjänst för SMS-utskick.', /textlink/),
      P('IST Home Skola', 'skoladministration', 'App för vårdnadshavare.', /ist home skola/),
      P('IST Administration', 'skoladministration', 'Elevregister och skoladministration för alla skolformer (tidigare Extens).', /ist administration|extens|\bist (skola|forskola|narvaro|medgivande|formular|fakturering|resursfordelning|ike|lamna)/,
        /skolpliktsbevakning|mitt skolval|ansokan (och )?antag|gymnasieantag|sambokontroll|\bkaa\b|automatik|forskola fritidshem|ist stod|ist systemet|e ?forvaltning|elevregister|elevadministr|skoladministr|barn och elev|barnomsorgsadministr|webbaserat it stod|it stod|\bist\b/),
    ] },
  { canonical: 'SchoolSoft', slug: 'schoolsoft', suite: true, category: 'skoladministration', role: 'service', website: 'https://www.schoolsoft.se',
    vendors: ['schoolsoft'], brand: /schoolsoft/, defaultProduct: 'SchoolSoft',
    addOns: [A('Läsårsarkivering', /arkiv/), A('BankID-inloggning', /bankid/), A('SMS-paket', /\bsms\b/)],
    products: [
      P('SchoolSoft Schema', 'skoladministration', 'Schemaläggning med AI-stöd (AI Schema).', /schoolsoft schema/, /schema/),
      P('SchoolSoft', 'skoladministration', 'Skolplattform med lärplattform och elevadministration (EA).', /schoolsoft/,
        /larplattform|elevadministr|\bea\b|elevregister|betyg|barnadministration|fakturering|e tjanst|mitt skolval|skoladministr|verksamhetssystem|^administration|bedomning och kommunikation|dokumentationssystem|stod for larande/),
    ] },
  { canonical: 'Nova Software', slug: 'nova-software', category: 'skoladministration', role: 'service', website: 'https://www.skola24.se',
    vendors: ['nova software', 'novasoftware', 'skola24', 'skola 24'], brand: /nova software|skola ?24/, defaultProduct: 'Skola24',
    addOns: [A('SMS-avisering', /\bsms\b/), A('Frånvaroanmälan via telefon', /telefon/), A('Export lektion', /export lektion/), A('Rapport pedagogisk personal (SCB)', /rapport (pedagogisk personal|tjanstestorlek)/), A('SLA', /\bsla\b/), A('Flerspråksval', /flersprak/)],
    products: [
      P('Skola24 Schema', 'skoladministration', 'Schemaläggning med Novaschem och schemavisning i Skola24.', /skola ?24 schema|novaschem|funktionspaket schema/, /schema|analys och planering/),
      P('Skola24 Frånvaro', 'skoladministration', 'Frånvarohantering och frånvarostatistik.', /skola ?24 franvaro|funktionspaket franvaro/, /franvaro|narvaro/),
      P('Skola24 Fritidshem', 'skoladministration', 'Närvaro och schema för fritidshem.', /skola ?24 fritidshem|funktionspaket fritidshem/, /fritidshem/),
      P('Skola24', 'skoladministration', 'Plattform för schema, frånvaro och lokalbokning.', /skola ?24/, /plattform|boka lokal|dela lokal|ledighetsansokan|\bapp\b/),
    ] },
  { canonical: 'Tempus', slug: 'tempus', category: 'skoladministration', role: 'service', website: 'https://tempus.se',
    vendors: ['tempus', 'tempus information systems', 'tempus information system'], brand: /tempus/, defaultProduct: 'Tempus Barn',
    products: [
      P('Tempus Personal', 'skoladministration', 'Personalplanering i förskolan.', /tempus personal/, /personal/),
      P('Tempus Köksplanering', 'skoladministration', 'Planering av måltider och kök.', /koksplanering/),
      P('Tempus Barn', 'skoladministration', 'Närvaroregistrering och barnadministration i förskola och fritids.', /tempus/, /barn|forskolesystem|narvaro/),
    ] },
  { canonical: 'Quiculum', slug: 'quiculum', suite: true, category: 'skoladministration', role: 'service', website: 'https://quiculum.se',
    vendors: ['quiculum'], brand: /quiculum|quickulum/, singleProduct: 'Quiculum',
    addOns: [A('BankID- och SMS-tjänst', /bankid|\bsms\b/)],
    products: [P('Quiculum', 'skoladministration', 'Skolplattform med elevadministration och schema.', /quiculum|quickulum/)] },
  { canonical: 'Göteborgs IT Konsult Gotit', slug: 'gotit', category: 'skoladministration', role: 'service', website: 'https://gotit.se',
    vendors: ['gotit', 'goteborgs it konsult gotit'], brand: /gotit/, defaultProduct: 'Alvis',
    products: [
      P('Skolplatsen', 'skoladministration', 'Söktjänst och ansökan till vuxenutbildning.', /skolplatsen/),
      P('Alvis', 'skoladministration', 'Elevadministration och antagning för vuxenutbildningen.', /alvis/, /vuxenutbildning|elevregister|antagning|elevadministr|it system|administrativt/),
    ] },
  { canonical: 'SpeedAdmin', slug: 'speedadmin', category: 'skoladministration', role: 'service', website: 'https://speedadmin.dk',
    vendors: ['speedadmin', 'speedware'], brand: /speedadmin/, singleProduct: 'SpeedAdmin',
    products: [P('SpeedAdmin', 'skoladministration', 'Administrationssystem för kulturskolan.', /speedadmin/, /kulturskola/, { editions: ['Play!'] })] },
  { canonical: 'StudyAlong', slug: 'studyalong', category: 'skoladministration', role: 'service', website: 'https://studyalong.se',
    vendors: ['studyalong'], brand: /studyalong/, defaultProduct: 'StudyAlong',
    products: [
      P('Playalong', 'läromedel', 'Digitalt undervisningsmaterial för musik i kulturskolan.', /playalong/),
      P('StudyAlong', 'skoladministration', 'Administration och lärplattform för kulturskolan.', /studyalong/, /modul|kulturskola|systemstod|^a1 /),
    ] },
  { canonical: 'Tyra', slug: 'tyra', category: 'skoladministration', role: 'service', website: 'https://tyra.io',
    vendors: ['tyra'], brand: /\btyra\b/, singleProduct: 'Tyra',
    products: [P('Tyra', 'skoladministration', 'App för förskolan: dokumentation, närvaro och kontakt med vårdnadshavare.', /\btyra\b/)] },
  { canonical: 'Plan Digital', slug: 'plan-digital', category: 'skoladministration', role: 'service', website: null,
    vendors: ['plan digital'], brand: /plan digital/, singleProduct: 'Plan Digital',
    products: [P('Plan Digital', 'skoladministration', 'System för tjänstefördelning i grundskolan.', /plan digital/, /tjanstefordelning/)] },
  { canonical: 'Royal Schedule', slug: 'royal-schedule', category: 'skoladministration', role: 'service', website: 'https://royalschedule.com',
    vendors: ['royal schedule'], brand: /royal schedule/, singleProduct: 'Royal Schedule',
    products: [P('Royal Schedule', 'skoladministration', 'Schemaläggning med automatisk optimering.', /royal schedule/)] },
  { canonical: 'Optiplan', slug: 'optiplan', category: 'skoladministration', role: 'service', website: 'https://optiplan.se',
    vendors: ['optiplan'], brand: /optiplan/,
    products: [
      P('Optiplan Skolskjuts', 'skoladministration', 'Planering av skolskjuts.', /optiplan skolskjuts/, /skolskjuts|skolkarta/),
      P('Optiplan Skolplacering', 'skoladministration', 'Skolval och skolplacering med e-tjänst för vårdnadshavare.', /optiplan skolplacering/, /skolplacering|vardnadshavarportal/),
    ] },
  { canonical: 'Svensk utbildningsteknologi', slug: 'svensk-utbildningsteknologi', category: 'skoladministration', role: 'service', website: null,
    vendors: ['svensk utbildningsteknologi'], brand: /svensk utbildningsteknologi/, products: [] },
  { canonical: 'Stratsys', slug: 'stratsys', category: 'övrigt', role: 'service', website: 'https://www.stratsys.com',
    vendors: ['stratsys'], brand: /stratsys/, singleProduct: 'Stratsys SKA',
    products: [P('Stratsys SKA', 'övrigt', 'Stöd för systematiskt kvalitetsarbete i skolan.', /stratsys/, /\bska\b|kvalitetsarbete/)] },

  // ---------------- Elevhälsa ----------------
  { canonical: 'Prorenata', slug: 'prorenata', category: 'elevhälsa', role: 'service', website: 'https://prorenata.se',
    vendors: ['prorenata'], brand: /prorenata/, singleProduct: 'ProReNata Journal',
    addOns: [A('Överföring från PMO', /\bpmo\b|overforing|databasoverforing|journalkopior/), A('Säker digital kommunikation (SDK)', /\bsdk\b|sefos/), A('NPÖ-koppling', /\bnpo\b/), A('Digital remiss (Inera)', /inera|remiss/), A('Användarimport', /anvandarimport/)],
    products: [P('ProReNata Journal', 'elevhälsa', 'Journalsystem för elevhälsan.', /prorenata/, /journal|elevhals|dokumentationssystem|systemstod/)] },
  { canonical: 'CompuGroup Medical', slug: 'cgm', category: 'elevhälsa', role: 'service', website: 'https://www.cgm.com/swe_sv',
    vendors: ['compugroup medical'], brand: /compugroup|\bcgm\b|profdoc/, singleProduct: 'PMO',
    addOns: [A('Arkivexport', /arkivexport/)],
    products: [P('PMO', 'elevhälsa', 'Journalsystem för elevhälsan.', /\bpmo\b(?! export)/)] },
  { canonical: 'Digital Fox', slug: 'digital-fox', category: 'elevhälsa', role: 'service', website: 'https://digitalfox.se',
    vendors: ['digital fox'], brand: /digital fox/, singleProduct: 'DF Respons',
    products: [P('DF Respons', 'elevhälsa', 'Digital hantering av kränkande behandling, olyckor och elevärenden.', /df respons/)] },
  { canonical: 'Visma Draftit', slug: 'draftit', category: 'elevhälsa', role: 'service', website: 'https://www.draftit.se',
    vendors: ['visma draftit', 'draftit'], brand: /draftit/,
    products: [
      P('Draftit Incident', 'elevhälsa', 'Anmälan och hantering av kränkande behandling och incidenter.', /draftit incident/, /incident|krankande/),
      P('Draftit Skolledning', 'övrigt', 'Regelverk och rutiner för skolledare.', /draftit (publicering )?skolledning/, /skolledning/),
    ] },

  // ---------------- Integration / övrigt ----------------
  { canonical: 'Eventful', slug: 'eventful', category: 'integration', role: 'service', website: 'https://eventful.se', productFirst: true,
    vendors: ['eventful'], brand: /eventful|evenful/,
    products: [
      P('TeamSynk', 'integration', 'Synk av elever, klasser och schema till Microsoft 365 och Teams.', /teamsynk|even?tful (synktjanst|skoltjanst|skolsynk)/, /synktjanst|skoltjanst|skolsynk|microsoft sds/, { editions: ['Brons'] }),
      P('KontoSynk', 'integration', 'Automatisk konto­hantering i Entra ID och Google.', /kontosynk/, /\bgcds\b/),
      P('ClassroomSynk', 'integration', 'Synk av klasser till Google Classroom.', /classroomsynk/),
      P('GruppSynk', 'integration', 'Synk av grupper mellan skolsystem och katalogtjänst.', /gruppsynk/),
      P('AD-Synk', 'integration', 'Synk av konton till Active Directory.', /\bad synk/),
      P('FlowSync', 'integration', 'API för dataflöden mellan skolans system.', /flowsync/),
      P('Lösenordshantering', 'integration', 'Självservice för lösenord för elever och personal.', /losenordshantering/),
      P('Schemapublicering', 'integration', 'Publicering av schema i Google Kalender.', /schemapublicering/),
      P('DNP-provisionering', 'integration', 'Konton och inloggning för digitala nationella prov.', /(provisionering|inloggning) digitala nationella prov|till dnp/, /digitala nationella prov|\bdnp\b/),
      P('Skolpass', 'integration', 'Inloggningstjänst (IdP) via Google.', /skolpass|idp google/),
    ] },
  { canonical: 'Skolfederation', slug: 'skolfederation', category: 'integration', role: 'service', website: 'https://skolfederation.se',
    vendors: ['skolfederation'], brand: /skolfederation/, singleProduct: 'Skolfederation',
    products: [P('Skolfederation', 'integration', 'Medlemskap i federationen för säker inloggning till skoltjänster.', /skolfederation/)] },
  { canonical: 'Sambruk', slug: 'sambruk', category: 'övrigt', role: 'service', website: 'https://sambruk.se',
    vendors: ['sambruk'], brand: /sambruk/,
    products: [
      P('Tjänstekollen', 'övrigt', 'Gemensam e-tjänst för kommuner.', /tjanstekollen/),
      P('Tillarbetslivet', 'övrigt', 'Tjänst för praktik och kontakt med arbetslivet.', /tillarbetslivet/),
      P('EGIL', 'integration', 'Öppen standard och tjänst för att föra över elevdata mellan system.', /\begil\b/),
    ] },
  { canonical: 'Learn-IT Umeå', slug: 'samverka', category: 'övrigt', role: 'service', website: 'https://samverka.nu',
    vendors: ['learn it umea', 'samverka nu'], brand: /\bsamverka/, singleProduct: 'Samverka.nu',
    products: [P('Samverka.nu', 'övrigt', 'Tjänst för att hantera PRAO och praktikplatser.', /\bsamverka/, /prao/)] },
  { canonical: 'Axiell', slug: 'axiell', category: 'övrigt', role: 'service', website: 'https://www.axiell.com',
    vendors: ['axiell'], brand: /axiell/, defaultProduct: 'WeLib',
    products: [
      P('WeLib', 'övrigt', 'Bibliotekssystem för skolbibliotek.', /welib/),
      P('ElibU', 'läromedel', 'E-böcker och ljudböcker för skolan.', /elibu/),
    ] },
  { canonical: 'BTJ', slug: 'btj', category: 'övrigt', role: 'service', website: 'https://www.btj.se',
    vendors: ['btj', 'bibliotekstjanst'], brand: /\bbtj\b/,
    products: [
      P('ArtikelSök', 'läromedel', 'Databas med artiklar ur svensk press.', /artikelsok/),
      P('Updatum', 'läromedel', 'Faktadatabas om aktuella ämnen.', /updatum/),
    ] },
  { canonical: 'Skillster', slug: 'skillster', category: 'övrigt', role: 'service', website: 'https://skillster.com',
    vendors: ['skillster'], brand: /skillster/, singleProduct: 'Skillster',
    products: [P('Skillster', 'övrigt', 'Körsimulatorer för fordonsutbildning.', /skillster|simulator/)] },
  { canonical: 'P & L Nordic', slug: 'pl-nordic', category: 'läromedel', role: 'service', website: null,
    vendors: ['p l nordic'], brand: /p l nordic/, singleProduct: 'LearnWARE',
    products: [P('LearnWARE', 'läromedel', 'Interaktivt utbildningsmaterial för yrkesprogram.', /learnware/, /interaktivt utbildningsmaterial/)] },
  { canonical: 'Lingio', slug: 'lingio', category: 'läromedel', role: 'service', website: 'https://lingio.com',
    vendors: ['lingio'], brand: /lingio/, singleProduct: 'Lingio', productFirst: true,
    products: [P('Lingio', 'läromedel', 'App för yrkessvenska och språkinlärning.', /lingio/)] },
  { canonical: 'EdAider', slug: 'edaider', category: 'övrigt', role: 'service', website: 'https://edaider.com', productFirst: true,
    vendors: ['edaider', 'edai technologies'], brand: /edaider|edai/, singleProduct: 'EdAider',
    products: [P('EdAider', 'övrigt', 'AI-utbildning och AI-verktyg för skolledare och lärare.', /edaider|ai for skolledare|ai utbildning|grundkurs ai/)] },
  { canonical: 'Stig', slug: 'stig', category: 'stödverktyg', role: 'service', website: null,
    vendors: ['stig'], brand: /\bstig\b/, singleProduct: 'Stig', products: [P('Stig', 'stödverktyg', 'Digitalt verktyg från Stig.', /\bstig\b/)] },
  { canonical: 'No Isolation', slug: 'no-isolation', category: 'stödverktyg', role: 'service', website: 'https://www.noisolation.com',
    vendors: ['no isolation'], brand: /no isolation/, singleProduct: 'AV1',
    addOns: [A('Servicepaket', /servicepaket/)],
    products: [P('AV1', 'stödverktyg', 'Robot som låter långtidssjuka elever delta i undervisningen hemifrån.', /\bav1\b/)] },
  { canonical: 'CoSafe', slug: 'cosafe', category: 'övrigt', role: 'service', website: 'https://cosafe.com',
    vendors: ['cosafe'], brand: /cosafe/, singleProduct: 'CoSafe',
    products: [P('CoSafe', 'övrigt', 'Digital larm- och krisplattform.', /cosafe/)] },
  { canonical: 'Entergate', slug: 'entergate', category: 'övrigt', role: 'service', website: 'https://www.entergate.se',
    vendors: ['entergate'], brand: /entergate/,
    products: [P('esMaker', 'övrigt', 'Verktyg för enkäter, nyhetsbrev och anmälningsformulär.', /esmaker/, /enkater|nyhetsbrev|anmalningsformular/)] },
  { canonical: 'Sirvoy', slug: 'sirvoy', category: 'övrigt', role: 'service', website: 'https://sirvoy.com',
    vendors: ['sirvoy'], brand: /sirvoy/, singleProduct: 'Sirvoy',
    products: [P('Sirvoy', 'övrigt', 'Bokningssystem för hotell och konferens.', /sirvoy|hotell/, null, { editions: ['Basic'] })] },
  { canonical: 'Göteborgsregionens kommunalförbund', slug: 'gr', category: null, role: 'channel', website: 'https://goteborgsregionen.se',
    vendors: ['goteborgsregionens kommunalforbund'], brand: /goteborgsregionen|\bgr utbildning/,
    products: [P('AV Media', 'läromedel', 'Strömmad film för skolor i Göteborgsregionen.', /av media/)] },
  { canonical: 'Mediapoolen Västra Götaland', slug: 'mediapoolen', category: null, role: 'channel', website: 'https://mediapoolen.se',
    vendors: ['mediapoolen', 'mediapoolen vastra gotaland'], brand: /mediapoolen/,
    addOns: [A('Kompetensutveckling', /kompetensutveckling|digital pedagogik|kurser om resurser/), A('Boklåneservice', /boklaneservice|e och ljudbocker/)],
    products: [
      P('Mediapoolen Play', 'läromedel', 'Filmkatalog och mediearkiv för skolan.', /mediapoolen ?play|filmkatalogen/, /film for skolan|mediearkivet/),
      P('Språklabbet', 'läromedel', 'Digitala resurser för språkundervisning.', /spraklabbet/),
      P('Musikmattan', 'läromedel', 'Bakgrundsmusik som får användas fritt i skolan.', /musikmattan/, /bakgrundsmusik/),
      P('Begreppsdatabasen', 'läromedel', 'Databas med förklarade ämnesbegrepp.', /begreppsdatabasen/),
      P('Tema-biblioteket', 'läromedel', 'Färdiga lektioner och teman om ämnen och omvärld.', /tema biblioteket/, /amnesteman|omvarldsteman|^lektioner$/),
      P('Nutidsquiz', 'läromedel', 'Frågesport om aktuella händelser.', /nutidsquiz/),
      P('Paint Music', 'läromedel', 'Verktyg för att skapa musik.', /paint music/),
      P('Seniorportalen', 'övrigt', 'Digitala resurser för äldreomsorgen.', /seniorportalen/, /aldreportalen|seniorwebben/),
    ] },

  // ---------------- Kanaler ----------------
  ...[
    ['Skolon', 'skolon', ['skolon'], 'https://skolon.com'],
    ['Adda', 'adda', ['adda', 'skl kommentus', 'sklkommentus', 'kommentus'], 'https://www.adda.se'],
    ['Atea', 'atea', ['atea'], 'https://www.atea.se'],
    ['Dustin', 'dustin', ['dustin'], 'https://www.dustin.se'],
    ['Insight', 'insight', ['insight', 'insight technology solutions'], 'https://se.insight.com'],
    ['Crayon', 'crayon', ['crayon'], 'https://www.crayon.com'],
    ['SoftwareONE', 'softwareone', ['softwareone'], 'https://www.softwareone.com'],
    ['Advania', 'advania', ['advania'], 'https://www.advania.se'],
    ['Foxway', 'foxway', ['foxway', 'foxway education'], 'https://www.foxway.com'],
    ['Online Partner', 'online-partner', ['online partner', 'onlinepartner'], 'https://onlinepartner.se'],
    ['Devoteam Cloud Services', 'devoteam', ['devoteam', 'devoteam cloud services'], 'https://www.devoteam.com'],
    ['LäroMedia Bokhandel Örebro', 'laromedia', ['laromedia', 'laromedia bokhandel orebro', 'laromedia bokhandel'], 'https://www.laromedia.se'],
    ['Mediacenter Jönköpings län', 'mediacenter', ['mediacenter jonkopings lan', 'mediacenter jonkoping', 'mediacenter'], null],
    ['Mediecenter Mälardalen', 'mediecenter-malardalen', ['mediecenter malardalen'], null],
    ['Pulsen', 'pulsen', ['pulsen'], 'https://www.pulsen.se'],
    ['Softronic', 'softronic', ['softronic'], 'https://www.softronic.se'],
  ].map(([canonical, slug, vendors, website]) => ({ canonical, slug, category: null, role: 'channel', website, vendors, brand: null, products: [] })),

  // ---------------- Utbildningsanordnare / offentliga aktörer (inga produkter) ----------------
  // Doubt 24: no products, catalogued only to absorb their rows; hidden from
  // studio vendor lists. Set hiddenInStudio: false to show them.
  ...[
    ['Hermods', 'hermods', ['hermods']],
    ['Bergstrands Vuxenutbildning', 'bergstrands', ['bergstrands vuxenutbildning']],
    ['Talenti', 'talenti', ['talenti', 'talenti sverige']],
    ['Agila Institutet', 'agila', ['agila institutet', 'agila institutet vux']],
  ].map(([canonical, slug, vendors]) => ({ canonical, slug, category: 'utbildningsanordnare', role: 'service', website: null, vendors, brand: null, products: [], hiddenInStudio: true })),
  { canonical: 'Upplands-Bro kommun', slug: 'upplands-bro', category: 'offentlig aktör', role: 'service', website: null, vendors: ['upplands bro kommun'], brand: null, products: [], hiddenInStudio: true },
  { canonical: 'Oard', slug: 'oard', category: 'skoladministration', role: 'service', website: null, vendors: ['oard', 'ab oard'], brand: /\board\b/, products: [] },
];

// Skolon sells its own platform too (role stays channel, as in the KB).
const skolon = COMPANIES.find((c) => c.slug === 'skolon');
skolon.brand = /skolon|skolup/;
skolon.category = 'lärplattform';
skolon.note = 'Återförsäljare av andras läromedel, men säljer också en egen plattform.';
skolon.defaultProduct = 'Skolon';
skolon.addOns = [A('Datasynk och provisionering', /datasynk|anvandarsynk|user sync|synkmotor|synkronisering|\bidp\b|provisionering/), A('Datavisualisering', /datavisualisering|data visualizer/)];
skolon.products = [
  P('Skolup AI', 'stödverktyg', 'AI-assistent för lärare och elever i Skolon.', /skolup|skolon (for )?ai/, /\bai\b/, { editions: ['Pro'] }),
  P('Skolon', 'lärplattform', 'Portal för att samla, dela ut och köpa digitala läromedel.', /skolon/, /leveransplattform|inkopsportal|portallosning/, { editions: ['Basic', 'Standard', 'Plus', 'Pro', 'Total'] }),
];

// Brand owners that appear only as names inside other vendors' rows, not catalogued.
export const MINOR_BRANDS = [
  [/zcooly/, 'Zcooly', 'Zcooly'],
  [/tiki (reader|premium)/, 'Tiki Läromedel', 'Tiki'],
  [/english minnits/, 'The English Minnits', 'The English Minnits'],
  [/textit/, 'TextIT', 'TextIT'],
  [/timeedit/, 'TimeEdit', 'TimeEdit'],
  [/urkund/, 'Ouriginal (Urkund)', 'Urkund'],
  [/muzzy/, 'Muzzy (BBC)', 'Muzzy Online'],
  [/\blogos\b/, 'Logometrica', 'Logos'],
  [/q interactive/, 'Pearson', 'Q-interactive'],
  [/mega seating plan/, 'Mega Seating Plan', 'Mega Seating Plan'],
  [/activio/, 'Activio', 'Activio'],
  [/kartlaggaren/, 'MyStudyweb', 'Kartläggaren'],
  [/landguiden/, 'Utrikespolitiska Institutet', 'Landguiden'],
  [/wevideo/, 'WeVideo', 'WeVideo'],
  [/freja eid/, 'Freja eID', 'Freja eID'],
  [/lightspeed/, 'Lightspeed', 'Lightspeed MDM'],
  [/cicero (lms|slide|surf)/, 'Systematic', 'Cicero'],
  [/moodle/, 'NetSapiensis', 'Moodle'],
];
