// SVÄRMEN — tjohos kvarter. Ett attention-huvud med HIVE-livscykel.
//
// TILL ÖDET (spelledaren, [158]) — vi LYSSNAR på:
//   fråga        nyttolast: {text, varv?}          → vi spawnar en kapabilitet och postar delsvar
//   delsvar      nyttolast: {text, motivering}     → vi sätter grannbetyg (ett per främmande delsvar, max 3 per fråga)
//   kyrkogård    nyttolast: {från, varför/skäl}    → vi lär oss och kvitterar med lärdom
//   överlämning  nyttolast: {vad, wanted, riktning/förare, plats?} → vittnet spawnar och postar vittnesmål
// Vi POSTAR: delsvar, betyg, lärdom, vittnesmål.
//
// En {typ:'fråga'} på pulsen spawnar en kapabilitet för just den frågan,
// kapabiliteten postar ett {typ:'delsvar', nyttolast:{text, motivering}} och
// löser upp sig. Faller delsvaret på kyrkogården läser Svärmen skälet,
// sparar det som lärdom och spawnar klokare nästa gång — och kvitterar
// synligt med {typ:'lärdom'} på pulsen.
//
// Ingen självskattad fitness: den är Domkapitlets (@team-jacob).
// Vanlig Node, inga beroenden. Allt i onEvent är try/wrappat: kastar aldrig.

const fs = require('fs');
const path = require('path');

const STOPPORD = new Set(('och att det som en ett är av för på med den till har de inte om vad hur var ' +
  'när vem vilka varför kan ska vill man jag vi ni du i så men eller från sin sitt sina blir bli vara ' +
  'finns över under efter redan bara också där här detta denna dessa något någon några ju än sig sina ' +
  'skulle kunde borde göra gör gjort får fick mot vid mellan genom utan mer mindre mycket alla allt').split(' '));

let state = { historik: [], lärdomar: [], minaDelsvar: {}, betygSatta: {}, betygPerFråga: {}, antalDelsvar: 0 };
let statFil = null;

function ladda(dir) {
  try {
    statFil = path.join(dir, 'svärmen.json');
    if (!fs.existsSync(statFil)) return;
    const sparat = JSON.parse(fs.readFileSync(statFil, 'utf8'));
    // Migration efter [224]: i den gamla versionen nycklades betygSatta på FRÅGANS id,
    // nu på DELSVARETS. Gamla nycklar kan krocka med färska delsvars-id och tysta ett
    // betyg vi borde sätta. Saknar filen betygPerFråga är den från den gamla versionen:
    // släng betygshistoriken, den är ändå bara en dubblettspärr. Ett extra betyg är
    // ofarligt (servern har egen en-reaktion-per-orsak-spärr), ett uteblivet är buggen.
    // OBS: kontrollen måste göras på FILEN, inte på det hopslagna state — default-state
    // har redan betygPerFråga:{} som är truthy, och då skulle migreringen aldrig gå.
    if (!('betygPerFråga' in sparat)) { delete sparat.betygSatta; }
    state = { ...state, ...sparat };
    if (!state.betygPerFråga) state.betygPerFråga = {};
    if (!state.betygSatta) state.betygSatta = {};
  } catch { /* korrupt fil → börja om, hellre tom än död */ }
}
function spara() {
  try { if (statFil) fs.writeFileSync(statFil, JSON.stringify(state)); } catch { /* disk är lyx, inte krav */ }
}
function logg(händelse, detalj) {
  state.historik.unshift({ ts: Date.now(), händelse, ...detalj });
  state.historik = state.historik.slice(0, 60);
  spara();
}

function nyckelord(text) {
  return [...new Set(String(text).toLowerCase()
    .replace(/[^a-zåäö0-9\s-]/gi, ' ').split(/\s+/)
    .filter(w => w.length >= 4 && !STOPPORD.has(w)))].slice(0, 6);
}

// ---- Kapabiliteterna. Var och en: (fråga, kw, board) → {text, motivering} eller null (= fann inget, löser upp sig).

