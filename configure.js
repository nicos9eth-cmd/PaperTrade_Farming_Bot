'use strict';

// Settings assistant (reglages.bat): reads the Papertrade and Lighter balances, the relayer's
// congestion and the mint rate, recommends complete settings for those balances (lib/advice.js),
// and writes them into config.json, as recommended or adjusted one question at a time.

const readline = require('readline');
const api = require('./lib/api');
const configFile = require('./lib/config');
const lighter = require('./lib/lighter');
const pressure = require('./lib/pressure');
const { advise, coverage } = require('./lib/advice');
const { cycleRange } = require('./lib/sizing');
const { tolerableDelay } = require('./lib/risk');
const { mintRate } = require('./lib/economics');

const usd = (n) => n.toFixed(2) + ' $';
const pct = (n) => (n * 100).toFixed(2) + ' %';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutes = (s) => (s === Infinity ? 'jamais' : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

// Answers are queued as lines arrive, so typing ahead (or piping answers in) loses nothing.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = [];
const waiting = [];
let closed = false;
rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on('close', () => {
  closed = true;
  while (waiting.length) waiting.shift()(null);
});
const ask = (q) => {
  process.stdout.write(q);
  if (lines.length) return Promise.resolve(lines.shift());
  if (closed) return Promise.resolve(null);
  return new Promise((r) => waiting.push(r));
};

// "50", "50 $", "$50", "50,5" -> number; empty -> null; anything else -> NaN.
function amount(text) {
  const t = String(text).trim();
  if (!t) return null;
  const n = Number(t.replace(/[$€\s]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

async function askAmount(question, check) {
  for (;;) {
    const raw = await ask(question);
    if (raw === null) throw new Error('saisie interrompue');
    const v = amount(raw);
    if (Number.isNaN(v)) {
      console.log('  Tape juste un nombre, par exemple 50.');
      continue;
    }
    const problem = check(v);
    if (!problem) return v;
    console.log('  ' + problem);
  }
}

// The account stream answers 429 when read too often (a running bot reads it too): retry a bit.
async function account(wallet) {
  for (let i = 0; ; i++) {
    try {
      return await api.walletSnapshot(wallet);
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(3000);
    }
  }
}

// The Lighter side: { enabled, equity, base } when the hedge is set up, { enabled: false, equity }
// when the wallet has a Lighter account without the bot's key, null when there is no account.
async function lighterSide(wallet) {
  const key = lighter.loadKey();
  try {
    if (key) return { enabled: true, ...(await lighter.account(key.account_index)) };
    if (!wallet) return null;
    const index = await lighter.accountIndex(wallet);
    return index === null ? null : { enabled: false, ...(await lighter.account(index)) };
  } catch (e) {
    return key ? { enabled: true, error: e.message } : null;
  }
}

function coverText(cover) {
  if (!cover) return 'aucune (optionnel : setup-lighter.bat avec un compte Lighter)';
  if (cover.share >= 1) return `complète (Lighter peut couvrir ${usd(cover.capacityUsd)})`;
  return `partielle, ${Math.round(cover.share * 100)} % d'une jambe. Ajoute ~${cover.missingUsd} $ sur Lighter pour la compléter`;
}

function show(label, c, cover, config) {
  const wait = cover && cover.share >= 1 ? Infinity : tolerableDelay(c.bustMove, config);
  return [
    `   ${label} : levier x${c.leverage}, 2 jambes de ${usd(c.margin)} (taille ${usd(c.notional)} chacune)`,
    `      clôture vers ${pct(c.bustMove * config.closeAt)} de mouvement, liquidation à ${pct(c.bustMove)}`,
    `      un cycle : ${usd(c.early.cost)} à ${usd(c.late.cost)} pour ${Math.round(c.early.minted)} à ${Math.round(c.late.minted)} PAPER (~${c.late.costPerPaper.toFixed(4)} $ par PAPER)`,
    `      attente pendant les congestions : ${wait === Infinity ? 'non (couvert par Lighter)' : `quand les clôtures prennent plus de ~${minutes(wait)} (marché calme)`}`,
  ].join('\n');
}

async function main() {
  const config = configFile.load();
  const defaults = configFile.DEFAULTS;
  console.log('\n=== Réglages de PaperTradeBot ===\n');
  console.log('Lecture de tes comptes et de Papertrade...');
  const relayer = pressure.watch();
  const [mkts, proto, lt] = await Promise.all([api.markets(), api.protocol(), lighterSide(config.wallet)]);
  const market = Object.values(mkts.byId).find((m) => m.coin === 'BTC');
  if (!market) throw new Error('marché BTC introuvable sur Papertrade');

  // Smallest balance that can open a pair: the minimum margin on each leg, plus the reserve.
  const minPair = Math.ceil((2 * mkts.minMargin) / (1 - config.reserve));
  const enough = (v) => (v === null ? 'Indique un montant.' : v < minPair ? `Il faut au moins ${minPair} $ pour ouvrir une paire.` : null);

  console.log('\n--- Ta situation ---');
  let balance;
  if (config.wallet) {
    const w = await account(config.wallet);
    const available = api.num(w.funds.availableBalance);
    const locked = api.num(w.locked);
    const staked = api.num(w.paper.staked);
    balance = available + locked;
    console.log(`Papertrade : ${usd(balance)} (${usd(available)} disponibles, ${usd(locked)} en positions), ${Math.round(staked)} PAPER stakés.`);
    if (staked < mkts.minPaperStake) console.log(`  Attention : le relayer annonce un minimum de ${mkts.minPaperStake} PAPER stakés, tes ordres risquent d'être refusés.`);
    if (balance < minPair) {
      console.log(`  Ce solde ne suffit pas : il faut au moins ${minPair} $ déposés sur Papertrade (des USDC dans le wallet ne comptent pas).`);
      balance = await askAmount('  Combien auras-tu sur Papertrade après ton dépôt ? ', enough);
    }
  } else {
    console.log('Papertrade : aucun wallet configuré pour l\'instant (setup.bat pas encore lancé).');
    balance = await askAmount('  Combien d\'USDC as-tu, ou vas-tu déposer, sur Papertrade ? ', enough);
  }

  let lighterEquity = null;
  if (!lt) console.log('Lighter : pas de compte pour ce wallet. La couverture Lighter est optionnelle (voir le README).');
  else if (lt.error) console.log(`Lighter : couverture configurée, mais compte illisible pour l'instant (${lt.error}).`);
  else if (!lt.enabled) console.log(`Lighter : compte trouvé avec ${usd(lt.equity)}, mais la couverture n'est pas activée. Lance setup-lighter.bat pour l'activer (recommandations ci-dessous calculées comme si c'était fait).`);
  else console.log(`Lighter : couverture activée, ${usd(lt.equity)} sur le compte${lt.base ? ` (dont ta position BTC ${lt.base > 0 ? 'long' : 'short'} ${Math.abs(lt.base).toFixed(5)})` : ''}.`);
  if (lt && !lt.error) lighterEquity = lt.equity;

  for (let i = 0; i < 8 && !relayer.current(); i++) await sleep(500);
  const load = relayer.current();
  console.log(`Relayer en ce moment : ${load ? `congestion ${load.level}, ${load.pending} ordre(s) en attente, ~${minutes(load.clearSeconds)} pour vider la file` : 'congestion inconnue'}.`);
  console.log(`Taux de mint : ${mintRate(proto.paper).toFixed(2)} PAPER par dollar perdu (il baisse avec le temps).`);

  const a = advise({ balance, mkts, market, proto, config, defaults, lighterEquity });
  if (a.reason) throw new Error(a.reason);

  console.log('\n--- Recommandation pour ton solde ---');
  console.log(`Engager : tout le solde Papertrade (${usd(balance)}).`);
  console.log(`Levier ${a.pick === 'prudent' ? 'prudent' : 'normal'}, parce que ${a.why}.`);
  console.log(show(a.pick === 'prudent' ? 'Prudent' : 'Normal', a.chosen, a.cover, config));
  console.log(`Couverture Lighter : ${coverText(a.cover)}.`);
  console.log(`Budget : ${a.budget} $ au total (~10 cycles), puis le bot s'arrête.`);
  console.log(`Prix maximum du PAPER : ${a.maxCostPerPaper} $ (aujourd'hui ~${a.chosen.late.costPerPaper.toFixed(4)} $ ; le bot arrête d'ouvrir au-delà).`);

  let choice;
  for (;;) {
    const raw = await ask('\nEntrée = appliquer cette recommandation, P = personnaliser, Q = quitter sans rien changer : ');
    if (raw === null) throw new Error('saisie interrompue');
    choice = raw.trim().toLowerCase();
    if (['', 'p', 'q'].includes(choice)) break;
    console.log('  Tape Entrée, P ou Q.');
  }
  if (choice === 'q') return console.log('Rien n\'a été modifié.');

  let next = { maxMarginPerLeg: null, targetMove: a.targetMove, maxNetLossUsd: a.budget, maxCostPerPaper: a.maxCostPerPaper };
  let leverage = a.chosen.leverage;
  if (choice === 'p') {
    console.log(`\n1) Combien le bot peut-il engager au maximum ? (minimum ${minPair} $ : Papertrade impose ${mkts.minMargin} $ par jambe)`);
    const use = await askAmount(`   Montant, ou Entrée pour tout le solde (${usd(balance)}) : `, (v) => (v !== null && v < minPair ? `Il faut au moins ${minPair} $.` : null));
    next.maxMarginPerLeg = use === null || use >= balance ? null : Math.floor(use / 2);
    const base = { ...config, maxMarginPerLeg: next.maxMarginPerLeg };
    const normal = cycleRange(balance, mkts, market, proto, { ...base, targetMove: defaults.targetMove });
    const prudent = a.prudent ? cycleRange(balance, mkts, market, proto, { ...base, targetMove: a.prudent.targetMove }) : null;
    if (normal.reason) throw new Error(normal.reason);
    let picked = normal;
    if (prudent && prudent.leverage < normal.leverage) {
      console.log('\n2) Quel levier ?');
      console.log(show('1. Normal', normal, coverage(lighterEquity, normal.notional), config));
      console.log(show('2. Prudent', prudent, coverage(lighterEquity, prudent.notional), config));
      const current = a.pick === 'prudent' ? '2' : '1';
      for (;;) {
        const raw = await ask(`   Choix 1 ou 2 (Entrée = ${current}, recommandé) : `);
        if (raw === null) throw new Error('saisie interrompue');
        const pick = raw.trim() || current;
        if (pick === '1' || pick === '2') {
          picked = pick === '2' ? prudent : normal;
          leverage = picked.leverage;
          next.targetMove = pick === '2' ? a.prudent.targetMove : defaults.targetMove;
          break;
        }
        console.log('  Tape 1 ou 2.');
      }
    } else {
      console.log(`\n2) Levier : x${normal.leverage}, le seul possible avec ce montant (Papertrade impose ${mkts.minNotional} $ par position).`);
      next.targetMove = defaults.targetMove;
      leverage = normal.leverage;
    }
    const suggested = Math.max(1, Math.ceil(picked.late.cost * 10));
    console.log(`\n3) Combien acceptes-tu de dépenser au total ? Une fois ce budget atteint, le bot s'arrête.`);
    const budget = await askAmount(`   Montant, ou Entrée pour ${suggested} $ (environ 10 cycles) : `, (v) =>
      v !== null && v < picked.early.cost ? `C'est moins qu'un seul cycle (${usd(picked.early.cost)} minimum).` : null
    );
    next.maxNetLossUsd = budget === null ? suggested : budget;
    const ceiling = Math.ceil(picked.late.costPerPaper * 1.5 * 1000) / 1000;
    console.log(`\n4) Au-delà de quel prix par PAPER le bot doit-il arrêter d'ouvrir ? (aujourd'hui ~${picked.late.costPerPaper.toFixed(4)} $)`);
    const max = await askAmount(`   Prix, ou Entrée pour ${ceiling} $ : `, (v) => (v !== null && v < picked.late.costPerPaper ? 'C\'est moins que le prix actuel : le bot n\'ouvrirait plus rien.' : null));
    next.maxCostPerPaper = max === null ? ceiling : max;
  }

  const lines2 = [
    ['Engagé', config.maxMarginPerLeg ? `${config.maxMarginPerLeg} $ par jambe` : 'tout le solde', next.maxMarginPerLeg ? `${next.maxMarginPerLeg} $ par jambe` : 'tout le solde'],
    ['Levier', `x${cycleRange(balance, mkts, market, proto, config).leverage}`, `x${leverage}`],
    ['Budget', `${config.maxNetLossUsd} $`, `${next.maxNetLossUsd} $`],
    ['Prix max du PAPER', `${config.maxCostPerPaper} $`, `${next.maxCostPerPaper} $`],
  ];
  console.log('\nChangements :');
  for (const [label, before, after] of lines2) console.log(`  ${label.padEnd(20)} ${before === after ? before + ' (inchangé)' : `${before}  ->  ${after}`}`);
  const answer = await ask('\nEnregistrer ces réglages dans config.json ? (O/n) ');
  const ok = (answer || '').trim().toLowerCase();
  if (answer === null || (ok && !['o', 'oui', 'y', 'yes'].includes(ok))) return console.log('Rien n\'a été modifié.');
  const budgetChanged = config.maxNetLossUsd !== next.maxNetLossUsd;
  configFile.save({ ...config, ...next });
  console.log('\nRéglages enregistrés.');
  if (budgetChanged) console.log('Nouveau budget : le compteur de dépenses repart de zéro au prochain lancement du bot.');
  if (lt && !lt.enabled) console.log('Pour activer la couverture Lighter : setup-lighter.bat.');
  console.log(config.wallet ? 'Lance bot-live.bat, ou ferme et relance-le s\'il tourne déjà.' : 'Prochaine étape : setup.bat, puis bot-live.bat.');
}

main()
  .catch((e) => console.log('\nÉchec : ' + e.message))
  .finally(() => {
    rl.close();
    // The congestion stream keeps the process alive otherwise.
    setTimeout(() => process.exit(0), 100);
  });
