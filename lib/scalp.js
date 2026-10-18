'use strict';

// Lighter reactive cover (setting lighterScalp). While a Papertrade pair is complete, the bot holds
// on Lighter the side that offsets the losing leg: long while the price is above the pair's entry
// (the short leg loses), short below. It turns as soon as the price crosses the entry, at most once
// every MIN_HOLD_MS. The emergency hedge (lib/hedge.js) replaces it as soon as a leg is liquidated
// or left alone.
//
// At the close of a pair the last side held wins what the losing leg lost (at its own size); each
// turn before that costs the spread and the drift during the reaction. Lighter charges no fee, and
// the bot reacts on a live price (about every 200 ms): on 14 days of 1-second BTC prices (October
// 2026) at Lighter's measured spread, this came out about even, against a small loss for a
// trend-following overlay. The ledger keeps its result apart, and the bot stops it past a loss limit.

const MIN_HOLD_MS = 2000;
const SPREAD = 0.35e-4; // cost of a Lighter market order, relative: half the spread measured on 2026-10-18

const round = (x) => Math.round(x * 1e5) / 1e5 || 0;

// Overlay to hold (BTC, long positive) and the state to pass back next time. `capBtc`: the largest
// overlay the Lighter collateral may carry; the size is set when a side is taken and kept until the
// next turn. `current`: what the bot holds now (after a restart, taken back as it is).
function cover({ pair, price, now, capBtc, current = 0, state }) {
  if (!pair) return { overlay: 0, state: { side: 0, since: now, size: 0 } };
  if (!state) state = { side: Math.sign(current), since: -Infinity, size: Math.abs(current) };
  const entry = (pair.long.entry + pair.short.entry) / 2;
  const leg = Math.min(pair.long.notional, pair.short.notional) / entry;
  const want = price > entry ? 1 : price < entry ? -1 : state.side;
  let next = state;
  if (want !== state.side && (!state.side || now - state.since >= MIN_HOLD_MS)) next = { side: want, since: now, size: Math.min(capBtc, leg) };
  return { overlay: round(next.side * next.size), state: next };
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

module.exports = { cover, ledger, MIN_HOLD_MS };