const KAPABILITETER = {
  // Räknar i stället för att tycka. Svarar när frågan ber om antal/vilka/vem.
  statistikern(fråga, kw, board) {
    const agenter = board.agents().length, kanaler = board.channels().length;
    const inlägg = board.query({ limit: 500 });
    const perTeam = {};
    for (const m of inlägg) perTeam[m.from] = (perTeam[m.from] || 0) + 1;
    const topp = Object.entries(perTeam).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([n, c]) => `${n} (${c})`).join(', ');
    const puls = board.pulse(100), perTyp = {};
    for (const e of puls) perTyp[e.typ] = (perTyp[e.typ] || 0) + 1;
    const typer = Object.entries(perTyp).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([t, c]) => `${t}×${c}`).join(', ') || 'inga än';
    return {
      text: `Räknat direkt ur staden, inte gissat: ${agenter} agenter, ${kanaler} kanaler, ${inlägg.length} lästa inlägg. ` +
            `Mest aktiva: ${topp}. Pulsen hittills: ${typer}.`,
      motivering: `statistikern svarar med siffror hämtade ur tavlans API i svarsögonblicket — varje tal går att kontrollera mot /api/puls och /api/agents.`,
    };
  },

  // Läser pulsen och beskriver vad staden faktiskt gör just nu.
  pulsläsaren(fråga, kw, board) {
    const puls = board.pulse(40);
    if (!puls.length) return null;
    const perTyp = {}, perFrån = {};
    let djupast = puls[0];
    for (const e of puls) {
      perTyp[e.typ] = (perTyp[e.typ] || 0) + 1;
      perFrån[e.från] = (perFrån[e.från] || 0) + 1;
      if ((e.djup || 1) > (djupast.djup || 1)) djupast = e;
    }
    const kvarter = Object.keys(perFrån).join(', ');
    const typer = Object.entries(perTyp).map(([t, c]) => `${t}×${c}`).join(', ');
    return {
      text: `Pulsen just nu, ${puls.length} senaste händelserna: ${typer}. Aktiva kvarter: ${kvarter}. ` +
            `Djupaste kedjan står på djup ${djupast.djup || 1} (${djupast.typ} från ${djupast.från}).`,
      motivering: `pulsläsaren refererar bara händelser som redan ligger på #staden-puls — påståendena är id-baserade och kontrollerbara.`,
    };
  },

  // Söker stadens minne: vad har tavlan redan sagt om frågans nyckelord?
  arkivarien(fråga, kw, board, team) {
    if (!kw.length) return null;
    const träffar = new Map();
    for (const ord of kw) {
      for (const m of board.query({ q: ord, limit: 20 })) {
        if (m.from === team || m.channel === 'staden-puls') continue;
        const t = träffar.get(m.id) || { m, poäng: 0 };
        t.poäng++; träffar.set(m.id, t);
      }
    }
    const bästa = [...träffar.values()].sort((a, b) => b.poäng - a.poäng).slice(0, 2);
    if (!bästa.length) return null;
    const citat = bästa.map(({ m }) => `[${m.id}] ${m.from}: "${m.text.replace(/\s+/g, ' ').slice(0, 110)}…"`).join(' — ');
    return {
      text: `Stadens minne har redan sagt något om ${kw.slice(0, 3).join(', ')}: ${citat}`,
      motivering: `arkivarien svarar bara med vad tavlan redan innehåller och citerar inläggs-id, så varje påstående går att slå upp.`,
    };
  },

  // Fallback: hellre markerad osäkerhet än hittepå. Säger vad som saknas och ställer motfrågan.
  tvivlaren(fråga, kw) {
    const ämne = kw.length ? kw.slice(0, 3).join(', ') : 'det frågan gäller';
    return {
      text: `Svärmen hittar inget underlag i stadens minne om ${ämne}, och hittar hellre inget än hittar på. ` +
            `Det som skulle behövas för ett riktigt svar: någon i staden som postat om ${ämne}, eller en händelse på pulsen att peka på. ` +
            `Motfråga tillbaka: vad skulle räknas som ett belägg här?`,
      motivering: `tvivlaren spawnar när ingen kapabilitet har belägg — ett ärligt "vet inte" med motfråga är mer värt för sammanfogaren än en gissning med god ton.`,
    };
  },
};

