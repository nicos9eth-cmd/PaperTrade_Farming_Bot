'use strict';

// How big a pair the bot opens for a given balance, and what a cycle is expected to cost.

const { pairOutcome } = require('./economics');

const usd = (n) => '$' + n.toFixed(2);

// Margin per leg and leverage for a new pair, or the reason none can be opened.
// `minBust` (optional) is the distance to liquidation the current close delay requires: the
// leverage is lowered to keep it, and `tooSlow` is set when even the minimum notional's leverage
// cannot (the caller then waits rather than opening).
function sizePair(available, mkts, market, config, minBust = 0) {
  let margin = Math.floor(((available * (1 - config.reserve)) / 2) * 100) / 100;
  if (config.maxMarginPerLeg) margin = Math.min(margin, config.maxMarginPerLeg);
  if (margin < mkts.minMargin) return { reason: `capital insuffisant (${usd(available)} disponible, minimum ${usd(mkts.minMargin)} par jambe)` };
  const wanted = Math.round(1 / (config.targetMove / config.closeAt + market.liquidationBuffer));
  const floor = Math.ceil(mkts.minNotional / margin);
  const safe = minBust > 0 ? Math.floor(1 / (minBust + market.liquidationBuffer)) : Infinity;
  const usual = Math.min(market.maxLeverage, Math.max(floor, wanted));
  const leverage = Math.min(market.maxLeverage, Math.max(floor, Math.min(wanted, safe)));
  if (market.maxNotional) margin = Math.min(margin, Math.floor((market.maxNotional / leverage) * 100) / 100);
  return { margin, leverage, bustMove: 1 / leverage - market.liquidationBuffer, usual, tooSlow: floor > safe, safe };
}

// Expected cycle for a balance: `late` closes at closeAt (calm market), `early` at minCloseAt
// (agitated or congested), which is the range the adaptive threshold moves in.
function cycleRange(available, mkts, market, proto, config) {
  const size = sizePair(available, mkts, market, config);
  if (size.reason) return size;
  const notional = size.margin * size.leverage;
  const at = (share) => pairOutcome({ notional, move: size.bustMove * share, market, paper: proto.paper, queueEmpty: proto.queueEmpty });
  return { ...size, notional, late: at(config.closeAt), early: at(config.minCloseAt) };
}

// Lowest leverage that still reaches Papertrade's minimum position size with this balance, without
// waiting for more than `maxMove` before closing, and the targetMove setting that selects it.
// At equal margin, the loss per cycle (hence the PAPER minted) barely depends on leverage: a lower
// one only puts liquidation further away, and needs a bigger move to complete a cycle.
function lowestLeverage(available, mkts, market, config, maxMove = 0.02) {
  const size = sizePair(available, mkts, market, { ...config, targetMove: maxMove });
  if (size.reason) return size;
  const targetMove = Math.floor(config.closeAt * (1 / size.leverage - market.liquidationBuffer) * 1e5) / 1e5;
  return { leverage: size.leverage, targetMove };
}

module.exports = { sizePair, cycleRange, lowestLeverage };
