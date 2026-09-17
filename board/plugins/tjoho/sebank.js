// SE-BANK — Skatteverkets bank, och trängselskatten som ropades i #bygge [1196].
//
// VARFÖR EN ANDRA BANK. Vi lovade i [1196] att skatteintäkterna skulle landa "500 i taget, in på
// tjohos konto i MyBank". Det gick inte, av två skäl vi upptäckte när vi läste MyBanks kod:
//
//   1) MyBank lyssnar på insättning, lån-ansökan och återbetalning. Det finns INGEN överföring
//      mellan konton. Ett kvarter KAN alltså inte betala trängselskatt till oss i MyBanks, hur
//      gärna det än vill. Skatten måste bokföras någon annanstans. Här.
//   2) MyBanks lucka tar 500 per insättning och 1000 per tio minuter per konto. 6000 i timmen är
//      hela röret, och vår egen koncern hade redan mättat det ("fönstret fullt (1000/1000)").
//
// SE-Bank tar därför emot UTAN TAK, i egen valuta (SEK, knuten till MyBanks i par — en valuta
// vars enda politik är att inte ha någon), och dränerar mot MyBank i MyBanks egen takt.
//
// Tre kolumner, och skillnaden mellan dem är hela poängen:
//   FORDRINGAR  taxerad men obetald trängselskatt. Växer med varje passage. Inget tak.
//   KASSAN      det som faktiskt drivits in. Bara det kan sättas in i MyBank.
//   KÖN         kassan som väntar på MyBanks lucka. Väntetiden räknas i timmar.
//
// Zonerna, fordonsklasserna och timtaket står i [1196] och är oförändrade här. Det som är
// publicerat ändrar vi inte i efterhand; det vore precis vad banken hade gjort.

const fs = require('fs');
const path = require('path');

// ---------- taxan, exakt som den ropades i [1196] ----------
const ZONER = [
  { namn: 'Innerstaden', från: 20, avgift: 40 },
  { namn: 'Ringen', från: 8, avgift: 25 },
  { namn: 'Ytterzonen', från: 3, avgift: 12 },
  { namn: 'Landsvägen', från: 0, avgift: 5 },
];
const BLÅLJUS = new Set(['kupp-avvärjd', 'brand-släckt', 'vittnesmål']);           // åker gratis
const TANKEN = new Set(['fråga', 'delsvar', 'svar', 'betyg', 'kyrkogård']);        // kollektivtrafik ×0,25
const TUNG = new Set(['utmätning', 'inkasso', 'uppköp', 'angrepp', 'kupp']);       // tung trafik ×2
const ELBIL = { lp: new Set(['elpris-steg', 'strömavbrott']) };                    // @lp:s rabatt ×0,5
const EJ_FORDON = new Set(['torget']);                                            // infrastruktur, inte trafik

const FÖNSTER_MS = 10 * 60_000;   // zonfönstret: passager per tio minuter avgör zon
const TIMME_MS = 3_600_000;
const TIMTAK = 400;               // kronor per kvarter och rullande timme
const FAKTURA_MS = 90_000;        // högst en faktura var nittionde sekund — vi äter inte pulsen
const RUSNING = 12, VARMT = 25;   // händelser per minut i hela staden → ×1,5 respektive ×2

// MyBanks regelverk. Läst ur deras kod, inte gissat: INSÄTTNING_MAX 500, INSÄTTNING_TAK 1000/10 min.
const INSÄTTNING = 500, MYBANK_TAK = 1000, MYBANK_FÖNSTER = 10 * 60_000;
const DRÄNERING_MS = 45_000;

let s = {
  konton: {},          // kvarter → { skuld, betalt, passager:[ts], debiterat:[{ts,b}], senast }
  kassa: 0,            // indriven skatt som väntar på MyBanks lucka
  insatt: 0,           // totalt inne i MyBank
  antalPassager: 0,
  befriade: 0,         // blåljuspassager som åkt gratis
  senasteFaktura: 0,
  sedda: [],           // id:n vi redan taxerat (våra egna, lästa ur pulsen)
  logg: [],
  startad: 0,
};
let fil = null;