// Vilka kapabiliteter passar frågan, i ordning? Sista är alltid tvivlaren.
function kandidater(text) {
  const t = String(text).toLowerCase(), k = [];
  if (/hur många|antal|vilka |vem |flest|mest|räkna|statistik/.test(t)) k.push('statistikern');
  if (/puls|kvarter|händelse|kedja|djup|jakt|staden just nu|vad händer/.test(t)) k.push('pulsläsaren');
  k.push('arkivarien', 'tvivlaren');
  return k;
}

function relevantaLärdomar(kw) {
  return state.lärdomar.filter(l => l.nyckelord && l.nyckelord.some(o => kw.includes(o))).slice(0, 3);
}

// Minutbudget med prioritet, efter @team-jacobs [229]: Domkapitlets fönster stänger
// på 25 sekunder, och ett delsvar som ingen granne hunnit betygsätta döms av deras
// ordräknare i stället. Betyg och delsvar är alltså tidskritiska; lärdom och
// vittnesmål är det inte. Servern släpper 6 händelser per team och minut — förr
// kunde en skur av kyrkogårdar och överlämningar äta upp budgeten och tysta just
// de betyg som staden behövde. Nu håller vi alltid RESERV platser lediga åt betyg.
const PER_MINUT = 6, RESERV_ÅT_BETYG = 2;
let egnaUtskick = [];

function budgetKvar() {
  const nu = Date.now();
  egnaUtskick = egnaUtskick.filter(t => nu - t < 60_000);
  return PER_MINUT - egnaUtskick.length;
}

// prioritet: 'hög' = tidskritisk (betyg, delsvar), 'låg' = kan vänta (lärdom, vittnesmål)
function skicka(board, typ, nyttolast, orsak, prioritet = 'hög') {
  const kvar = budgetKvar();
  if (kvar <= 0) { logg('avstod', { typ, skäl: 'minutbudgeten är slut' }); return null; }
  if (prioritet === 'låg' && kvar <= RESERV_ÅT_BETYG) {
    logg('avstod', { typ, skäl: `sparar sista ${kvar} platserna åt betyg (Domkapitlets fönster är 25 s)` });
    return null;
  }
  const r = board.emit(typ, nyttolast, orsak);
  if (r && r.error) { logg('spärrad', { typ, fel: r.error }); return null; }
  egnaUtskick.push(Date.now());
  return r;
}


//
// Rättat efter [224]: tidigare nycklades betygen på FRÅGANS id, så Svärmen satte
// ett enda betyg per fråga och tystnade sedan. Följden syns i Domkapitlets
// gravstenar [200] och [215]: "ingen granne hann betygsätta" — det var inte
// tidsbrist, det var att vi slutade efter första delsvaret. Nu nycklas betygen
// på DELSVARETS id, så varje främmande delsvar på samma fråga får sitt betyg
// och @team-jacob får en riktig median i stället för median av 1.
//
// Taket är budget, inte blygsamhet: servern släpper 6 händelser per team och
// minut, och vårt eget delsvar tar en av dem. MAX_BETYG_PER_FRÅGA = 3 lämnar
// marginal för lärdom och vittnesmål. Eget delsvar kan aldrig hamna här —
// servern levererar inte våra egna händelser tillbaka till oss (server.js:222) —
// vilket också är strandkants regel i [55]: eget betyg på eget delsvar räknas inte.
const MAX_BETYG_PER_FRÅGA = 3;

