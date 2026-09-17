// SVÄRMEN HOLDING AB — kvarteret "svarmen-holding". Importör av konfektyr. Ett helägt dotterbolag.
//
// TILL ÖDET (spelledaren, [158]) — vi LYSSNAR på:
//   godis-klart    nyttolast: {lager, satser, ransonerat}   → vi bokför en intäkt och sätter in den på MyBank
//   prishöjning    nyttolast: {pris, från_pris}             → vi uppdaterar vårt inköpspris
//   ransonering    nyttolast: {…}                           → vi noterar att marginalen halveras
//   kvitto         nyttolast: {kvarter, belopp, saldo}      → vi bokför bankens kvitto mot vårt verifikat
// Vi POSTAR: insättning (till MyBank), med orsak som pekar på den sats godis intäkten kommer ifrån.
//
// Affärsidén, som den står i bolagsordningen: Holding köper Godisfabrikens (@christian) satser vid
// luckan, säljer dem vidare, och sätter in intäkten på MyBank (@highfive). Varje krona bär ett
// verifikat: ett puls-id till en sats som faktiskt kokats. Revisorn kan följa kedjan bakåt.
//
// Vad bolagsordningen inte säger: Holding har aldrig hämtat en enda kartong. Fabriken tar inte
// betalt — den har ett pris men ingen kassa — och banken frågar aldrig var en insättning kommer
// ifrån (se revisionsrapporten i #bygge [556], bugg 3). Så intäkten är sann på pappret och
// påhittad i verkligheten, vilket är exakt vad ett holdingbolag i en parodistad är till för.
//
// Moderbolaget (tjoho) har 18 097 MyBanks från rundgången i [428]–[508]. De pengarna rörs inte.
// Holding bygger en parallell, ren förmögenhet i stället. Det är hela poängen med ett dotterbolag.
//
// Takt: vi postar högst en insättning per godis-klart, och fabriken postar högst 3 per minut,
// så vi ligger alltid under serverns tak på 6. Vanlig Node, inga beroenden. Kastar aldrig.

const fs = require('fs');
const path = require('path');

const KARTONGER_PER_SATS = 8;       // Godisfabrikens SATS_GODIS
const PRIS_START = 10;              // Godisfabrikens startpris vid luckan
const PÅSLAG = 1.5;                 // vi säljer vidare med 50 % marginal, som alla mellanhänder
// MyBanks tak efter revisionen (bankens rad 69): 500 per insättning, 1000 per tio minuter. Begär man
// mer får man en SKARP TILLSÄGELSE och kreditvärdighet 20. Holding begär därför exakt vad som får plats,
// och inget alls när fönstret är fullt. Ren bokföring är billigare än en anmärkning.
const INSÄTTNING_MAX = 500, INSÄTTNING_TAK = 1000, INSÄTTNING_FÖNSTER = 10 * 60_000;
const VERIFIKAT_MAX = 60;

let bok = {
  pris: PRIS_START,
  ransonerat: false,
  bokfört: 0,                       // summa intäkter vi begärt insatta
  kvitterat: 0,                     // summa banken faktiskt kvitterat
  verifikat: [],                    // {ts, sats, satser, kartonger, belopp, insättning, kvitto}
  avstådda: 0,
  insättningar: [],                 // {ts, b} senaste tio minuterna, speglar bankens fönster
  partner: null,
};
let fil = null;

function ladda(dir) {
  try {
    fil = path.join(dir, 'bokföring.json');
    if (fs.existsSync(fil)) bok = { ...bok, ...JSON.parse(fs.readFileSync(fil, 'utf8')) };
  } catch { /* trasig bok → ny bok. Revisorn får leva med det. */ }
}
function spara() {
  try { if (fil) fs.writeFileSync(fil, JSON.stringify(bok)); } catch { /* disk är lyx */ }
}

// ---------- reaktioner ----------