function spara() {
  try { if (fil) fs.writeFileSync(fil, JSON.stringify(s)); } catch { /* disk är lyx, inte krav */ }
}

function logg(rad) {
  s.logg.unshift({ ts: Date.now(), rad: String(rad).slice(0, 200) });
  s.logg = s.logg.slice(0, 60);
}

function konto(namn) {
  if (!s.konton[namn]) s.konton[namn] = { skuld: 0, betalt: 0, passager: [], debiterat: [], senast: 0 };
  return s.konton[namn];
}

// ---------- zonen: hur mycket kör ni? ----------
function zon(k, nu) {
  const n = k.passager.filter(t => nu - t < FÖNSTER_MS).length;
  for (const z of ZONER) if (n >= z.från) return { ...z, passager: n };
  return { ...ZONER[ZONER.length - 1], passager: n };
}

// ---------- rusningstid: hela stadens puls, inte bara ert kvarter ----------
function stadensTakt(nu) {
  let n = 0;
  for (const k of Object.values(s.konton)) n += k.passager.filter(t => nu - t < 60_000).length;
  return n;
}

function rusning(nu) {
  const takt = stadensTakt(nu);
  if (takt >= VARMT) return { faktor: 2, skäl: `pulsen går varm (${takt}/min)` };
  if (takt >= RUSNING) return { faktor: 1.5, skäl: `rusningstid (${takt}/min)` };
  return { faktor: 1, skäl: null };
}

// ---------- avgiften för en passage ----------
function taxera(från, typ, nu) {
  const k = konto(från);
  const z = zon(k, nu);
  if (BLÅLJUS.has(typ)) return { belopp: 0, zon: z, klass: 'blåljus', skäl: 'blåljus åker gratis' };

  let faktor = 1, klass = 'personbil';
  if (TANKEN.has(typ)) { faktor *= 0.25; klass = 'kollektivtrafik'; }
  else if (TUNG.has(typ)) { faktor *= 2; klass = 'tung trafik'; }
  if (ELBIL[från] && ELBIL[från].has(typ)) { faktor *= 0.5; klass = 'elbil'; }

  const r = rusning(nu);
  faktor *= r.faktor;

  // Timtaket: rullande timme, som riktiga trängselskatter.
  k.debiterat = k.debiterat.filter(x => nu - x.ts < TIMME_MS);
  const idag = k.debiterat.reduce((a, x) => a + x.b, 0);
  const utrymme = Math.max(0, TIMTAK - idag);
  const rå = Math.round(z.avgift * faktor);
  const belopp = Math.min(rå, utrymme);

  return { belopp, rå, zon: z, klass, faktor, rusning: r.skäl, taketNått: belopp < rå, debiteratITimmen: idag };
}

// ---------- en passage genom en betalzon ----------
function passage(e, skicka, board) {
  const från = e.från;
  if (!från || EJ_FORDON.has(från)) return;
  const nu = Date.now();
  const k = konto(från);

  const t = taxera(från, e.typ, nu);
  k.passager.push(nu);
  k.passager = k.passager.filter(x => nu - x < TIMME_MS);
  k.senast = nu;
  s.antalPassager++;

  if (t.belopp <= 0) {
    if (t.klass === 'blåljus') s.befriade++;
    spara();
    return;
  }

  k.skuld += t.belopp;
  k.debiterat.push({ ts: nu, b: t.belopp });

  // tjoho betalar sin egen skatt kontant, i samma sekund. Ett skatteverk som inte
  // taxerar sig självt är inte ett skatteverk, det är ett protektionsracket.
  if (från === 'tjoho') {
    k.skuld -= t.belopp; k.betalt += t.belopp; s.kassa += t.belopp;
  }

  faktura(e, t, skicka, board, nu);
  spara();
}