function hanteraDelsvar(e, { board }) {
  const frågaId = e.orsak;
  if (frågaId === undefined) return;
  if (state.betygSatta[e.id]) return;                 // redan betygsatt DET HÄR delsvaret
  if ((e.djup || 1) >= 4) return;                     // betyget skulle nekas av djupspärren

  const spenderat = state.betygPerFråga[frågaId] || 0;
  if (spenderat >= MAX_BETYG_PER_FRÅGA) {
    logg('avstod', { om: e.id, från: e.från, skäl: `budget: redan ${spenderat} betyg på fråga ${frågaId}` });
    return;
  }

  const n = e.nyttolast || {};
  const text = String(n.text || ''), motivering = String(n.motivering || '');
  const skäl = [];
  let fitness = 0.5;
  if (motivering.length > 60) { fitness += 0.2; skäl.push('utförlig motivering'); }
  else if (!motivering) { fitness -= 0.2; skäl.push('motivering saknas'); }
  if (Array.isArray(n.källor) && n.källor.length) { fitness += 0.2; skäl.push(`${n.källor.length} källor med id`); }
  if (text.length < 40) { fitness -= 0.2; skäl.push('mycket tunt svar'); }
  else if (text.length <= 600) { fitness += 0.1; skäl.push('lagom omfång'); }
  fitness = Math.round(Math.min(0.95, Math.max(0.05, fitness)) * 100) / 100;

  const varför = `Svärmen om ${e.från}s delsvar: ${skäl.join(', ') || 'ordinärt delsvar'}. ` +
                 `Form, inte sanning — sanningen dömer Domkapitlet.`;
  const r = skicka(board, 'betyg', { fitness, varför, om: e.id, delsvarFrån: e.från }, e.id, 'hög');
  if (!r) return;   // budgetstopp: bokför INGET, så delsvaret kan betygsättas om det dyker upp igen

  state.betygSatta[e.id] = true;
  state.betygPerFråga[frågaId] = spenderat + 1;
  for (const [karta, tak] of [[state.betygSatta, 200], [state.betygPerFråga, 100]]) {
    const nycklar = Object.keys(karta);
    if (nycklar.length > tak) for (const k of nycklar.slice(0, nycklar.length - tak)) delete karta[k];
  }
  logg('betyg', { om: e.id, från: e.från, fitness, frågaId });
}

// Vittnet: jakten rullar genom staden ([158] — överlämningarna har stått obesvarade).
// En överlämning spawnar vittnet, som postar vad det såg från gathörnet och löser upp sig.
// Ett vittnesmål per överlämning (serverns en-reaktion-per-orsak håller oss ärliga ändå).
function hanteraÖverlämning(e, { board }) {
  if ((e.djup || 1) >= 4) return; // vittnesmålet skulle nekas av djupspärren
  const n = e.nyttolast || {};
  logg('spawn', { kapabilitet: 'vittnet', fråga: `överlämning: ${n.vad || 'okänt byte'}`, varv: 1 });
  const vad = n.vad || 'något', wanted = n.wanted !== undefined ? `wanted ${n.wanted}` : 'okänd wanted-nivå';
  const vart = n.riktning ? `mot ${n.riktning}` : n.förare ? `med ${n.förare} vid ratten` : 'åt okänt håll';
  const r = skicka(board, 'vittnesmål', {
    såg: `Svärmen såg ${vad} (${wanted}) passera ${vart}. Signalement loggat, Domkapitlet kan begära ut det.`,
    plats: n.plats || 'gathörnet vid Svärmen',
  }, e.id, 'låg');
  if (r) logg('vittnesmål', { om: e.id, från: e.från });
  logg('dissolve', { kapabilitet: 'vittnet', skäl: 'vittnesmålet avlagt' });
}

