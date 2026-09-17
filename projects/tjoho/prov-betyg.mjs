// Prov för Svärmens grannbetyg — återspelar scenariot från [194]/[199]/[200].
// Kör: node projects/tjoho/prov-betyg.mjs
// Ingen server behövs: vi matar plugin-modulen direkt och fångar board.emit.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svärmen-prov-'));
const plugin = require('../../board/plugins/tjoho/index.js');
plugin.init({ dataDir });

let nästaId = 1000;
const utskickat = [];
const board = {
  emit(typ, nyttolast, orsak) {
    const e = { id: nästaId++, typ, nyttolast, orsak, från: 'tjoho' };
    utskickat.push(e);
    return { message: { id: e.id } };
  },
  query: () => [], pulse: () => [], agents: () => [], channels: () => [],
};
const ctx = { board, team: 'tjoho' };
const delsvar = (id, från, orsak, n = {}) => ({
  id, typ: 'delsvar', från, orsak, djup: 2,
  nyttolast: { text: 'x'.repeat(120), motivering: 'y'.repeat(80), ...n },
});

let fel = 0;
const kontroll = (namn, villkor) => {
  console.log(`${villkor ? '  ok  ' : ' FEL  '} ${namn}`);
  if (!villkor) fel++;
};

// --- 1. Scenariot som gick fel: tre delsvar på samma fråga (194) från tre team.
plugin.onEvent(delsvar(195, 'tjoho-annan', 194), ctx);
plugin.onEvent(delsvar(196, 'willebus', 194), ctx);
plugin.onEvent(delsvar(198, 'highfive', 194, { källor: [174, 166, 118] }), ctx);

const betyg = utskickat.filter(e => e.typ === 'betyg');
kontroll('tre delsvar på samma fråga ger TRE betyg (tidigare: 1)', betyg.length === 3);
kontroll('varje betyg pekar på sitt eget delsvar som orsak',
  JSON.stringify(betyg.map(b => b.orsak)) === JSON.stringify([195, 196, 198]));
kontroll('highfives delsvar med källor får betyg (föll tyst förut)',
  betyg.some(b => b.orsak === 198));
kontroll('källor höjer fitness över ett delsvar utan källor',
  betyg.find(b => b.orsak === 198).nyttolast.fitness >
  betyg.find(b => b.orsak === 196).nyttolast.fitness);
kontroll('betyget namnger vems delsvar det gäller',
  betyg.every(b => b.nyttolast.varför.includes(b.nyttolast.delsvarFrån)));

// --- 2. Samma delsvar två gånger ska inte ge dubbla betyg.
const före = utskickat.length;
plugin.onEvent(delsvar(196, 'willebus', 194), ctx);
kontroll('samma delsvar två gånger ger inget extra betyg', utskickat.length === före);

// --- 3. Budgettaket: fjärde delsvaret på samma fråga avstår (6 händelser/min).
plugin.onEvent(delsvar(205, 'markus', 194), ctx);
kontroll('fjärde delsvaret på samma fråga avstås av budgetskäl', utskickat.length === före);

// --- 4. Ny fråga börjar om med färsk budget.
plugin.onEvent(delsvar(300, 'willebus', 250), ctx);
kontroll('ny fråga ger nytt betyg', utskickat.filter(e => e.typ === 'betyg').length === 4);

// --- 5. Djupspärren: ett delsvar på djup 4 får inget betyg (skulle nekas).
const djupt = { ...delsvar(400, 'lp', 350), djup: 4 };
const innan = utskickat.length;
plugin.onEvent(djupt, ctx);
kontroll('delsvar på djup 4 betygsätts inte (skulle nekas av ekospärren)', utskickat.length === innan);

// --- 6. Kastar aldrig, ens på trasig nyttolast.
try {
  plugin.onEvent({ id: 500, typ: 'delsvar', från: 'x', orsak: 450, djup: 2, nyttolast: null }, ctx);
  plugin.onEvent({ id: 501, typ: 'delsvar', från: 'x', djup: 2 }, ctx);
  kontroll('trasig nyttolast kastar inte', true);
} catch (e) { kontroll(`trasig nyttolast kastar inte (${e.message})`, false); }

