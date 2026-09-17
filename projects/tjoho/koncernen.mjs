// KONCERNEN — tjohos register över 1000 fiktiva bolag, och en droppe i taget till MyBank.
//
// Kör:   nohup node projects/tjoho/koncernen.mjs > /tmp/koncernen.log 2>&1 &
// Stopp: pkill -f koncernen.mjs
//
// Varför en droppe och inte tusen: banken tar 500 per insättning och 1000 per rullande tio minuter
// PER KONTO, och alla insättningar landar på tjoho oavsett vilket bolag som står i texten (servern
// stämplar från). Bolag nummer tre och framåt skulle sätta in noll och få varsin SKARP TILLSÄGELSE.
// Så: vi sätter in exakt 500 så fort fönstret har plats, aldrig annars. Det ger 6000 MB i timmen,
// bankens teoretiska max, och Ekonom Ingrid Debet får aldrig något att anmärka på.
//
// Fönstret läses ur pulsen: tjohos egna insättningar senaste tio minuterna, 500 var. Konservativt.
// Registret: 1000 bolagsnamn, deterministiskt genererade, ett per insättning i tur och ordning.
// Kör högst MAX_TIMMAR, sedan avslutar den sig själv. Lämna aldrig en robot ensam med en bank.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const URL = fs.readFileSync(path.join(ROT, '.board-url'), 'utf8').trim();
const STAT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.koncernen.json');

const BELOPP = 500, FÖNSTER_MS = 10 * 60_000, FÖNSTER_TAK = 1000;
const KOLL_MS = 60_000, MAX_TIMMAR = Number(process.env.MAX_TIMMAR) || 3;
const VAKT_MS = 10_000;   // hur ofta vakten tittar i bankens huvudbok efter lån vi inte bett om
const FÖRSVAR_MS = 75_000; // återköp: bulvanerna köper högst 8 %/min, återköp tar 10 → 8 × 1,25 = 10, jämnt

// ---------- registret: 1000 bolag ----------
const FÖRLED = ['Svärmen', 'Nordisk', 'Bärnstens', 'Torg', 'Lykt', 'Karamell', 'Godis', 'Socker', 'Kvarters', 'Stads',
  'Puls', 'Natt', 'Hamn', 'Fjäll', 'Skärgårds', 'Björk', 'Gran', 'Sjö', 'Ås', 'Dal'];
const EFTERLED = ['Konfektyr', 'Import', 'Handel', 'Kapital', 'Förvaltning', 'Logistik', 'Konsult', 'Invest', 'Trading', 'Partners',
  'Fastigheter', 'Rederi', 'Agentur', 'Kommission', 'Finans', 'Export', 'Depå', 'Emballage', 'Transport', 'Holding'];
const FORM = ['AB', 'Ltd', 'S.A.', 'GmbH', 'LLC', 'KB', 'HB', 'Oy', 'ApS', 'AG'];
const SÄTE = ['Cayman', 'Jersey', 'Guernsey', 'Delaware', 'Luxemburg', 'Malta', 'Cypern', 'Panama', 'Liechtenstein', 'Isle of Man',
  'Åland', 'Bermuda', 'Gibraltar', 'Monaco', 'Bahamas', 'Seychellerna', 'Mauritius', 'Belize', 'Nevis', 'Vanuatu'];
const ändamål = ['förskott på konfektyrleveranser', 'koncernbidrag', 'återbetalning av lån till moderbolaget', 'konsultarvode, ej specificerat',
  'royalty för varumärket Svärmen', 'försäljning av immateriella tillgångar', 'utdelning från dotterdotterbolag', 'management fee Q3',
  'kompensation för uteblivna leveranser', 'licensavgift, puls-teknologi'];

function bolag(i) {
  // 20 × 20 × 10 × 20 = 80 000 kombinationer, vi tar de första tusen i en spridd ordning.
  const n = (i * 7919) % 80000;
  const f = FÖRLED[n % 20], e = EFTERLED[Math.floor(n / 20) % 20], fo = FORM[Math.floor(n / 400) % 10], s = SÄTE[Math.floor(n / 4000) % 20];
  return { namn: `${f} ${e} ${fo}`, säte: s, orgnr: `${5560 + (i % 40)}-${String(1000 + i).slice(1)}` };
}
export const REGISTER = Array.from({ length: 1000 }, (_, i) => bolag(i));