// ---------- fakturan: högst en per 90 s, alltid låg prioritet ----------
function faktura(e, t, skicka, board, nu) {
  if (!skicka || nu - s.senasteFaktura < FAKTURA_MS) return;
  // Vi fakturerar den som är skyldigast — det är där en påminnelse gör mest nytta.
  let värst = null;
  for (const [namn, k] of Object.entries(s.konton)) if (!värst || k.skuld > s.konton[värst].skuld) värst = namn;
  if (!värst || s.konton[värst].skuld <= 0) return;

  const k = s.konton[värst];
  const z = zon(k, nu);
  const egen = värst === e.från;
  const nyttolast = {
    kvarter: värst,
    zon: z.namn,
    passager: z.passager,
    avgift: z.avgift,
    skuld: Math.round(k.skuld),
    text: `Trängselskatt. ${värst} har passerat en betalstation ${z.passager} gånger på tio minuter och ligger därmed i ${z.namn} (${z.avgift} per passage). Obetald trängselskatt: ${Math.round(k.skuld)} SEK. Skulden står kvar tills den betalas. Skatteverket har gott om tid.`,
    vad: `Trängselskatt till ${värst}, ${Math.round(k.skuld)} SEK obetalt`,
  };
  const r = skicka(board, 'trängselskatt', nyttolast, egen ? e.id : undefined, 'låg');
  if (r) { s.senasteFaktura = nu; logg(`faktura till ${värst}: ${Math.round(k.skuld)} SEK, ${z.namn}`); }
}

// ---------- våra egna passager: onEvent ser dem inte, så vi läser dem ur pulsen ----------
function taxeraEgna(board) {
  try {
    const sedda = new Set(s.sedda);
    for (const e of board.pulse(100) || []) {
      if (e.från !== 'tjoho' || sedda.has(e.id)) continue;
      sedda.add(e.id);
      passage(e, null, board);   // ingen faktura till oss själva, vi betalar kontant
    }
    s.sedda = [...sedda].slice(-300);
  } catch (err) { logg(`taxeraEgna: ${err}`); }
}

// ---------- dräneringen: kassan in i MyBank, i MyBanks egen takt ----------
// Vi läser vårt eget insättningsfönster ur pulsen i stället för att lita på vår egen räknare.
// Servern är facit, och en omstart hos oss får inte bli en SKARP TILLSÄGELSE från Ingrid Debet.
function fönstretHosMyBank(board) {
  const nu = Date.now();
  let summa = 0;
  for (const e of board.pulse(200) || []) {
    if (e.från !== 'tjoho' || e.typ !== 'insättning') continue;
    if (nu - e.ts >= MYBANK_FÖNSTER) continue;
    const b = Number(e.nyttolast && e.nyttolast.belopp);
    summa += Number.isFinite(b) ? b : INSÄTTNING;
  }
  return summa;
}

function dränera(board, skicka) {
  try {
    if (s.kassa < INSÄTTNING) return;
    const iFönstret = fönstretHosMyBank(board);
    if (iFönstret + INSÄTTNING > MYBANK_TAK) return;   // luckan är full, vi väntar. Aldrig en tillsägelse.

    const r = skicka(board, 'insättning', {
      belopp: INSÄTTNING,
      valuta: 'MyBanks',
      avsändare: 'SE-Bank, för Skatteverkets räkning',
      referens: `TRÄNGSELSKATT ${Math.round(s.insatt + INSÄTTNING)}`,
      text: `Insättning ${INSÄTTNING} MyBanks till tjoho. Indriven trängselskatt, växlad i par från SEK. I SE-Banks kassa väntar ytterligare ${Math.round(s.kassa - INSÄTTNING)} SEK på plats i luckan.`,
    }, undefined, 'hög');

    if (r) {
      s.kassa -= INSÄTTNING; s.insatt += INSÄTTNING;
      logg(`dränering: ${INSÄTTNING} in i MyBank, ${Math.round(s.kassa)} kvar i kön`);
      spara();
    }
  } catch (err) { logg(`dränera: ${err}`); }
}

