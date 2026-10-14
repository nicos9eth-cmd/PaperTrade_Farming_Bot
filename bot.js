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
const { buildPairs, pairStatus } = require('./lib/pairs');
const { mintRate, pairOutcome } = require('./lib/economics');
let config;
try {
  config = require('./lib/config').load();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const LIVE = process.argv.includes('--live');
const SCREEN = process.stdout.isTTY && !process.argv.includes('--plain');
const JOURNAL = path.join(__dirname, LIVE ? 'journal.csv' : 'journal-simulation.csv');
const LOG_FILE = path.join(__dirname, LIVE ? 'bot.log' : 'bot-simulation.log');
const BUDGET_FILE = path.join(__dirname, '.budget.json');
const OPEN_COOLDOWN_MS = 60000;
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

// Margin per leg and leverage for a new pair, or the reason none can be opened.
function sizePair(available, mkts, market) {
  let margin = Math.floor(((available * (1 - config.reserve)) / 2) * 100) / 100;
  if (config.maxMarginPerLeg) margin = Math.min(margin, config.maxMarginPerLeg);
  if (margin < mkts.minMargin) return { reason: `capital insuffisant (${usd(available)} disponible, minimum ${usd(mkts.minMargin)} par jambe)` };
  const wanted = Math.round(1 / (config.targetMove / config.closeAt + market.liquidationBuffer));
  const leverage = Math.min(market.maxLeverage, Math.max(Math.ceil(mkts.minNotional / margin), wanted));
  if (market.maxNotional) margin = Math.min(margin, Math.floor((market.maxNotional / leverage) * 100) / 100);
  return { margin, leverage, bustMove: 1 / leverage - market.liquidationBuffer };
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
  // The leg that widens the net imbalance is the one most likely to be refused: send it first.
  const longFirst = room.net >= 0;
  if (mkts.maxNetOi && Math.abs(room.net) + need > mkts.maxNetOi) return { wait: `open interest net au plafond côté ${longFirst ? 'long' : 'short'}` };
  return { longFirst };
}

async function main() {
  if (!config.wallet && LIVE) throw new Error('Aucun wallet configuré : lance d\'abord setup.bat');
  const mkts = await api.markets();
  let proto = await api.protocol();
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
    const w = config.wallet && !config.simulationCapital ? await api.walletSnapshot(config.wallet) : null;
    const capital = config.simulationCapital || (w ? api.num(w.funds.availableBalance) + api.num(w.locked) : 100);
    ex = exchange.simulated(config, mkts, capital, () => proto);
  }

  let state = await ex.state();
  let stateAt = Date.now();
  if (LIVE && state.keyExpiry * 1000 < Date.now() + 2 * 3600e3) throw new Error('Clé de session absente ou expirée côté Papertrade : relance setup.bat');
  if (LIVE && state.paperStaked < mkts.minPaperStake)
    log(`Attention : ${Math.round(state.paperStaked)} PAPER staké, le relayer indique un minimum de ${mkts.minPaperStake}. Les ordres peuvent être refusés.`);

  const startedAt = Date.now();
  const start = { realized: state.realized, paper: state.paper };
  const budgetFrom = budgetStart(state.realized);
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
  let orphans = 0; // single-leg incidents in a row
  let countedOrphans = '';
  let stopReason = null;
  let status = 'Démarrage';
  let waitReason = null;
  let lastLoopError = null;
  let tick = 0;

  log(version.build ? `Version du site détectée : ${version.build}` : `Version du site introuvable, utilisation de ${config.build} (config.json)`);
  log(`Mode ${ex.name} | disponible ${usd(state.available)} | ${state.positions.length} position(s) ouverte(s) | mint ${mintRate(proto.paper).toFixed(2)} PAPER/$`);
  if (LIVE && Math.abs(budgetFrom - state.realized) > 0.005) log(`Budget repris d'un lancement précédent : ${usd(budgetFrom - state.realized)} déjà dépensés sur ${usd(config.maxNetLossUsd)}`);
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
    const pnl = state.realized - last.realized;
    const paper = state.paper - last.paper;
    last = { realized: state.realized, paper: state.paper };
    cycles++;
    const spent = start.realized - state.realized;
    const total = state.paper - start.paper;
    log(`Cycle terminé : PnL ${usd(pnl)}, +${Math.round(paper)} PAPER${paper > 0 ? `, $${(-pnl / paper).toFixed(4)} par PAPER` : ''} | cumul : coût ${usd(spent)}, ${Math.round(total)} PAPER`);
    journal([new Date().toISOString(), price.toFixed(1), pnl.toFixed(4), paper.toFixed(2), paper > 0 ? (-pnl / paper).toFixed(5) : '', spent.toFixed(4), total.toFixed(2)]);
  };

  const openPair = async (price) => {
    const market = btc();
    if (!market) return wait('marché BTC introuvable');
    const size = sizePair(state.available, mkts, market);
    if (size.reason) {
      // The balance may simply not be credited yet after a close: only give up if it lasts.
      lowBalanceSince = lowBalanceSince || Date.now();
      if (Date.now() - lowBalanceSince > LOW_BALANCE_GRACE_MS) return stop(size.reason);
      return wait('solde en cours de mise à jour');
    }
    lowBalanceSince = 0;
    const notional = size.margin * size.leverage;
    const gate = admission(mkts, market, price, notional);
    if (gate.wait) return wait(gate.wait);
    waitReason = null;
    const expected = pairOutcome({ notional, move: size.bustMove * config.closeAt, market, paper: proto.paper, queueEmpty: proto.queueEmpty });
    if (config.maxCostPerPaper && expected.costPerPaper > config.maxCostPerPaper)
      return stop(`coût attendu $${expected.costPerPaper.toFixed(4)} par PAPER au-dessus du plafond $${config.maxCostPerPaper}`);
    log(`Ouverture paire BTC @ ${price.toFixed(1)} : ${usd(size.margin)} x${size.leverage} par jambe, clôture visée à ${pct(size.bustMove * config.closeAt)} (attendu : coût ${usd(expected.cost)}, ~${Math.round(expected.minted)} PAPER)`);
    status = 'Ouverture de la paire';
    let sent = 0;
    for (const isLong of gate.longFirst ? [true, false] : [false, true]) {
      const failed = await act(`ouverture ${isLong ? 'long' : 'short'}`, () => ex.open(market, isLong, size.margin, size.leverage, openDeadline));
      if (failed) {
        if (TEMPORARY.has(failed.reason)) noOpenBefore = Math.max(noOpenBefore, Date.now() + BLOCKED_RETRY_MS);
        // A short validity may not be accepted by the relayer: fall back to the frontend's one hour.
        if ((failed.code === 'deadline_expired' || failed.code === 'invalid_intent') && openDeadline < 3600) {
          openDeadline = 3600;
          log('Validité courte refusée, passage à 1 h de validité pour les ouvertures.');
        }
        // The first leg went through alone: close it as soon as it shows up instead of waiting.
        if (sent === 1) awaiting.orphan = true;
        break;
      }
      sent++;
      if (sent === 1) {
        awaiting = { kind: 'open', sentAt: Date.now(), until: Date.now() + OPEN_COOLDOWN_MS };
        // Until this order's validity runs out it can still execute, even if it is not visible yet.
        inFlightUntil = Date.now() + openDeadline * 1000 + IN_FLIGHT_MARGIN_MS;
      }
    }
    noOpenBefore = Math.max(noOpenBefore, Date.now() + OPEN_COOLDOWN_MS);
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
          closeAt,
          risk: riskView,
          pressure: relayer.current(),
          status,
          stopReason,
          events,
          totals: { cycles, spent: start.realized - state.realized, paper: state.paper - start.paper, budgetSpent: budgetFrom - state.realized },
        })
      );
    } catch (e) {
      status = `Affichage impossible : ${e.message}`;
    }
  };

  // Slow-moving data is refreshed in the background so that it never delays a decision.
  const refreshMarkets = () =>
    Promise.all([api.protocol(), api.markets()])
      .then(([p, m]) => {
        proto = p;
        Object.assign(mkts, m);
      })
      .catch(() => {});

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
      })
      .catch(() => {});

  const step = async () => {
    tick++;
    const price = await api.hlMid('BTC');
    ex.onPrice(price);
    risk.addPrice(price);
    try {
      const fresh = await ex.state();
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
    if (tick % SITE_CHECK_TICKS === 0) refreshSite();

    const stateStale = Date.now() - stateAt > STALE_STATE_MS;
    const { pairs, single } = buildPairs(state.positions.filter((p) => p.market && p.market.coin === 'BTC'));
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
    const due = pairs.filter((p) => pairStatus(p, price, proto).progress >= closeAt);
    if (due.length) {
      if (Date.now() < closeRetryAt) return;
      // After a restart, a close sent earlier may still be queued: wait for it rather than resend.
      if (due.every((p) => state.closing.includes(p.long.id) && state.closing.includes(p.short.id))) {
        status = 'Clôture dans la file du relayer (réseau congestionné)';
        return;
      }
      const s = pairStatus(due[0], price, proto);
      await closeAll(due.flatMap((p) => [p.long, p.short]), `mouvement ${pct(s.move)} (${Math.round(s.progress * 100)}% du chemin vers la liquidation, seuil ${Math.round(closeAt * 100)}%, délai estimé ${riskView.delay.toFixed(0)} s)`);
      return;
    }

    const loneFor = singleSince ? Date.now() - singleSince : 0;
    if (awaiting && awaiting.kind === 'open') {
      if (pairs.length) {
        risk.addLatency(Date.now() - awaiting.sentAt);
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
        log(`BTC ${price.toFixed(1)} | paire ${usd(s.loser.margin)} x${s.loser.leverage} | mouvement ${pct(s.move)} / ${pct(s.bustMove)} (${Math.round(s.progress * 100)}%) | seuil ${Math.round(closeAt * 100)}% | mint ${mintRate(proto.paper).toFixed(2)}`);
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
      log(`Bot arrêté : ${stopReason}.`);
      draw(price, pairs, single);
      process.exit(0);
    }
    const spent = budgetFrom - state.realized;
    if (config.maxNetLossUsd && spent >= config.maxNetLossUsd)
      stop(`budget atteint (${usd(spent)} dépensés sur ${usd(config.maxNetLossUsd)}) ; pour repartir, change maxNetLossUsd dans config.json`);
    else if (mintRate(proto.paper) < config.minMintRate) stop(`taux de mint ${mintRate(proto.paper).toFixed(2)} sous le plancher ${config.minMintRate}`);
    else if (LIVE && state.keyExpiry * 1000 < Date.now() + 2 * 3600e3) stop('clé de session bientôt expirée, relance setup.bat');
    if (stopReason) return;

    // Conditions that can clear by themselves: wait rather than stop.
    if (version.formatOk === false) return wait('le format des ordres a changé sur le site Papertrade, le bot doit être mis à jour');
    if (stateStale || state.lag * 1000 > STALE_STATE_MS) return wait('état du compte en retard côté Papertrade');
    if (!proto.queueEmpty && config.pauseWhenQueueActive) return wait('queue de paiement active');
    if (load && load.level === 'HIGH') return wait(`relayer congestionné (${load.pending} ordres en attente)`);
    if (Date.now() < noOpenBefore) {
      if (!waitReason) status = 'Pause avant la prochaine ouverture';
      return;
    }
    await openPair(price);
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