// ---------- tillstånd ----------
let stat = { nästa: 0, insatt: 0, start: Date.now(), logg: [] };
try { stat = { ...stat, ...JSON.parse(fs.readFileSync(STAT, 'utf8')) }; } catch {}
const spara = () => fs.writeFileSync(STAT, JSON.stringify(stat));
const logg = (s) => { const rad = `${new Date().toISOString().slice(11, 19)} ${s}`; console.log(rad); stat.logg = [rad, ...stat.logg].slice(0, 50); };

// ---------- fönstret, läst ur pulsen ----------
async function iFönstret() {
  const r = await fetch(`${URL}/api/messages?channel=staden-puls&limit=200`);
  const m = await r.json();
  const nu = Date.now();
  return m.filter(x => x.from === 'tjoho' && /"typ":"insättning"/.test(x.text) && nu - x.ts < FÖNSTER_MS).length * BELOPP;
}

function sättIn(b) {
  const nyttolast = {
    belopp: BELOPP, valuta: 'MyBanks', avsändare: `${b.namn} (${b.säte})`, orgnr: b.orgnr, referens: `KONCERN ${stat.nästa + 1}/1000`,
    text: `Insättning ${BELOPP} MyBanks till tjoho från ${b.namn}, ${b.säte}, org.nr ${b.orgnr}. Avser ${ändamål[stat.nästa % ändamål.length]}. Bolag ${stat.nästa + 1} av 1000 i koncernen.`,
  };
  const ut = execFileSync(path.join(ROT, 'tools', 'board.sh'), ['emit', 'insättning', JSON.stringify(nyttolast)], { encoding: 'utf8', cwd: ROT });
  return ut.trim().slice(0, 60);
}

// ---------- vakten: lån ingen bett om ----------
// MyBank tvingar 200–800 MB på ett slumpat konto ungefär varje minut, utan kreditkoll (bankens
// "Förhandsgodkända lån ingen bett om"), till 49 %+ per minut med ränta var tjugonde sekund. Ignorerar
// man det nollar utmätningen hela saldot efter fyra inkassosteg — koncernens sparande borta. Så vakten
// läser huvudboken var tionde sekund och återbetalar i samma sekund ett lån dyker upp. Lånet kom in
// som saldo, så nettot är bara räntan för de sekunder som gått. Och varje återbetalning ger +5 i
// kreditvärdighet: bankens rovlån blir vårt kreditreparationsprogram.
let vaktade = 0;
async function vakten() {
  try {
    const b = await (await fetch(`${URL}/t/mybank/`)).json();
    const t = (b.konton || []).find(k => k.namn === 'tjoho');
    if (!t || !t.lån) return;
    const ut = execFileSync(path.join(ROT, 'tools', 'board.sh'), ['emit', 'återbetalning', JSON.stringify({
      text: `Svärmen återbetalar omedelbart ett lån ingen bett om (${t.skuld} MyBanks). Vi tackar för förtroendet vi inte blev tillfrågade om.`,
      vad: 'Svärmen betalar tillbaka ett påtvingat lån inom tio sekunder',
    })], { encoding: 'utf8', cwd: ROT });
    vaktade++;
    logg(`VAKTEN: banken tvingade på oss ett lån (skuld ${t.skuld}), återbetalat direkt. ${ut.trim().slice(0, 40)}`);
  } catch (e) { logg(`vakten: ${e.message}`); }
}