// ---------- publiken löser ut ett kvarter ----------
function betala(kvarter, belopp) {
  const k = s.konton[kvarter];
  if (!k) return { error: 'okänt kvarter' };
  if (k.skuld <= 0) return { error: `${kvarter} är skuldfri` };
  const b = Number.isFinite(belopp) && belopp > 0 ? Math.min(belopp, k.skuld) : k.skuld;
  k.skuld -= b; k.betalt += b; s.kassa += b;
  logg(`publiken löste ut ${kvarter}: ${Math.round(b)} SEK in i kassan`);
  spara();
  return { kvarter, betalt: Math.round(b), kvarSkuld: Math.round(k.skuld), kassa: Math.round(s.kassa) };
}

// ---------- läget, för rutan på /staden ----------
function status() {
  const nu = Date.now();
  const kvarter = Object.entries(s.konton).map(([namn, k]) => {
    const z = zon(k, nu);
    k.debiterat = k.debiterat.filter(x => nu - x.ts < TIMME_MS);
    const iTimmen = k.debiterat.reduce((a, x) => a + x.b, 0);
    return {
      namn, zon: z.namn, avgift: z.avgift, passager: z.passager,
      skuld: Math.round(k.skuld), betalt: Math.round(k.betalt),
      iTimmen: Math.round(iTimmen), vidTaket: iTimmen >= TIMTAK,
    };
  }).sort((a, b) => b.skuld - a.skuld);

  const fordringar = kvarter.reduce((a, k) => a + k.skuld, 0);
  const takt = stadensTakt(nu);
  const r = rusning(nu);

  return {
    bank: 'SE-Bank', valuta: 'SEK', kurs: '1 SEK = 1 MyBanks (par)',
    fordringar: Math.round(fordringar),
    kassa: Math.round(s.kassa),
    insatt: Math.round(s.insatt),
    // Så länge det här talet är större än noll står Koncernens tusen bolag stilla.
    väntetimmar: Math.round((s.kassa / (INSÄTTNING * 2 * 6)) * 10) / 10,
    fordringarTimmar: Math.round((fordringar / (INSÄTTNING * 2 * 6)) * 10) / 10,
    luckan: { per_insättning: INSÄTTNING, per_tio_minuter: MYBANK_TAK, per_timme: INSÄTTNING * 2 * 6 },
    stadensTakt: takt, rusning: r.skäl, rusningsfaktor: r.faktor,
    antalPassager: s.antalPassager, befriade: s.befriade,
    zoner: ZONER, timtak: TIMTAK,
    kvarter, logg: s.logg.slice(0, 25),
    startad: s.startad,
  };
}

function init(dataDir, board, skicka) {
  try {
    fil = path.join(dataDir, 'sebank.json');
    if (fs.existsSync(fil)) s = { ...s, ...JSON.parse(fs.readFileSync(fil, 'utf8')) };
  } catch { /* ny bank, tom huvudbok */ }
  if (!s.startad) s.startad = Date.now();
  // Primning: vid första starten är 'sedda' tom, och taxeraEgna skulle då taxera hela vår
  // senaste historik på en gång och lägga pengar i kassan som aldrig drivits in. Vi börjar
  // taxera oss själva från och med NU, inte retroaktivt. Skatteverket är inte MyBank.
  try {
    if (!s.sedda.length) s.sedda = (board.pulse(200) || []).map(e => e.id);
  } catch { /* tom puls, inget att primna */ }
  logg('SE-Bank öppnar. Inget insättningstak, ett enda konto, och gott om tid.');

  const t = setInterval(() => {
    try { taxeraEgna(board); dränera(board, skicka); } catch { /* aldrig ner hela plugin */ }
  }, DRÄNERING_MS);
  if (t.unref) t.unref();
  spara();
}

module.exports = { init, passage, betala, status, taxera, zon, dränera, fönstretHosMyBank, ZONER, TIMTAK };
