'use strict';

// Short rotations while the pool is under the cliff, where every dollar lost mints the flat rate
// (100 PAPER/$, about 8 times the tail rate of October 2026). The window is rare and other farmers'
// losses close it, so the bot turns losses into PAPER as fast as it can, within a cost ceiling.
//
// A price that wanders with volatility `vol` (relative, per square-root second) first leaves a band
// of +-m after (m / vol)^2 seconds on average. A cycle closing at a move m therefore lasts about
// (m / vol)^2 + `overhead` (opening and closing at the relayer), and mints notional x m x rate.
// Short cycles mint more per hour but keep less of the winning leg: the ceiling sets the trade-off.

const { pairOutcome } = require('./economics');
const { sizePair } = require('./sizing');

const MIN_CYCLE_S = 20; // never spam the relayer with more than a cycle every 20 s
const STEP = 0.01;
const MIN_SHARE = 0.03;

// Best close point (share of the way to liquidation) for one pair, or null when no share meets the
// ceiling. `only` evaluates a single share instead (for comparisons).
function bestClose({ notional, bustMove, market, proto, config, vol, overhead, only = null }) {
  let best = null;
  const shares = only ? [only] : [];
  for (let f = MIN_SHARE; !only && f <= config.closeAt + 1e-9; f += STEP) shares.push(Math.round(f * 100) / 100);
  for (const f of shares) {
    const move = f * bustMove;
    const outcome = pairOutcome({ notional, move, market, paper: proto.paper, queueEmpty: proto.queueEmpty });
    if (!(outcome.costPerPaper <= config.burstMaxCostPerPaper)) continue;
    const cycleSeconds = Math.max(MIN_CYCLE_S, (move / vol) ** 2 + overhead);
    const perHour = (outcome.minted * 3600) / cycleSeconds;
    if (!best || perHour > best.perHour) best = { closeAt: f, move, outcome, cycleSeconds, perHour };
  }
  return best;
}

// Size and close point of the next pair in the window: the leverage and close share that mint the
// most PAPER per hour, never with less room to liquidation than the close delay needs (`minBust`).
function optimize({ available, mkts, market, proto, config, vol, overhead, minBust = 0 }) {
  const size = sizePair(available, mkts, market, config, minBust);
  if (size.reason) return size;
  if (size.tooSlow) return { reason: `clôtures trop lentes en ce moment, même au levier minimum x${size.leverage}` };
  const floor = Math.ceil(mkts.minNotional / size.margin);
  const top = Math.min(market.maxLeverage, size.safe);
  let best = null;
  for (let leverage = floor; leverage <= top; leverage++) {
    const margin = market.maxNotional ? Math.min(size.margin, Math.floor((market.maxNotional / leverage) * 100) / 100) : size.margin;
    const notional = margin * leverage;
    const bustMove = 1 / leverage - market.liquidationBuffer;
    const c = bestClose({ notional, bustMove, market, proto, config, vol, overhead });
    if (c && (!best || c.perHour > best.perHour)) best = { ...c, margin, leverage, notional, bustMove, lossUsd: notional * c.move };
  }
  if (!best) return { reason: `coût par PAPER au-dessus du plafond de la fenêtre ($${config.burstMaxCostPerPaper}) quelle que soit la rotation` };
  return best;
}

// Whether the pair open when the window starts is worth closing now: closing it at the flat rate
// mints at least what its usual close (at `normalCloseAt`) would at the tail rate, within the ceiling.
function closeNowWorth({ status, proto, config, normalCloseAt }) {
  if (!proto.window || !(status.now.minted > 0)) return false;
  if (!(status.now.costPerPaper <= config.burstMaxCostPerPaper)) return false;
  const paper = { ...proto.paper, lp: Math.max(proto.paper.lp, proto.paper.threshold) };
  const usual = pairOutcome({ notional: status.loser.notional, move: status.bustMove * normalCloseAt, market: status.loser.market, paper, queueEmpty: proto.queueEmpty });
  return status.now.minted >= usual.minted;
}

// The protocol summary with the pool put under the cliff (simulation only, --simuler-fenetre), to
// watch the short rotations without waiting for a real window.
function simulatedWindow(proto) {
  return { ...proto, window: true, paper: { ...proto.paper, lp: proto.paper.threshold * 0.75 } };
}

module.exports = { optimize, bestClose, closeNowWorth, simulatedWindow, MIN_CYCLE_S };
