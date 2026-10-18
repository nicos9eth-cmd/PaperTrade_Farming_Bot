'use strict';

// Lighter trend overlay (setting lighterScalp). While a Papertrade pair is complete, the bot holds on
// Lighter the side the price is moving to from the pair's entry, which offsets the losing leg; the
// emergency hedge (lib/hedge.js) replaces it as soon as a leg is liquidated or left alone.
//
// What pays is a trend, not volatility: a fast back-and-forth is where an overlay loses the most.
// - Size follows the trend's strength (Kaufman's efficiency ratio): nothing under ER_LOW, a whole
//   leg from ER_HIGH, and nothing while the short-term move goes against the side held.
// - A side is taken once the price is out of a band around the entry that widens with volatility,
//   and kept at least MIN_HOLD_MS: inside the band the bot never turns.
// - Small resizes are skipped: each Lighter order pays the spread.
// Over many cycles a pure overlay earns about nothing on a random walk, less the spread: the ledger
// keeps its own result so that the owner can judge it, and the bot stops it past a loss limit.

const ER_LOW = 0.2;
const ER_HIGH = 0.6;
const BAND_SIGMAS = 1;
const BAND_HORIZON_S = 60;
const BAND_SHARE = 0.25; // never wider than a quarter of the pair's close distance
const MIN_HOLD_MS = 20000;
const RESIZE = 0.25; // share of a leg below which a resize is not worth an order
const SPREAD = 1e-4; // estimated cost of a Lighter market order, relative
const TREND_WINDOW_MS = 120000;

const round = (x) => Math.round(x * 1e5) / 1e5 || 0;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Overlay to hold (BTC, long positive) and the state to pass back next time.
// `trend`: { er, net } from risk.tracker().trend(TREND_WINDOW_MS); `closeMove`: the pair's close
// distance from entry (relative); `capBtc`: the largest overlay the Lighter collateral may carry.
function target({ pair, price, now, vol, trend, closeMove, capBtc, current = 0, state = { side: 0, since: 0 } }) {
  if (!pair) return { overlay: 0, state: { side: 0, since: now }, share: 0 };
  const entry = (pair.long.entry + pair.short.entry) / 2;
  const leg = Math.min(pair.long.notional, pair.short.notional) / entry;
  const band = Math.min(BAND_SIGMAS * vol * Math.sqrt(BAND_HORIZON_S), BAND_SHARE * closeMove);
  const off = price / entry - 1;
  let side = off > band ? 1 : off < -band ? -1 : state.side;
  if (side !== state.side && state.side && now - state.since < MIN_HOLD_MS) side = state.side;
  const next = side === state.side ? state : { side, since: now };
  const share = side && Math.sign(trend.net) === side ? clamp((trend.er - ER_LOW) / (ER_HIGH - ER_LOW), 0, 1) : 0;
  let overlay = round(side * Math.min(share * leg, capBtc));
  if (current && Math.abs(overlay - current) < RESIZE * leg && Math.sign(overlay) !== -Math.sign(current)) overlay = current;
  return { overlay, state: next, share };
}

// Result of the overlay alone: mark to market between readings, less the spread on each trade.
function ledger() {
  let pnl = 0;
  let last = null;
  let position = 0;
  return {
    mark(price, held) {
      if (last !== null) pnl += position * (price - last);
      last = price;
      position = held;
      return pnl;
    },
    trade(btc, price) {
      pnl -= Math.abs(btc) * price * SPREAD;
    },
    get pnl() {
      return pnl;
    },
  };
}

module.exports = { target, ledger, MIN_HOLD_MS, TREND_WINDOW_MS };