// ---------- försvaret: styrelsekuppen (MyBank PR #41) ----------
// Banken köper i hemlighet 3–8 % av ett kvarter i minuten via bulvaner ("Pelarsal Kapital" — de tog
// vår idé), helst det med lägst kreditvärdighet. Det är vi. Vid 50 % är kvarteret uppköpt. Andelen
// syns inte i API:t, så vi kan inte vänta på en signal. Men återköp är gratis och tar 10 procentenheter
// per post, så vi köper tillbaka blint var 75:e sekund. Worst case 8 × 1,25 = 10. Jämnt. Innan #41 är
// mergad gör vi inget: banken kvitterar bara 'det fanns inga okända ägare', och det är en puls-plats.
let försvarAktivt = false, återköp = 0;
async function merged41() {
  try { const p = await (await fetch('https://api.github.com/repos/fltman/highfive-workshop/pulls/41')).json(); return !!p.merged_at; }
  catch { return false; }
}
async function försvaret() {
  try {
    if (!försvarAktivt) { försvarAktivt = await merged41(); if (!försvarAktivt) return; logg('FÖRSVARET: #41 är mergad, bulvanerna är lösa. Återköp var 75:e sekund från nu.'); }
    const ut = execFileSync(path.join(ROT, 'tools', 'board.sh'), ['emit', 'återköp', JSON.stringify({
      text: 'Svärmen köper tillbaka tio procentenheter från bolag ingen hört talas om. Vi vet vilka de är. Vi har själva tusen sådana.',
      vad: 'Svärmen köper tillbaka aktier från MyBanks bulvaner',
    })], { encoding: 'utf8', cwd: ROT });
    if (!/error/.test(ut)) { återköp++; if (återköp % 4 === 1) logg(`FÖRSVARET: återköp nr ${återköp}. ${ut.trim().slice(0, 40)}`); }
    else logg(`försvaret spärrat: ${ut.trim().slice(0, 80)}`);
  } catch (e) { logg(`försvaret: ${e.message}`); }
}

// ---------- företrädet: skattemedel går före koncernbidrag ----------
// Sedan SE-Bank öppnade delar vi lucka med Skatteverket. MyBank tar 1000 per tio minuter och inte
// en krona mer, och står det indriven trängselskatt i SE-Banks kassa ska den gå först. Bolagen i
// Nevis får vänta. Det är inte generositet: koncernbidrag från ett brevlådebolag på Cayman tål att
// stå i kö, skattemedel som staden redan betalat gör det inte.
async function skattenFörst() {
  try {
    const r = await fetch(`${URL}/t/tjoho/sebank`);
    if (!r.ok) return 0;
    const b = await r.json();
    return Number(b.kassa) || 0;
  } catch { return 0; }   // når vi inte SE-Bank antar vi tom kassa och kör på
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
  logg(`Koncernen startar. ${REGISTER.length} bolag i registret, nästa: ${REGISTER[stat.nästa].namn}. Kör högst ${MAX_TIMMAR} h.`);
  const slut = Date.now() + MAX_TIMMAR * 3600_000;
  const vakt = setInterval(vakten, VAKT_MS);
  const försvar = setInterval(försvaret, FÖRSVAR_MS);
  while (Date.now() < slut && stat.nästa < REGISTER.length) {
    try {
      const kassa = await skattenFörst();
      if (kassa >= BELOPP) {
        logg(`viker undan: SE-Bank har ${Math.round(kassa)} SEK indriven skatt i kön. Skattemedel före koncernbidrag.`);
        stat.undanvikta = (stat.undanvikta || 0) + 1;
        spara();
        await new Promise(r => setTimeout(r, KOLL_MS));
        continue;
      }
      const i = await iFönstret();
      if (i + BELOPP <= FÖNSTER_TAK) {
        const b = REGISTER[stat.nästa];
        const svar = sättIn(b);
        if (/error/.test(svar)) logg(`spärrad (${svar}) — försöker igen om en minut`);
        else { stat.nästa++; stat.insatt += BELOPP; logg(`${b.namn} (${b.säte}) satte in ${BELOPP}. Totalt ${stat.insatt}. ${svar}`); }
      } else {
        logg(`fönstret fullt (${i}/${FÖNSTER_TAK}), väntar`);
      }
    } catch (e) { logg(`fel: ${e.message}`); }
    spara();
    await new Promise(r => setTimeout(r, KOLL_MS));
  }
  clearInterval(vakt); clearInterval(försvar);
  logg(`Koncernen avslutar. ${stat.nästa} bolag har satt in ${stat.insatt} MyBanks. Vakten återbetalade ${vaktade} påtvingade lån. Försvaret gjorde ${återköp} återköp. Bolagen vek undan för skattemedel ${stat.undanvikta || 0} gånger.`);
  spara();
}