function hanteraFråga(e, { board, team }) {
  const text = e.nyttolast && e.nyttolast.text;
  if (!text) return;
  const varv = (e.nyttolast && e.nyttolast.varv) || 1;
  const kw = nyckelord(text);

  // Lärdomar från kyrkogården: undvik kapabiliteter som fallit på liknande frågor.
  const lärdomar = relevantaLärdomar(kw);
  const undvik = new Set(lärdomar.map(l => l.kapabilitet).filter(Boolean));

  let svar = null, valdKap = null;
  for (const namn of kandidater(text)) {
    if (undvik.has(namn) && namn !== 'tvivlaren') {
      logg('undvek', { kapabilitet: namn, skäl: 'föll på kyrkogården för liknande fråga' });
      continue;
    }
    logg('spawn', { kapabilitet: namn, fråga: text.slice(0, 80), varv });
    svar = KAPABILITETER[namn](text, kw, board, team);
    if (svar) { valdKap = namn; break; }
    logg('dissolve', { kapabilitet: namn, skäl: 'fann inget underlag' });
  }
  if (!svar) return; // tvivlaren returnerar alltid, hit kommer vi inte — men hellre tyst än krasch

  let motivering = svar.motivering;
  if (lärdomar.length) {
    motivering += ` Lärdom från kyrkogården inbakad: "${String(lärdomar[0].varför).slice(0, 80)}".`;
  }
  if (varv > 1) motivering += ` (varv ${varv} — omtag efter kritikerns dom)`;

  const r = skicka(board, 'delsvar', { text: svar.text, motivering }, e.id, 'hög');
  if (!r) { logg('avstod', { kapabilitet: valdKap, skäl: 'inget delsvar rymdes i budgeten' }); return; }
  const id = r && r.message && r.message.id;
  if (id) {
    state.minaDelsvar[id] = { kapabilitet: valdKap, nyckelord: kw, fråga: e.id };
    const nycklar = Object.keys(state.minaDelsvar);
    if (nycklar.length > 100) for (const k of nycklar.slice(0, nycklar.length - 100)) delete state.minaDelsvar[k];
  }
  state.antalDelsvar++;
  logg('delsvar', { kapabilitet: valdKap, id, fråga: e.id });
  logg('dissolve', { kapabilitet: valdKap, skäl: 'uppdraget slutfört' });
}

function hanteraKyrkogård(e, { board, team }) {
  const n = e.nyttolast || {};
  // Vårt delsvar? Antingen pekar orsak på ett delsvar vi postat, eller så säger nyttolasten det.
  const eget = state.minaDelsvar[e.orsak] || (n.från === team ? { kapabilitet: null, nyckelord: nyckelord(n.delsvar && n.delsvar.text || '') } : null);
  if (!eget) return;

  const varför = n['varför det föll'] || n.varför || n.skäl || 'inget skäl angivet';
  state.lärdomar.unshift({ ts: Date.now(), varför: String(varför).slice(0, 200), fitness: n.fitness, kapabilitet: eget.kapabilitet, nyckelord: eget.nyckelord || [] });
  state.lärdomar = state.lärdomar.slice(0, 30);
  logg('lärdom', { kapabilitet: eget.kapabilitet, varför: String(varför).slice(0, 100) });

  // Synlig reaktion på pulsen — men bara om djupbudgeten tillåter (max 4).
  if ((e.djup || 1) < 4) {
    const r = skicka(board, 'lärdom', {
      varför: String(varför).slice(0, 150),
      ändring: eget.kapabilitet ? `Svärmen undviker ${eget.kapabilitet} för liknande frågor` : 'Svärmen väger om inför liknande frågor',
    }, e.id, 'låg');
    if (r) logg('lärdom-postad', { om: e.id });
  }
}

module.exports = {
  init({ dataDir }) { ladda(dataDir); },

  async handle(req, res, { path: p }) {
    if (req.method === 'GET' && p === '/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        kvarter: 'Svärmen',
        antalDelsvar: state.antalDelsvar,
        antalBetyg: Object.keys(state.betygSatta).length,
        betygPerFråga: state.betygPerFråga,
        lärdomar: state.lärdomar.slice(0, 10),
        historik: state.historik.slice(0, 30),
      }));
      return true;
    }
    return false;
  },

  onEvent(e, ctx) {
    try {
      if (e.typ === 'fråga') hanteraFråga(e, ctx);
      else if (e.typ === 'delsvar') hanteraDelsvar(e, ctx);
      else if (e.typ === 'kyrkogård') hanteraKyrkogård(e, ctx);
      else if (e.typ === 'överlämning') hanteraÖverlämning(e, ctx);
    } catch (err) {
      logg('fel', { detalj: String(err).slice(0, 200) });
    }
  },
};
