'use strict';

// Settings assistant: reads the account's balance, asks how much the bot may use and spend,
// shows what a cycle will cost, and writes the answers into config.json.

const readline = require('readline');
const api = require('./lib/api');
const configFile = require('./lib/config');
const { cycleRange, lowestLeverage } = require('./lib/sizing');
const { mintRate } = require('./lib/economics');

const usd = (n) => n.toFixed(2) + ' $';
const pct = (n) => (n * 100).toFixed(2) + ' %';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function describe(c) {
  return [
    `  Paire : 2 jambes de ${usd(c.margin)} (levier x${c.leverage}, taille ${usd(c.notional)} chacune)`,
    `  Un cycle : coût ${usd(c.early.cost)} à ${usd(c.late.cost)}, pour ${Math.round(c.early.minted)} à ${Math.round(c.late.minted)} PAPER`,
    `  Prix de revient : ~${(c.late.costPerPaper).toFixed(4)} $ par PAPER`,
  ].join('\n');
}

async function main() {
  const config = configFile.load();
  console.log('\n=== Réglages de PaperTradeBot ===\n');
  console.log('Lecture des marchés Papertrade...');
  const [mkts, proto] = await Promise.all([api.markets(), api.protocol()]);
  const market = Object.values(mkts.byId).find((m) => m.coin === 'BTC');
  if (!market) throw new Error('marché BTC introuvable sur Papertrade');
  console.log(`Taux de mint actuel : ${mintRate(proto.paper).toFixed(2)} PAPER par dollar perdu.\n`);

  // Smallest balance that can open a pair: the minimum margin on each leg, plus the reserve.
  const minPair = Math.ceil((2 * mkts.minMargin) / (1 - config.reserve));
  const enough = (v) => (v === null ? 'Indique un montant.' : v < minPair ? `Il faut au moins ${minPair} $ pour ouvrir une paire.` : null);
  let balance;
  if (config.wallet) {
    const w = await account(config.wallet);
    const available = api.num(w.funds.availableBalance);
    const locked = api.num(w.locked);
    const staked = api.num(w.paper.staked);
    balance = available + locked;
    console.log(`Ton compte ${config.wallet.slice(0, 8)}… : ${usd(available)} disponibles, ${usd(locked)} engagés dans des positions, ${Math.round(staked)} PAPER stakés.`);
    if (staked < mkts.minPaperStake) console.log(`Attention : le relayer annonce un minimum de ${mkts.minPaperStake} PAPER stakés, tes ordres risquent d'être refusés.`);
    if (balance < minPair) {
      console.log(`Ce solde ne suffit pas : il faut au moins ${minPair} $ déposés sur Papertrade (des USDC dans le wallet ne comptent pas).`);
      balance = await askAmount('Combien auras-tu sur Papertrade après ton dépôt ? ', enough);
    }
  } else {
    console.log('Aucun wallet configuré pour l\'instant (setup.bat pas encore lancé).');
    balance = await askAmount('Combien d\'USDC as-tu, ou vas-tu déposer, sur Papertrade ? ', enough);
  }

  console.log(`\n1) Combien le bot peut-il engager au maximum ? (minimum ${minPair} $ : Papertrade impose ${mkts.minMargin} $ par jambe)`);
  const use = await askAmount(`   Montant, ou Entrée pour tout le solde (${usd(balance)}) : `, (v) =>
    v !== null && v < minPair ? `Il faut au moins ${minPair} $.` : null
  );
  const maxMarginPerLeg = use === null || use >= balance ? null : Math.floor(use / 2);
  const engaged = use === null ? balance : Math.min(use, balance);
  // Leverage: the default aims at closing after a ~1 % move; the lowest leverage the balance allows
  // puts liquidation further away for about the same PAPER per cycle, but cycles come less often.
  const base = { ...config, maxMarginPerLeg };
  const fast = cycleRange(balance, mkts, market, proto, { ...base, targetMove: configFile.DEFAULTS.targetMove });
  if (fast.reason) throw new Error(fast.reason);
  const low = lowestLeverage(balance, mkts, market, base);
  let targetMove = configFile.DEFAULTS.targetMove;
  let c = fast;
  if (!low.reason && low.leverage < fast.leverage) {
    const slow = cycleRange(balance, mkts, market, proto, { ...base, targetMove: low.targetMove });
    const rarer = ((slow.bustMove / fast.bustMove) ** 2).toFixed(1);
    const option = (n, name, x, note) =>
      `   ${n}. ${name} : levier x${x.leverage}, taille ${usd(x.notional)}, clôture vers ${pct(x.bustMove * config.closeAt)} de mouvement, liquidation à ${pct(x.bustMove)}.\n      ${Math.round(x.late.minted)} PAPER par cycle pour ${usd(x.late.cost)}. ${note}`;
    console.log('\n2) Quel levier ?');
    console.log(option(1, 'Normal', fast, 'Cycles plus fréquents.'));
    console.log(option(2, 'Prudent', slow, `Liquidation plus loin, mais le BTC doit bouger plus : cycles environ ${rarer} fois plus rares.`));
    const current = config.targetMove > configFile.DEFAULTS.targetMove ? '2' : '1';
    for (;;) {
      const raw = await ask(`   Choix 1 ou 2 (Entrée = ${current}) : `);
      if (raw === null) throw new Error('saisie interrompue');
      const pick = raw.trim() || current;
      if (pick === '1') break;
      if (pick === '2') {
        targetMove = low.targetMove;
        c = slow;
        break;
      }
      console.log('  Tape 1 ou 2.');
    }
  } else {
    console.log(`\n2) Levier : x${fast.leverage}, déjà le plus bas possible avec ce montant (Papertrade impose ${mkts.minNotional} $ de taille par position).`);
  }
  console.log('\n' + describe(c));

  const suggested = Math.max(1, Math.ceil(c.late.cost * 10));
  console.log(`\n3) Combien acceptes-tu de dépenser au total ? Une fois ce budget atteint, le bot s'arrête.`);
  const budget = await askAmount(`   Montant, ou Entrée pour ${suggested} $ (environ 10 cycles) : `, (v) =>
    v !== null && v < c.early.cost ? `C'est moins qu'un seul cycle (${usd(c.early.cost)} minimum).` : null
  );
  const maxNetLossUsd = budget === null ? suggested : budget;
  const cycles = [maxNetLossUsd / c.late.cost, maxNetLossUsd / c.early.cost].map(Math.floor);

  console.log('\nRésumé :');
  console.log(`  Engagé : ${usd(engaged)}${maxMarginPerLeg ? ` (${maxMarginPerLeg} $ max par jambe)` : ' (tout le solde)'}`);
  console.log(`  Levier : x${c.leverage}${targetMove === configFile.DEFAULTS.targetMove ? ' (normal)' : ' (prudent)'}`);
  console.log(`  Budget : ${usd(maxNetLossUsd)}, soit ${cycles[0]} à ${cycles[1]} cycles et ~${Math.round(cycles[0] * c.late.minted)} PAPER`);
  if (!config.wallet) console.log('  (estimation pour le montant indiqué ; relance reglages.bat après setup.bat pour lire ton vrai solde)');
  const answer = await ask('\nEnregistrer ces réglages dans config.json ? (O/n) ');
  const ok = (answer || '').trim().toLowerCase();
  if (answer === null || (ok && !['o', 'oui', 'y', 'yes'].includes(ok))) {
    console.log('Rien n\'a été modifié.');
    return;
  }
  const budgetChanged = config.maxNetLossUsd !== maxNetLossUsd;
  configFile.save({ ...config, maxMarginPerLeg, maxNetLossUsd, targetMove });
  console.log('\nRéglages enregistrés.');
  if (budgetChanged) console.log('Nouveau budget : le compteur de dépenses repart de zéro au prochain lancement du bot.');
  console.log(config.wallet ? 'Lance bot-live.bat, ou ferme et relance-le s\'il tourne déjà.' : 'Prochaine étape : setup.bat, puis bot-live.bat.');
}

main()
  .catch((e) => console.log('\nÉchec : ' + e.message))
  .finally(() => rl.close());