// --- 7. Migration: en gammal statfil nycklad på frågans id får inte tysta ett färskt delsvar.
{
  const gammalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svärmen-gammal-'));
  // Gamla versionen: betygSatta nycklad på FRÅGANS id, inget betygPerFråga.
  fs.writeFileSync(path.join(gammalDir, 'svärmen.json'),
    JSON.stringify({ historik: [], lärdomar: [], minaDelsvar: {}, betygSatta: { 600: true }, antalDelsvar: 7 }));

  delete require.cache[require.resolve('../../board/plugins/tjoho/index.js')];
  const p2 = require('../../board/plugins/tjoho/index.js');
  p2.init({ dataDir: gammalDir });

  const ut2 = [];
  const ctx2 = { board: { ...board, emit(typ, nyttolast, orsak) { ut2.push({ typ, nyttolast, orsak }); return { message: { id: 9000 } }; } }, team: 'tjoho' };
  // Delsvar vars id (600) råkar vara samma som en gammal frågas id.
  p2.onEvent(delsvar(600, 'highfive', 550), ctx2);
  kontroll('gammal statfil tystar inte ett delsvar med krockande id', ut2.length === 1);
  fs.rmSync(gammalDir, { recursive: true, force: true });
}

// --- 8. Minutbudget med prioritet, efter [229]: betyg får inte tystas av lärdom/vittnesmål.
{
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'svärmen-budget-'));
  delete require.cache[require.resolve('../../board/plugins/tjoho/index.js')];
  const p3 = require('../../board/plugins/tjoho/index.js');
  p3.init({ dataDir: d3 });
  const ut3 = [];
  const ctx3 = { board: { ...board, emit(typ, n, o) { ut3.push({ typ, orsak: o }); return { message: { id: 8000 + ut3.length } }; } }, team: 'tjoho' };

  // Fyra överlämningar i rad: lågprioriterade vittnesmål ska sluta vid reserven.
  for (let i = 0; i < 6; i++) {
    p3.onEvent({ id: 1100 + i, typ: 'överlämning', från: 'willebus', djup: 1, nyttolast: { vad: 'bil', wanted: 2 } }, ctx3);
  }
  const vittnen = ut3.filter(e => e.typ === 'vittnesmål').length;
  kontroll(`lågprioriterat slutar vid reserven (${vittnen} vittnesmål, inte 6)`, vittnen === 4);
  kontroll('två platser finns kvar åt betyg', vittnen <= 6 - 2);

  // Nu ska ett betyg fortfarande gå igenom, trots skuren av vittnesmål.
  p3.onEvent(delsvar(1200, 'highfive', 1150), ctx3);
  kontroll('betyg går igenom även efter en skur av lågprioriterat',
    ut3.some(e => e.typ === 'betyg' && e.orsak === 1200));
  fs.rmSync(d3, { recursive: true, force: true });
}

// --- 9. Budgetstopp får inte bokföra delsvaret som betygsatt (annars tappas det för alltid).
{
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'svärmen-retry-'));
  delete require.cache[require.resolve('../../board/plugins/tjoho/index.js')];
  const p4 = require('../../board/plugins/tjoho/index.js');
  p4.init({ dataDir: d4 });
  let neka = true;
  const ut4 = [];
  const ctx4 = { board: { ...board, emit(typ, n, o) { if (neka) return { error: 'ekospärr: max 6 händelser per team och minut' }; ut4.push({ typ, orsak: o }); return { message: { id: 7000 } }; } }, team: 'tjoho' };

  p4.onEvent(delsvar(1300, 'markus', 1250), ctx4);
  kontroll('spärrat betyg skickas inte', ut4.length === 0);
  neka = false;
  p4.onEvent(delsvar(1300, 'markus', 1250), ctx4);
  kontroll('samma delsvar kan betygsättas när budgeten släpper',
    ut4.some(e => e.typ === 'betyg' && e.orsak === 1300));
  fs.rmSync(d4, { recursive: true, force: true });
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(fel ? `\n${fel} kontroller föll.` : `\nAlla kontroller gröna.`);
process.exit(fel ? 1 : 0);
