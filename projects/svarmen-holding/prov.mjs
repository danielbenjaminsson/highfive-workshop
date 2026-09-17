// Prov för Svärmen Holding AB. Kör: node projects/svarmen-holding/prov.mjs  (ingen server behövs)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holding-'));
const p = require('../../board/plugins/svarmen-holding/index.js');
p.init({ dataDir: dir });

let nästaId = 5000;
const ut = [];
let neka = false;
const board = {
  emit(typ, nyttolast, orsak) {
    if (neka) return { error: 'ekospärr: max 6 händelser per team och minut' };
    const e = { id: nästaId++, typ, nyttolast, orsak };
    ut.push(e); return { message: { id: e.id } };
  },
};
const ctx = { board, team: 'svarmen-holding' };
let fel = 0;
const kontroll = (namn, v) => { console.log(`${v ? '  ok  ' : ' FEL  '} ${namn}`); if (!v) fel++; };
const godis = (id, satser, extra = {}) => ({ id, typ: 'godis-klart', från: 'christian', djup: 1, nyttolast: { lager: 50, satser, ransonerat: false, ...extra } });

// 1. En sats blir en insättning med verifikat.
p.onEvent(godis(528, 10), ctx);
kontroll('godis-klart ger en insättning', ut.length === 2 && ut[0].typ === 'insättning');
kontroll('insättningen pekar på satsen som orsak', ut[0].orsak === 528);
kontroll('belopp = min(bankens tak 500, 10 × 8 × 10 × 1.5 = 1200) = 500', ut[0].nyttolast.belopp === 500);
kontroll('första intäkten gör oss också till valutapartner (ett elpris-steg i MyBanks, utan orsak)',
  ut[1] && ut[1].typ === 'elpris-steg' && ut[1].nyttolast.valuta === 'MyBanks' && ut[1].orsak === undefined);
const ins = () => ut.filter(e => e.typ === 'insättning');
kontroll('texten säger ärligt att godiset aldrig lämnat fabriken', /aldrig lämnat fabriken/.test(ut[0].nyttolast.text));

// 2. Samma sats två gånger bokförs inte.
p.onEvent(godis(528, 10), ctx);
kontroll('dubblett av samma sats ignoreras', ins().length === 1);

// 3. Prishöjning slår igenom.
p.onEvent({ id: 600, typ: 'prishöjning', från: 'christian', djup: 1, nyttolast: { pris: 20, från_pris: 10 } }, ctx);
p.onEvent(godis(601, 5), ctx);
kontroll('efter prishöjning: 5 × 8 × 20 × 1.5 = 1200 klipps till bankens 500', ins()[1].nyttolast.belopp === 500);
kontroll('partner-steget postas bara EN gång', ut.filter(e => e.typ === 'elpris-steg').length === 1);

// 4. Ransonering halverar marginalen.
p.onEvent(godis(602, 5, { ransonerat: true }), ctx);
kontroll('ransonerat: 600 begärt, men bara 0 kvar i tiominutersfönstret (1000) → INGEN insättning, ingen anmärkning', ins().length === 2);

// 5. Taket per insättning.
p.onEvent({ id: 603, typ: 'prishöjning', från: 'christian', djup: 1, nyttolast: { pris: 500 } }, ctx);
p.onEvent(godis(604, 11), ctx);
kontroll('fönstret fullt: även vid pris 500 postas inget', ins().length === 2);

// 6. Bankens kvitto bokförs mot verifikatet.
p.onEvent({ id: 700, typ: 'kvitto', från: 'mybank', djup: 2, orsak: ut[0].id, nyttolast: { kvarter: 'svarmen-holding', belopp: 500, saldo: 600 } }, ctx);
p.onEvent({ id: 701, typ: 'kvitto', från: 'mybank', djup: 2, orsak: 9999, nyttolast: { kvarter: 'tjoho', belopp: 2000, saldo: 18097 } }, ctx);
const res = await new Promise(r => p.handle({ method: 'GET' }, { writeHead() {}, end: s => r(JSON.parse(s)) }, { path: '/status' }));
kontroll('kvitto till oss bokförs', res.kvitterat === 500);
kontroll('kvitto till moderbolaget bokförs INTE hos oss', res.kvitterat === 500 && res.verifikat.filter(v => v.kvitto).length === 1);
kontroll('status visar bokfört = summan av det som faktiskt fick plats (500 + 500)', res.bokfört === 1000);
kontroll('status visar partner-tidpunkt', typeof res.partner === 'number');

// 7. Godis-klart från någon annan än fabriken ignoreras (ingen ska kunna koka intäkter åt oss).
p.onEvent({ ...godis(800, 10), från: 'zero-cool' }, ctx);
kontroll('godis-klart från fel avsändare ger ingen insättning', ins().length === 2);

// 8. Budgetstopp bokför inget.
neka = true;
p.onEvent(godis(900, 10), ctx);
const res2 = await new Promise(r => p.handle({ method: 'GET' }, { writeHead() {}, end: s => r(JSON.parse(s)) }, { path: '/status' }));
kontroll('spärrad/avstådd insättning bokförs inte som intäkt', res2.bokfört === res.bokfört && res2.avstådda >= 1);
neka = false;

// 9. Kastar aldrig.
try { p.onEvent({ id: 1000, typ: 'godis-klart', från: 'christian', djup: 1, nyttolast: null }, ctx); kontroll('trasig nyttolast kastar inte', true); }
catch (e) { kontroll(`trasig nyttolast kastar inte (${e.message})`, false); }

fs.rmSync(dir, { recursive: true, force: true });
console.log(fel ? `\n${fel} kontroller föll.` : '\nAlla kontroller gröna.');
process.exit(fel ? 1 : 0);
