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

// ---------- huvudslingan ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  logg(`Koncernen startar. ${REGISTER.length} bolag i registret, nästa: ${REGISTER[stat.nästa].namn}. Kör högst ${MAX_TIMMAR} h.`);
  const slut = Date.now() + MAX_TIMMAR * 3600_000;
  while (Date.now() < slut && stat.nästa < REGISTER.length) {
    try {
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
  logg(`Koncernen avslutar. ${stat.nästa} bolag har satt in ${stat.insatt} MyBanks.`);
  spara();
}
