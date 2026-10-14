'use strict';

// How big a pair the bot opens for a given balance, and what a cycle is expected to cost.

const { pairOutcome } = require('./economics');

const usd = (n) => '$' + n.toFixed(2);

// Margin per leg and leverage for a new pair, or the reason none can be opened.
function sizePair(available, mkts, market, config) {
  let margin = Math.floor(((available * (1 - config.reserve)) / 2) * 100) / 100;
  if (config.maxMarginPerLeg) margin = Math.min(margin, config.maxMarginPerLeg);
  if (margin < mkts.minMargin) return { reason: `capital insuffisant (${usd(available)} disponible, minimum ${usd(mkts.minMargin)} par jambe)` };
  const wanted = Math.round(1 / (config.targetMove / config.closeAt + market.liquidationBuffer));
  const leverage = Math.min(market.maxLeverage, Math.max(Math.ceil(mkts.minNotional / margin), wanted));
  if (market.maxNotional) margin = Math.min(margin, Math.floor((market.maxNotional / leverage) * 100) / 100);
  return { margin, leverage, bustMove: 1 / leverage - market.liquidationBuffer };
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

module.exports = { sizePair, cycleRange };