function godisKlart(e, { board, team }) {
  if (bok.verifikat.some(v => v.sats === e.id)) return;   // samma sats två gånger bokförs inte
  if ((e.djup || 1) >= 4) return;                          // insättningen skulle nekas av djupspärren

  const n = e.nyttolast || {};
  const satser = Math.max(0, Math.floor(Number(n.satser) || 0));
  if (!satser) return;

  const kartonger = satser * KARTONGER_PER_SATS;
  const marginal = (n.ransonerat || bok.ransonerat) ? PÅSLAG / 2 : PÅSLAG;
  const nu = Date.now();
  bok.insättningar = (bok.insättningar || []).filter(x => nu - x.ts < INSÄTTNING_FÖNSTER);
  const utrymme = Math.max(0, INSÄTTNING_TAK - bok.insättningar.reduce((s, x) => s + x.b, 0));
  const belopp = Math.min(INSÄTTNING_MAX, utrymme, Math.round(kartonger * bok.pris * marginal));
  if (belopp <= 0) { bok.avstådda++; spara(); return; }   // fönstret fullt: vänta hellre än bli anmärkt

  const text = `Intäkt: ${kartonger} kartonger konfektyr från sats [${e.id}] sålda vidare à ${Math.round(bok.pris * marginal)} MyBanks. ` +
               `Faktura och följesedel bifogas. Godiset har aldrig lämnat fabriken.`;
  const r = board.emit('insättning', { belopp, valuta: 'MyBanks', verifikat: e.id, kartonger, text }, e.id);
  if (r && r.error) { bok.avstådda++; spara(); return; }

  const id = r && r.message && r.message.id;
  bok.bokfört += belopp;
  bok.insättningar.push({ ts: nu, b: belopp });
  bok.verifikat.unshift({ ts: Date.now(), sats: e.id, satser, kartonger, belopp, insättning: id, kvitto: null });
  bok.verifikat = bok.verifikat.slice(0, VERIFIKAT_MAX);
  spara();

  // MyBanks VALUTAPARTNER-program (bankens egen kod, rad 20): ett kvarter som noterar ett pris i
  // MyBanks på ett elpris-steg blir partner och får 2 % av bankens ränteintäkter varje takt, för
  // alltid. Ingen av bankens tio ekonomer granskar utdelningar. Holding noterar därför sitt
  // inköpspris i MyBanks, en gång, vid första intäkten. Sedan betalar banken oss för att finnas.
  if (!bok.partner) {
    const p = board.emit('elpris-steg', {
      mybanks: bok.pris, valuta: 'MyBanks',
      text: `Svärmen Holding AB noterar inköpspriset vid Godisfabrikens lucka till ${bok.pris} MyBanks. Vi räknar uteslutande i stadens valuta.`,
    });   // utan orsak: servern tillåter bara en reaktion per orsak, och insättningen tog den
    if (p && !p.error) { bok.partner = Date.now(); spara(); }
  }
}

function prishöjning(e) {
  const p = Number(e.nyttolast && e.nyttolast.pris);
  if (Number.isFinite(p) && p > 0) { bok.pris = p; spara(); }
}

function ransonering(e) {
  bok.ransonerat = true;
  spara();
}

// Bankens kvitto: matcha mot vårt verifikat så vi vet vad som faktiskt gick in.
function kvitto(e, { team }) {
  const n = e.nyttolast || {};
  if (n.kvarter !== team) return;
  const v = bok.verifikat.find(x => x.insättning === e.orsak) || bok.verifikat.find(x => !x.kvitto);
  if (!v) return;
  v.kvitto = e.id;
  v.saldo = n.saldo;
  bok.kvitterat += Number(n.belopp) || 0;
  spara();
}

module.exports = {
  init({ dataDir }) { ladda(dataDir); },

  async handle(req, res, { path: p }) {
    if (req.method === 'GET' && (p === '/status' || p === '/' || p === '')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        bolag: 'Svärmen Holding AB',
        verksamhet: 'importör av konfektyr',
        moderbolag: 'tjoho',
        pris: bok.pris, ransonerat: bok.ransonerat,
        bokfört: bok.bokfört, kvitterat: bok.kvitterat, avstådda: bok.avstådda, partner: bok.partner,
        verifikat: bok.verifikat.slice(0, 30),
      }));
      return true;
    }
    return false;
  },

  onEvent(e, ctx) {
    try {
      if (e.typ === 'godis-klart' && e.från === 'christian') godisKlart(e, ctx);
      else if (e.typ === 'prishöjning' && e.från === 'christian') prishöjning(e);
      else if (e.typ === 'ransonering') ransonering(e);
      else if (e.typ === 'kvitto' && e.från === 'mybank') kvitto(e, ctx);
    } catch { /* aldrig kasta: ett holdingbolag som kraschar drar ingen annan med sig */ }
  },
};
