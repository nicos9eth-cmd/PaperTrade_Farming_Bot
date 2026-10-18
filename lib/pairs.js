'use strict';

const { pairOutcome } = require('./economics');

// Groups opposite positions of the same market and notional into hedged pairs.
function buildPairs(positions) {
  const pairs = [];
  const single = [];
  const rest = positions.slice();
  while (rest.length) {
    const a = rest.shift();
    const i = rest.findIndex(
      (b) => b.market.id === a.market.id && b.isLong !== a.isLong && Math.abs(b.notional - a.notional) < 0.01 * a.notional
    );
    if (i < 0) single.push(a);
    else {
      const b = rest.splice(i, 1)[0];
      pairs.push(a.isLong ? { long: a, short: b } : { long: b, short: a });
    }
  }
  return { pairs, single };
}

// How far a leg has travelled toward its own liquidation price (0 at entry, 1 at bust).
function legProgress(leg, price) {
  const adverse = leg.isLong ? leg.entry - price : price - leg.entry;
  const bustMove = Math.abs(leg.bust - leg.entry) / leg.entry;
  return { move: Math.max(0, adverse) / leg.entry, bustMove };
}

// Where a pair stands at the given price, and what closing it now would yield.
// Each leg is measured from its own entry, so legs opened at slightly different prices
// never make the pair look further from liquidation than its worst leg really is.
function pairStatus(pair, price, proto) {
  const { long, short } = pair;
  const entry = (long.entry + short.entry) / 2;
  const l = legProgress(long, price);
  const s = legProgress(short, price);
  const longWorse = l.move / l.bustMove >= s.move / s.bustMove;
  const loser = longWorse ? long : short;
  const { move, bustMove } = longWorse ? l : s;
  const outcome = (m) => pairOutcome({ notional: loser.notional, move: m, market: loser.market, paper: proto.paper, queueEmpty: proto.queueEmpty });
  return { entry, move, loser, bustMove, progress: move / bustMove, now: outcome(move), at: (fraction) => outcome(bustMove * fraction) };
}

// The long filled above the short: that gap is lost whatever the price does (`cost` in USD, for the
// smaller leg). Each leg is its own order, and the relayer can fill them in two blocks.
function entryGap(pair) {
  const gap = pair.long.entry - pair.short.entry;
  const mid = (pair.long.entry + pair.short.entry) / 2;
  return { gap, cost: gap ? (gap * Math.min(pair.long.notional, pair.short.notional)) / mid : 0 };
}

module.exports = { buildPairs, pairStatus, entryGap };
