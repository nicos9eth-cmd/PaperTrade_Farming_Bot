'use strict';

// Autonomous PAPER farming bot: keeps one hedged BTC long + short pair open, closes both legs
// just before the losing leg would be liquidated, then reopens. Simulation unless --live is passed.

const fs = require('fs');
const path = require('path');
const api = require('./lib/api');
const intents = require('./lib/intents');
const exchange = require('./lib/exchange');
const dashboard = require('./lib/dashboard');
const { tracker } = require('./lib/risk');
const pressure = require('./lib/pressure');
const site = require('./lib/site');
const changes = require('./lib/changes');
const { buildPairs, pairStatus } = require('./lib/pairs');
const { mintRate, pairOutcome } = require('./lib/economics');
const { sizePair, cycleRange } = require('./lib/sizing');
const lighterLib = require('./lib/lighter');
const hedge = require('./lib/hedge');
const gates = require('./lib/gates');
const burst = require('./lib/burst');
const scalp = require('./lib/scalp');
const { liveMid } = require('./lib/feed');
let config;
try {
  config = require('./lib/config').load();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const LIVE = process.argv.includes('--live');
const SCREEN = process.stdout.isTTY && !process.argv.includes('--plain');
// Simulation only: the pool is shown under the cliff, to watch the short rotations of the window.
const SIM_WINDOW = !LIVE && process.argv.includes('--simuler-fenetre');
// Simulation only: a simulated Lighter account ($50) even without setup-lighter.bat.
const SIM_LIGHTER = !LIVE && process.argv.includes('--simuler-lighter');
const SCALP_MAX_LEVERAGE = 10; // the cover alone never carries more than 10x the Lighter collateral
const SCALP_CONFIRM_MS = 1000; // a cover order is checked on the account 1 s later (Lighter fills at once)
const FAST_MIN_GAP_MS = 300; // the live price triggers a Lighter check at most this often
const JOURNAL = path.join(__dirname, LIVE ? 'journal.csv' : 'journal-simulation.csv');
const LOG_FILE = path.join(__dirname, LIVE ? 'bot.log' : 'bot-simulation.log');
const BUDGET_FILE = path.join(__dirname, '.budget.json');
const OPEN_COOLDOWN_MS = 60000;
const BURST_COOLDOWN_MS = 5000; // between two openings while the pool is under the cliff
const PROTO_TICKS = 5; // pool read every 5 ticks, and every tick within NEAR_CLIFF of the cliff
const NEAR_CLIFF = 1.5;
const BLOCKED_RETRY_MS = 120000;
const CLOSE_TIMEOUT_MS = 90000;
const CLOSE_RETRY_MS = 10000;
const SETTLE_WAIT_MS = 3000;
const LOW_BALANCE_GRACE_MS = 120000;
const STALE_STATE_MS = 30000;
const IN_FLIGHT_MARGIN_MS = 30000;
const LONE_LEG_GRACE_MS = 20000; // a lone leg is tolerated this long while its twin may still land
const LONE_LEG_PENDING_MS = 60000; // ...or this long while the relayer still reports pending orders
const UNKNOWN_QUEUE_DELAY_S = 5; // assumed relayer backlog when the congestion feed is silent
const MAX_ERRORS = 5;
const REFRESH_TICKS = 15;
const SITE_CHECK_TICKS = 300;
// Refusals that only mean "not now": the bot waits and retries instead of counting an error.
const TEMPORARY = new Set(['openInterest', 'tradingPaused', 'marketPaused', 'funding']);

const usd = (n) => '$' + n.toFixed(2);
const pct = (n) => (n * 100).toFixed(2) + '%';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readProto = () => api.protocol().then((p) => (SIM_WINDOW ? burst.simulatedWindow(p) : p));

const events = [];
function log(msg) {
  const now = new Date();
  try {
    fs.appendFileSync(LOG_FILE, `[${now.toLocaleString('fr-FR')}] ${msg}\n`);
  } catch (e) {}
  events.push(`${now.toLocaleTimeString('fr-FR')}  ${msg}`);
  if (events.length > 50) events.shift();
  if (!SCREEN) console.log(`[${now.toLocaleTimeString('fr-FR')}] ${msg}`);
}

function journal(row) {
  try {
    if (!fs.existsSync(JOURNAL)) fs.writeFileSync(JOURNAL, 'date,prix,pnl_usd,paper,cout_par_paper,cout_cumule_usd,paper_cumule\n');
    fs.appendFileSync(JOURNAL, row.join(',') + '\n');
  } catch (e) {
    log(`Journal non écrit : ${e.message}`);
  }
}

// Realized PnL at which the budget started counting. Kept on disk so that restarting the bot
// does not grant a fresh budget; changing maxNetLossUsd (or deleting the file) starts a new one.
function budgetStart(realized) {
  if (!LIVE) return realized;
  const wallet = config.wallet.toLowerCase();
  try {
    const b = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    if (b.wallet === wallet && b.max === config.maxNetLossUsd && typeof b.startRealized === 'number') return b.startRealized;
  } catch (e) {}
  try {
    fs.writeFileSync(BUDGET_FILE, JSON.stringify({ wallet, max: config.maxNetLossUsd, startRealized: realized }, null, 2));
  } catch (e) {}
  return realized;
}

// Why a new pair cannot be opened right now (market limits), or which leg to send first.
function admission(mkts, market, price, notional) {
  if (mkts.tradingPaused) return { wait: 'trading en pause sur Papertrade' };
  if (!market.openable) return { wait: 'marché BTC en pause' };
  if (mkts.pausedActions.includes('openPosition')) return { wait: 'ouvertures suspendues par le relayer' };
  const room = dashboard.oiRoom(market, price, mkts.maxNetOi);
  const need = notional * config.oiSafetyFactor;
  if (room.long < need) return { wait: `open interest long plein (${usd(Math.max(0, room.long))} libre)` };
  if (room.short < need) return { wait: `open interest short plein (${usd(Math.max(0, room.short))} libre)` };
  // The leg that widens the net imbalance is the one most likely to be refused: sign and send it first
  // (a few milliseconds ahead of the other, which leaves at the same time).
  const longFirst = room.net >= 0;
  if (mkts.maxNetOi && Math.abs(room.net) + need > mkts.maxNetOi) return { wait: `open interest net au plafond côté ${longFirst ? 'long' : 'short'}` };
  return { longFirst };
}

async function main() {
  if (!config.wallet && LIVE) throw new Error('Aucun wallet configuré : lance d\'abord setup.bat');
  // A rate limit or timeout at start-up is retried instead of stopping the bot.
  const boot = (fn) => api.retry(fn, { log: (s) => log(`Démarrage : ${s}`) });
  const mkts = await boot(() => api.markets());
  let proto = await boot(readProto);
  let version = await site.check();
  if (version.build) config.build = version.build;
  const relayer = pressure.watch();
  const btc = () => Object.values(mkts.byId).find((m) => m.coin === 'BTC');

  let ex;
  if (LIVE) {
    const key = intents.loadKey();
    if (!key || key.user !== config.wallet.toLowerCase()) throw new Error('Aucune clé de session pour ce wallet : lance d\'abord setup.bat');
    ex = exchange.live(config, key, mkts);
  } else {
    // Before setup (no wallet yet), the simulation runs on simulationCapital, or $100.
    const w = config.wallet && !config.simulationCapital ? await boot(() => api.walletSnapshot(config.wallet)) : null;
    const capital = config.simulationCapital || (w ? api.num(w.funds.availableBalance) + api.num(w.locked) : 100);
    ex = exchange.simulated(config, mkts, capital, () => proto);
  }

  // Cross-DEX hedge on Lighter, set up by setup-lighter.bat. Without it the bot stays on Papertrade
  // alone. In simulation the Lighter account is simulated too, on its real collateral.
  let lt = null;
  const lkey = lighterLib.loadKey();
  if (lkey) {
    if (LIVE) {
      lt = lighterLib.live(lkey);
      try {
        await lt.init();
      } catch (e) {
        log(`Couverture Lighter désactivée : ${e.message}. Relance setup-lighter.bat si ça persiste.`);
        lt.stop();
        lt = null;
      }
    } else {
      const real = await lighterLib.account(lkey.account_index).catch(() => null);
      lt = real ? lighterLib.simulated(real.collateral, real.base, real.entry) : lighterLib.simulated(20);
    }
  } else if (SIM_LIGHTER) lt = lighterLib.simulated(50);
  // Reactive cover of the losing leg on Lighter (lib/scalp.js), with its own result and loss limit.
  let scalpOn = !!(lt && config.lighterScalp);
  let scalpState;
  let scalpHeld = 0; // cover the bot holds on Lighter, part of `own`
  const scalpBook = scalp.ledger();
  let scalpAtCycle = 0;

  let state = await boot(() => ex.state());
  let stateAt = Date.now();
  if (LIVE && state.keyExpiry * 1000 < Date.now() + 2 * 3600e3) throw new Error('Clé de session absente ou expirée côté Papertrade : relance setup.bat');
  if (LIVE && state.paperStaked < mkts.minPaperStake)
    log(`Attention : ${Math.round(state.paperStaked)} PAPER staké, le relayer indique un minimum de ${mkts.minPaperStake}. Les ordres peuvent être refusés.`);

  const startedAt = Date.now();
  const start = { realized: state.realized, paper: state.paper };
  const budgetFrom = budgetStart(state.realized);
  // Default settings on a bigger account: one cycle can cost more than the whole budget.
  const cycle = btc() ? cycleRange(state.available + state.locked, mkts, btc(), proto, config) : null;
  if (cycle && !cycle.reason && config.maxNetLossUsd) {
    const left = config.maxNetLossUsd - (budgetFrom - state.realized);
    log(`Réglages : ~${usd(cycle.margin)} par jambe, un cycle coûte ${usd(cycle.early.cost)} à ${usd(cycle.late.cost)} pour ${Math.round(cycle.early.minted)} à ${Math.round(cycle.late.minted)} PAPER ; budget restant ${usd(left)}.`);
    if (left < cycle.late.cost) log(`Attention : le budget restant couvre moins d'un cycle, le bot s'arrêtera vite. Lance reglages.bat pour l'adapter à ton solde.`);
  }
  let last = { realized: state.realized, paper: state.paper };
  let cycles = 0;
  let awaiting = null; // { kind: 'open' | 'close', ids, sentAt, until, orphan }
  let noOpenBefore = 0; // cooldowns and backoffs
  let inFlightUntil = 0; // until when an open order already sent could still execute unseen
  let closeRetryAt = 0;
  let lowBalanceSince = 0;
  let singleSince = 0; // when a lone leg was first seen
  let openDeadline = config.openDeadlineSeconds;
  let errors = 0;
  const risk = tracker();
  let closeAt = config.closeAt; // adaptive, never above config.closeAt
  let riskView = null;
  // Close point of an open pair: under the cliff, its own best point for short rotations.
  const closeAtFor = (s) => {
    if (!proto.window || !s || !riskView) return closeAt;
    const best = burst.bestClose({ notional: s.loser.notional, bustMove: s.bustMove, market: s.loser.market, proto, config, vol: riskView.vol, overhead: cycleOverhead(riskView) });
    return best ? Math.min(best.closeAt, closeAt) : closeAt;
  };
  let orphans = 0; // single-leg incidents in a row
  let countedOrphans = '';
  let stopReason = null;
  let status = 'Démarrage';
  let waitReason = null;
  let lastLoopError = null;
  let tick = 0;
  const busts = hedge.bustTracker();
  let lighterView = null; // last Lighter reading, for the dashboard and the opening check
  let hedgeBusy = false;
  let hedgeRetryAt = 0;
  let imbalanceSince = 0;
  let partialLogged = false;
  let lighterError = null;
  let lighterStart = null; // Lighter equity when the bot started: its change counts in the results
  // Part of the Lighter BTC position opened by the bot (the rest is the owner's), on disk in live mode.
  let own = LIVE ? lighterLib.loadOwn() : 0;
  let pendingFill = null; // { before, baseline } until the reading after an order
  const setOwn = (v) => {
    own = Math.round(v * 1e5) / 1e5 || 0;
    if (LIVE) lighterLib.saveOwn(own);
  };
  // Papertrade realised PnL plus what the Lighter account gained or lost since the bot started
  // (deposits or withdrawals on Lighter while the bot runs would show here too).
  const realizedAll = () => state.realized + (lighterView && lighterStart !== null ? lighterView.equity - lighterStart : 0);

  log(version.build ? `Version du site détectée : ${version.build}` : `Version du site introuvable, utilisation de ${config.build} (config.json)`);
  log(`Mode ${ex.name} | disponible ${usd(state.available)} | ${state.positions.length} position(s) ouverte(s) | mint ${mintRate(proto.paper).toFixed(2)} PAPER/$`);
  if (dashboard.poolText(proto)) log(`${dashboard.poolText(proto)}${SIM_WINDOW ? ' (simulée : --simuler-fenetre)' : ''}`);
  if (LIVE && Math.abs(budgetFrom - state.realized) > 0.005) log(`Budget repris d'un lancement précédent : ${usd(budgetFrom - state.realized)} déjà dépensés sur ${usd(config.maxNetLossUsd)}`);
  if (lt) {
    const l = await lt.state().catch(() => null);
    const mine = l && Math.abs(l.base - own) >= 1e-5 ? ` Ta position BTC manuelle (${l.base - own > 0 ? 'long' : 'short'} ${Math.abs(l.base - own).toFixed(5)} BTC) est conservée ; elle ne sera réduite que si une couverture a besoin de sa marge.` : '';
    log(`Couverture Lighter active (${lt.name}${lkey ? `, compte ${lkey.account_index}` : ''}${l ? `, collatéral ${usd(l.equity)}` : ''}).${mine}`);
    if (scalpOn) log(`Couverture réactive Lighter active : pendant chaque paire, couvre la jambe qui perd et change de côté dès que le prix repasse l'entrée (prix en direct), arrêt si son résultat passe sous -${usd(config.lighterScalpMaxLossUsd)}.`);
  } else log('Pas de couverture Lighter : le bot reste uniquement sur Papertrade.');
  if (SCREEN) process.stdout.write('\x1b[2J');

  const stop = (reason) => {
    if (!stopReason) log(`ARRÊT des ouvertures : ${reason}. Les positions ouvertes restent gérées jusqu'à leur clôture.`);
    stopReason = stopReason || reason;
  };

  const wait = (reason) => {
    // Logged once per kind of wait: the figures in brackets (orders pending, room left) change every tick.
    const kind = reason.replace(/\s*\(.*\)$/, '');
    if (kind !== waitReason) log(`En attente : ${reason}.`);
    waitReason = kind;
    status = `En attente : ${reason}`;
  };

  // Runs an order; returns null on success, or the error after accounting for it.
  const act = async (label, fn) => {
    try {
      const res = await fn();
      if (res && res.idMismatch) log(`${label} accepté, mais avec un identifiant différent de celui calculé par le bot.`);
      errors = 0;
      return null;
    } catch (e) {
      if (TEMPORARY.has(e.reason)) {
        log(`${label} refusé pour l'instant (${e.reason}).`);
        return e;
      }
      // A close refused because the positions are already being closed is not a failure.
      if (e.reason === 'noOpenPositions') {
        log(`${label} déjà en cours au relayer.`);
        return e;
      }
      errors++;
      log(`ERREUR ${label} : ${e.message}`);
      if (e.code === 'rate_limited') await sleep(10000);
      if (errors >= MAX_ERRORS) stop(`${MAX_ERRORS} erreurs consécutives`);
      return e;
    }
  };

  const closeAll = async (positions, why) => {
    const ids = positions.map((p) => p.id);
    log(`Clôture de ${ids.length} position(s) : ${why}`);
    const failed = await act('clôture', () => ex.close(ids));
    if (!failed || failed.reason === 'noOpenPositions') awaiting = { kind: 'close', ids, sentAt: Date.now(), until: Date.now() + CLOSE_TIMEOUT_MS };
    else closeRetryAt = Date.now() + CLOSE_RETRY_MS;
  };

  const recordCycle = (price) => {
    const pnl = realizedAll() - last.realized;
    const paper = state.paper - last.paper;
    last = { realized: realizedAll(), paper: state.paper };
    cycles++;
    const spent = start.realized - realizedAll();
    const total = state.paper - start.paper;
    const scalpPart = config.lighterScalp && lt ? ` | couverture réactive Lighter ${usd(scalpBook.pnl - scalpAtCycle)} (cumul ${usd(scalpBook.pnl)})` : '';
    scalpAtCycle = scalpBook.pnl;
    log(`Cycle terminé : PnL ${usd(pnl)}, +${Math.round(paper)} PAPER${paper > 0 ? `, $${(-pnl / paper).toFixed(4)} par PAPER` : ''} | cumul : coût ${usd(spent)}, ${Math.round(total)} PAPER${scalpPart}`);
    journal([new Date().toISOString(), price.toFixed(1), pnl.toFixed(4), paper.toFixed(2), paper > 0 ? (-pnl / paper).toFixed(5) : '', spent.toFixed(4), total.toFixed(2)]);
  };

  // Seconds a cycle spends at the relayer and in the loop, besides waiting for the price to move.
  const cycleOverhead = (view = risk.assess(1, config)) => 2 * view.delay + SETTLE_WAIT_MS / 1000 + config.pollSeconds;

  // `mode` 'burst': the pool is under the cliff, the pair is sized for short rotations (lib/burst.js).
  const openPair = async (price, mode) => {
    const market = btc();
    if (!market) return wait('marché BTC introuvable');
    const minBust = risk.minBustMove(config);
    let size = sizePair(state.available, mkts, market, config, minBust);
    if (size.reason) {
      // The balance may simply not be credited yet after a close: only give up if it lasts.
      lowBalanceSince = lowBalanceSince || Date.now();
      if (Date.now() - lowBalanceSince > LOW_BALANCE_GRACE_MS) return stop(size.reason);
      return wait('solde en cours de mise à jour');
    }
    lowBalanceSince = 0;
    const view = risk.assess(1, config);
    const rush = mode === 'burst' && !size.tooSlow ? burst.optimize({ available: state.available, mkts, market, proto, config, vol: view.vol, overhead: cycleOverhead(view), minBust }) : null;
    if (rush && rush.reason) log(`Fenêtre LP < 2 M : pas de rotation courte possible (${rush.reason}), paire habituelle.`);
    const short = rush && !rush.reason ? rush : null;
    if (short) size = { ...size, margin: short.margin, leverage: short.leverage, bustMove: short.bustMove, usual: short.leverage };
    const notional = size.margin * size.leverage;
    // Orders are slow to land: even the lowest leverage allowed would leave too little room
    // to close before liquidation. This clears by itself when the relayer catches up, and does
    // not apply when Lighter can hold the whole of a leg should the other one be liquidated.
    const covered = lt && lighterView && !lighterError && lighterView.capacityUsd >= notional;
    if (size.tooSlow && !covered) return wait(`clôtures trop lentes en ce moment (délai estimé ${Math.round(risk.assess(1, config).delay)} s) même au levier minimum x${size.leverage}`);
    const gate = admission(mkts, market, price, notional);
    if (gate.wait) return wait(gate.wait);
    waitReason = null;
    const expected = short ? short.outcome : pairOutcome({ notional, move: size.bustMove * config.closeAt, market, paper: proto.paper, queueEmpty: proto.queueEmpty });
    const tooDear = mode === 'burst' ? null : gates.costGate(expected, config, proto);
    if (tooDear) return wait(tooDear.wait);
    const slow = `clôtures lentes, délai estimé ${Math.round(view.delay)} s`;
    const lowered = size.tooSlow ? ` (${slow}, couvert par Lighter)` : size.leverage < size.usual ? ` (levier abaissé de x${size.usual} : ${slow})` : '';
    if (short)
      log(`Ouverture rotation courte (fenêtre LP < 2 M) @ ${price.toFixed(1)} : ${usd(size.margin)} x${size.leverage} par jambe, clôture dès ${usd(short.lossUsd)} de perte (${pct(short.move)}, ${Math.round(short.closeAt * 100)} % du chemin) : coût ${usd(expected.cost)}, ~${Math.round(expected.minted)} PAPER, ~${Math.round(short.cycleSeconds)} s par cycle`);
    else log(`Ouverture paire BTC @ ${price.toFixed(1)} : ${usd(size.margin)} x${size.leverage} par jambe${lowered}, clôture visée à ${pct(size.bustMove * config.closeAt)} (attendu : coût ${usd(expected.cost)}, ~${Math.round(expected.minted)} PAPER)`);
    status = 'Ouverture de la paire';
    // Both legs are sent at once so that the relayer puts them in the same batch, executed at the
    // same price. Sent one after the other, the second leg waited for the first one's answer and
    // usually landed in a later block, at another price.
    const legs = gate.longFirst ? [true, false] : [false, true];
    const results = await Promise.all(legs.map((isLong) => act(`ouverture ${isLong ? 'long' : 'short'}`, () => ex.open(market, isLong, size.margin, size.leverage, openDeadline))));
    const failures = results.filter(Boolean);
    if (failures.length < legs.length) {
      awaiting = { kind: 'open', sentAt: Date.now(), until: Date.now() + OPEN_COOLDOWN_MS, price };
      // Until these orders' validity runs out they can still execute, even if not visible yet.
      inFlightUntil = Date.now() + openDeadline * 1000 + IN_FLIGHT_MARGIN_MS;
      // One leg went through alone: close it as soon as it shows up instead of waiting.
      if (failures.length) awaiting.orphan = true;
    }
    for (const failed of failures) {
      if (TEMPORARY.has(failed.reason)) noOpenBefore = Math.max(noOpenBefore, Date.now() + BLOCKED_RETRY_MS);
      // A short validity may not be accepted by the relayer: fall back to the frontend's one hour.
      if ((failed.code === 'deadline_expired' || failed.code === 'invalid_intent') && openDeadline < 3600) {
        openDeadline = 3600;
        log('Validité courte refusée, passage à 1 h de validité pour les ouvertures.');
      }
    }
    noOpenBefore = Math.max(noOpenBefore, Date.now() + (short ? BURST_COOLDOWN_MS : OPEN_COOLDOWN_MS));
  };

  const draw = (price, pairs, single) => {
    if (!SCREEN) return;
    try {
      process.stdout.write(
        dashboard.render({
          live: LIVE,
          startedAt,
          price,
          proto,
          mkts,
          market: btc(),
          state,
          pairs,
          single,
          config,
          closeAt: pairs.length ? closeAtFor(pairStatus(pairs[0], price, proto)) : closeAt,
          risk: riskView,
          pressure: relayer.current(),
          status,
          stopReason,
          lighter: lt ? lighterView : null,
          events,
          totals: { cycles, spent: start.realized - realizedAll(), paper: state.paper - start.paper, budgetSpent: budgetFrom - realizedAll() },
        })
      );
    } catch (e) {
      status = `Affichage impossible : ${e.message}`;
    }
  };

  // Keeps the Lighter BTC position opposite to the net Papertrade exposure (lib/hedge.js). Runs in
  // the background, one at a time: a Lighter order never delays a Papertrade close, and a Lighter
  // failure never stops the Papertrade side.
  // The pair the reactive cover follows: exactly one complete pair, not being closed, no bust crossed.
  const coverPair = (positions) => {
    const { pairs: complete } = buildPairs(positions);
    return complete.length === 1 && !busts.size && !(awaiting && awaiting.kind === 'close') ? complete[0] : null;
  };
  const hedgeTick = async (price, positions) => {
    const l = await lt.state();
    const capacity = (Math.max(0, l.equity) * lighterLib.MAX_LEVERAGE * 0.9) / price;
    if (lighterStart === null) lighterStart = l.equity;
    if (lighterError) log('Lighter de nouveau joignable.');
    lighterError = null;
    // The last order's fill, read from the position change: the new position minus the owner's
    // part is the bot's. A refused order changes nothing.
    if (pendingFill && Date.now() >= hedgeRetryAt) {
      if (Math.abs(l.base - pendingFill.before) > 1e-6) setOwn(l.base - pendingFill.baseline);
      pendingFill = null;
    }
    // Nothing left on the account: nothing of the bot's either (the owner may have closed it all).
    if (!pendingFill && !l.base && own) setOwn(0);
    scalpBook.mark(price, scalpHeld);
    if (scalpOn && scalpBook.pnl < -config.lighterScalpMaxLossUsd) {
      scalpOn = false;
      log(`Couverture réactive Lighter arrêtée pour cette session : son résultat (${usd(scalpBook.pnl)}) a passé la limite de -${usd(config.lighterScalpMaxLossUsd)}. La couverture d'urgence reste active.`);
    }
    lighterView = { ...l, own, capacityUsd: capacity * price, scalp: config.lighterScalp ? { on: scalpOn, held: scalpHeld, pnl: scalpBook.pnl } : null };
    if (pendingFill) return;
    // Reactive cover: on one complete pair that is not being closed, never once a bust was crossed.
    let overlay = 0;
    if (scalpOn) {
      const pair = coverPair(positions);
      // A complete pair needs no hedge: what the bot holds on Lighter then is the cover, including
      // one left by a previous run, which a restart must not unwind and take again.
      if (pair && !scalpHeld && own) {
        scalpHeld = own;
        log(`Couverture réactive Lighter : position du bot reprise (${own > 0 ? 'long' : 'short'} ${Math.abs(own).toFixed(5)} BTC).`);
      }
      const r = scalp.cover({ pair, price, now: Date.now(), capBtc: (Math.max(0, l.equity) * SCALP_MAX_LEVERAGE) / price, current: scalpHeld, state: scalpState });
      scalpState = r.state;
      overlay = r.overlay;
    }
    const p = hedge.plan({ positions, busted: busts, current: l.base, own, price, capacity, minTrade: 10, overlay });
    if (!p.order) {
      imbalanceSince = 0;
      partialLogged = false;
      return;
    }
    // While a pair is being opened, a lone leg can be the first half of it: its twin gets the same
    // grace as for the lone-leg close. Anything else (a liquidated leg, unwinding) is acted on at once.
    imbalanceSince = imbalanceSince || Date.now();
    const opening = (awaiting && awaiting.kind === 'open') || Date.now() < inFlightUntil;
    if (!p.reduceOnly && opening && !busts.size && Date.now() - imbalanceSince < LONE_LEG_GRACE_MS) return;
    if (Date.now() < hedgeRetryAt) return;
    if (p.partial && !partialLogged) {
      log(`Lighter : collatéral insuffisant pour tout couvrir, couverture partielle de ${usd(Math.abs(p.hedge) * price)} sur ${usd(Math.abs(p.need) * price)}.`);
      partialLogged = true;
    }
    const btc = (x) => (x ? `${x > 0 ? 'long' : 'short'} ${Math.abs(x).toFixed(5)} BTC` : 'rien');
    const why = p.scalp
      ? `couverture réactive : prix ${p.hedge > 0 ? 'au-dessus' : 'en dessous'} de l'entrée de la paire, la jambe ${p.hedge > 0 ? 'short' : 'long'} perd`
      : !p.need
      ? scalpHeld
        ? 'fin de la couverture réactive'
        : 'fin de la couverture'
      : busts.size
      ? 'une jambe Papertrade a passé son prix de liquidation'
      : 'jambe Papertrade sans sa jumelle';
    const cut = Math.abs(p.baseline) < Math.abs(l.base - own) - 1e-6 ? `, ta position BTC manuelle réduite à ${btc(p.baseline)} pour libérer de la marge` : '';
    log(`Lighter : ${p.order > 0 ? 'achat' : 'vente'} de ${Math.abs(p.order).toFixed(5)} BTC (~${usd(Math.abs(p.order) * price)}), ${why}. Couverture du bot : ${btc(p.hedge)}${cut}.`);
    // Lighter fills or refuses within a second; the next reading shows which.
    hedgeRetryAt = Date.now() + (p.scalp ? SCALP_CONFIRM_MS : 5000);
    pendingFill = { before: l.base, baseline: p.baseline };
    try {
      await lt.trade(p.order, p.reduceOnly);
      // The cover's part of the bot's position: replaced by any real hedge.
      const held = p.scalp ? p.hedge : 0;
      if (held !== scalpHeld) scalpBook.trade(held - scalpHeld, price);
      scalpHeld = held;
    } catch (e) {
      log(`Lighter : ordre refusé (${e.message}), nouvel essai dans 15 s.`);
      hedgeRetryAt = Date.now() + 15000;
      pendingFill = null;
    }
  };
  // One Lighter pass at a time, from the bot's tick or from the live price.
  let coverPositions = null; // BTC positions of the last tick, for the live price
  const runHedge = (price, positions) => {
    if (hedgeBusy) return;
    if (lt.onPrice) lt.onPrice(price);
    hedgeBusy = true;
    hedgeTick(price, positions)
      .catch((e) => {
        if (!lighterError) log(`Lighter injoignable (${e.message}), la couverture reprendra dès que possible.`);
        lighterError = e.message;
      })
      .finally(() => (hedgeBusy = false));
  };
  // The cover turns as soon as the live price crosses the pair's entry, not at the next tick.
  let fastAt = 0;
  if (scalpOn)
    liveMid((mid) => {
      if (!scalpOn || hedgeBusy || pendingFill || !coverPositions || Date.now() < Math.max(hedgeRetryAt, fastAt + FAST_MIN_GAP_MS)) return;
      const pair = coverPair(coverPositions);
      if (!pair) return;
      const want = scalp.cover({ pair, price: mid, now: Date.now(), capBtc: 1, current: scalpHeld, state: scalpState }).overlay;
      if (Math.sign(want) === Math.sign(scalpHeld)) return;
      fastAt = Date.now();
      runHedge(mid, coverPositions);
    });

  // Slow-moving data is refreshed in the background so that it never delays a decision.
  const refreshMarkets = () =>
    api
      .markets()
      .then((m) => Object.assign(mkts, m))
      .catch(() => {});
  // The pool decides the mint rate: under the cliff every dollar lost mints the flat rate, and the
  // window can close within minutes as other farmers' losses refill it.
  let protoBusy = false;
  const refreshProto = () => {
    if (protoBusy) return;
    protoBusy = true;
    readProto()
      .then((p) => {
        if (p.window && !proto.window) log(`${dashboard.poolText(p)} : clôture des pertes et rotations courtes.`);
        if (!p.window && proto.window) log(`Fenêtre refermée : ${dashboard.poolText(p)}. Retour aux rotations habituelles.`);
        proto = p;
      })
      .catch(() => {})
      .finally(() => (protoBusy = false));
  };

  // What each deploy changed goes to nouveautes-papertrade.txt; a failed read is retried at the next check.
  let changesError = null;
  const noteChanges = () =>
    changes.record(config.build, version.formatOk).then((d) => {
      if (!d) return;
      if (d.error) {
        if (d.error !== changesError) log(`Lecture des nouveautés de Papertrade impossible pour l'instant (${d.error}).`);
        changesError = d.error;
        return;
      }
      changesError = null;
      const parts = [
        d.added && `${d.added} texte(s) ajouté(s)`,
        d.removed && `${d.removed} retiré(s)`,
        d.changed && `${d.changed} partie(s) du site modifiée(s)`,
        d.params && `${d.params} paramètre(s) changé(s)`,
      ].filter(Boolean);
      log(`Nouveautés Papertrade : ${parts.join(', ') || 'aucun changement visible'}. Détail : nouveautes.bat`);
    });

  // Follow site deploys: new build id, and a check that the order format is unchanged.
  const refreshSite = () =>
    site
      .check()
      .then((next) => {
        if (next.build && next.build !== config.build) {
          log(`Mise à jour du site détectée : version ${config.build} -> ${next.build}`);
          config.build = next.build;
        }
        if (next.formatOk !== null) version = next;
        return noteChanges();
      })
      .catch(() => {});
  if (version.build) noteChanges().catch(() => {});

  const step = async () => {
    tick++;
    // The live account is read at the same time as the price. The simulated one depends on the
    // price (liquidations), so it is read after it.
    const early = LIVE ? ex.state().then((s) => ({ s }), (e) => ({ e })) : null;
    const price = await api.hlMid('BTC');
    ex.onPrice(price);
    risk.addPrice(price);
    try {
      const got = early ? await early : { s: await ex.state() };
      if (got.e) throw got.e;
      const fresh = got.s;
      const current = fresh.lag * 1000 <= STALE_STATE_MS;
      // An occasional snapshot is minutes old: keep the previous one unless it has aged too.
      if (current || Date.now() - stateAt > STALE_STATE_MS) state = fresh;
      if (current) stateAt = Date.now();
      risk.addLag(fresh.lag);
    } catch (e) {
      // Keep acting on the last known account state for a short while rather than going blind.
      if (Date.now() - stateAt > STALE_STATE_MS) throw e;
    }
    if (tick % REFRESH_TICKS === 0) refreshMarkets();
    if (tick % PROTO_TICKS === 0 || proto.paper.lp < NEAR_CLIFF * proto.paper.threshold) refreshProto();
    if (tick % SITE_CHECK_TICKS === 0) refreshSite();

    const stateStale = Date.now() - stateAt > STALE_STATE_MS;
    const btcPositions = state.positions.filter((p) => p.market && p.market.coin === 'BTC');
    const { pairs, single } = buildPairs(btcPositions);
    busts.update(btcPositions, price);
    coverPositions = btcPositions;
    if (lt) runHedge(price, btcPositions);
    const open = [...single, ...pairs.flatMap((p) => [p.long, p.short])];
    const load = relayer.current();
    risk.setQueueDelay(load ? Math.max(0, load.clearSeconds - 3) : UNKNOWN_QUEUE_DELAY_S);
    singleSince = single.length ? singleSince || Date.now() : 0;
    if (pairs.length) {
      const tightest = Math.min(...pairs.map((p) => pairStatus(p, price, proto).bustMove));
      riskView = risk.assess(tightest, config);
      closeAt = riskView.closeAt;
      // A complete pair is visible: nothing is in flight any more, and the opening succeeded.
      inFlightUntil = 0;
      orphans = 0;
      countedOrphans = '';
    }
    draw(price, pairs, single);

    if (awaiting && awaiting.kind === 'close') {
      const left = open.filter((p) => awaiting.ids.includes(p.id));
      if (!left.length) {
        risk.addLatency(Date.now() - awaiting.sentAt);
        awaiting = null;
        // Give the account a moment to credit the PnL and the PAPER before reading the result.
        await sleep(SETTLE_WAIT_MS);
        try {
          state = await ex.state();
          stateAt = Date.now();
        } catch (e) {}
        recordCycle(price);
        return;
      }
      // Still queued at the relayer (it can take minutes when the network is congested):
      // keep waiting, a resend would only be refused.
      if (Date.now() > awaiting.until && left.every((p) => state.closing.includes(p.id))) {
        if (!awaiting.queuedLogged) log('Clôture toujours dans la file du relayer, attente.');
        awaiting.queuedLogged = true;
        status = 'Clôture dans la file du relayer (réseau congestionné)';
        return;
      }
      if (Date.now() > awaiting.until) {
        log('Clôture non confirmée après 90 s, nouvelle tentative.');
        awaiting = null;
      } else {
        status = 'Clôture envoyée, attente de confirmation';
        return;
      }
    }

    // Close pairs that reached the threshold. This comes before every other wait: orders
    // pending at the relayer or an opening in progress must never delay a due close.
    // Under the cliff, a pair is also due as soon as its loss is worth more now at the flat rate
    // than at its usual close, or at its own best point for short rotations (lib/burst.js).
    const windowDue = (pair) => {
      if (!proto.window) return false;
      const s = pairStatus(pair, price, proto);
      return burst.closeNowWorth({ status: s, proto, config, normalCloseAt: closeAt }) || s.progress >= closeAtFor(s);
    };
    const due = pairs.filter((p) => pairStatus(p, price, proto).progress >= closeAt || windowDue(p));
    if (due.length) {
      if (Date.now() < closeRetryAt) return;
      // After a restart, a close sent earlier may still be queued: wait for it rather than resend.
      if (due.every((p) => state.closing.includes(p.long.id) && state.closing.includes(p.short.id))) {
        status = 'Clôture dans la file du relayer (réseau congestionné)';
        return;
      }
      const s = pairStatus(due[0], price, proto);
      const where = `mouvement ${pct(s.move)} (${Math.round(s.progress * 100)}% du chemin vers la liquidation, seuil ${Math.round(closeAt * 100)}%, délai estimé ${riskView.delay.toFixed(0)} s)`;
      const early = proto.window && s.progress < closeAt;
      await closeAll(due.flatMap((p) => [p.long, p.short]), early ? `fenêtre LP < 2 M, perte de ${usd(s.now.loss)} encaissée à ${mintRate(proto.paper).toFixed(0)} PAPER/$ (~${Math.round(s.now.minted)} PAPER), ${where}` : where);
      return;
    }

    const loneFor = singleSince ? Date.now() - singleSince : 0;
    if (awaiting && awaiting.kind === 'open') {
      if (pairs.length) {
        risk.addLatency(Date.now() - awaiting.sentAt);
        // Shows whether both legs were filled at the same price, and how far from the price at sending.
        const { long, short } = pairs[0];
        const gap = Math.abs(long.entry - short.entry);
        log(`Paire ouverte : long @ ${long.entry.toFixed(1)}, short @ ${short.entry.toFixed(1)} (${gap ? `écart ${gap.toFixed(1)} $` : 'même prix'}, envoyée @ ${awaiting.price.toFixed(1)}, visible après ${((Date.now() - awaiting.sentAt) / 1000).toFixed(0)} s)`);
        awaiting = null;
      } else if (Date.now() > awaiting.until || (awaiting.orphan && single.length) || loneFor > LONE_LEG_GRACE_MS) awaiting = null;
      else {
        status = 'Ouverture envoyée, attente de confirmation';
        return;
      }
    }
    // Orders still queued at the relayer: wait for them, but not forever with a lone leg open.
    if (state.pending && loneFor < LONE_LEG_PENDING_MS) {
      status = `${state.pending} ordre(s) en file chez le relayer`;
      return;
    }

    // A leg left without its hedge is closed. Each incident counts once, however many
    // attempts the close takes, and makes the bot wait longer before opening again.
    if (single.length) {
      if (Date.now() < closeRetryAt) return;
      const ids = single.map((p) => p.id).sort().join(',');
      let note = '';
      if (ids !== countedOrphans) {
        countedOrphans = ids;
        orphans++;
        const pause = Math.min(3600000, BLOCKED_RETRY_MS * 5 ** (orphans - 1));
        noOpenBefore = Math.max(noOpenBefore, Date.now() + pause);
        note = ` (${orphans} de suite, prochaine ouverture dans ${Math.round(pause / 60000)} min au plus tôt)`;
        if (orphans >= config.maxOrphanLegs) stop(`${orphans} paires de suite ouvertes sur une seule jambe`);
      }
      await closeAll(single, `jambe sans couverture${note}`);
      return;
    }

    if (pairs.length) {
      status = 'Surveillance de la paire';
      if (!SCREEN && tick % Math.max(1, Math.round(60 / config.pollSeconds)) === 0) {
        const s = pairStatus(pairs[0], price, proto);
        log(`BTC ${price.toFixed(1)} | paire ${usd(s.loser.margin)} x${s.loser.leverage} | mouvement ${pct(s.move)} / ${pct(s.bustMove)} (${Math.round(s.progress * 100)}%) | seuil ${Math.round(closeAtFor(s) * 100)}% | mint ${mintRate(proto.paper).toFixed(2)}`);
      }
      return;
    }

    // Flat. An open order sent earlier may still execute until its validity runs out:
    // neither open again nor exit before that.
    if (Date.now() < inFlightUntil) {
      status = 'Attente de l\'expiration des ordres d\'ouverture envoyés';
      return;
    }
    if (stopReason) {
      // Leave only once Lighter is flat too (the hedge tick closes it when Papertrade is flat).
      if (lt && (!lighterView || Math.abs(own) >= 1e-5)) {
        status = 'Arrêt en cours : fermeture de la couverture Lighter';
        return;
      }
      log(`Bot arrêté : ${stopReason}.`);
      draw(price, pairs, single);
      if (lt) lt.stop();
      process.exit(0);
    }
    const gate = gates.whenFlat({
      live: LIVE,
      spent: budgetFrom - realizedAll(),
      config,
      proto,
      keyExpiry: state.keyExpiry,
      formatOk: version.formatOk,
      stale: stateStale || state.lag * 1000 > STALE_STATE_MS,
      load,
    });
    if (gate.stop) return stop(gate.stop);
    if (gate.wait) return wait(gate.wait);
    if (Date.now() < noOpenBefore) {
      if (!waitReason) status = 'Pause avant la prochaine ouverture';
      return;
    }
    await openPair(price, gate.open);
  };

  for (;;) {
    await sleep(config.pollSeconds * 1000);
    try {
      await step();
      if (lastLoopError) log(`Lectures rétablies après ${Math.round((Date.now() - lastLoopError.since) / 1000)} s (${lastLoopError.count} échec(s))`);
      lastLoopError = null;
    } catch (e) {
      // Nothing may take the loop down while a position can be open: report and try again.
      // A run of failures is logged once when it starts and once when it ends.
      status = `Lecture impossible : ${e.message}`;
      if (!lastLoopError) {
        log(status);
        lastLoopError = { since: Date.now(), count: 0 };
      }
      lastLoopError.count++;
    }
  }
}

// Ctrl+C read as a keystroke: a window started from another program can have the Ctrl+C
// signal disabled, which left the window's close button as the only way out.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on('data', (key) => {
    if (key[0] !== 3) return;
    log('Arrêt demandé au clavier (Ctrl+C)');
    if (SCREEN) process.stdout.write('\x1b[2J\x1b[H');
    process.exit(0);
  });
}

process.on('uncaughtException', (e) => log(`Erreur inattendue : ${e.message}`));
process.on('unhandledRejection', (e) => log(`Erreur inattendue : ${e && e.message ? e.message : e}`));

main().catch((e) => {
  log(`Arrêt au démarrage : ${e.message}`);
  if (SCREEN) console.error(e.message);
  process.exit(1);
});
