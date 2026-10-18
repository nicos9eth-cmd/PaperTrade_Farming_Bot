'use strict';

// Cross-DEX hedge: the bot's BTC position on Lighter mirrors, with the opposite sign, the net BTC
// exposure of the Papertrade positions. A complete pair is flat, so the bot holds nothing there;
// when one leg is liquidated (or left alone) while the relayer is too slow to close the other,
// it holds the opposite of that leg within a second. A BTC position the owner opened by hand on
// the same Lighter account is kept, and only reduced if the hedge needs its margin.

const BUST_RECHECK_MS = 300000; // a crossed bust not followed by a liquidation is trusted again after 5 min

// Remembers which Papertrade positions crossed their liquidation price. Papertrade's keeper
// liquidates as soon as the price crosses the bust (with priority over every other transaction),
// while the account state can show it minutes later: a crossed leg is counted as gone at once.
function bustTracker() {
  const crossed = new Map(); // id -> time first crossed
  return {
    update(positions, price, now = Date.now()) {
      const ids = new Set(positions.map((p) => p.id));
      for (const id of crossed.keys()) if (!ids.has(id)) crossed.delete(id);
      for (const p of positions) {
        const beyond = p.isLong ? price <= p.bust : price >= p.bust;
        if (beyond && !crossed.has(p.id)) crossed.set(p.id, now);
        // Still listed long after the price came back: the keeper did not take it, it is alive.
        if (!beyond && crossed.has(p.id) && now - crossed.get(p.id) > BUST_RECHECK_MS) crossed.delete(p.id);
      }
      return crossed;
    },
    has: (id) => crossed.has(id),
    get size() {
      return crossed.size;
    },
  };
}

// Net BTC exposure (long positive) of the Papertrade positions still alive.
function exposure(positions, busted) {
  return positions.filter((p) => !busted.has(p.id)).reduce((s, p) => s + ((p.isLong ? 1 : -1) * p.notional) / p.entry, 0);
}

const round = (x) => Math.round(x * 1e5) / 1e5 || 0; // Lighter's 0.00001 BTC step, and no -0

// What to do on Lighter. The account's BTC position is the owner's own position (`baseline`, left
// alone while nothing needs hedging) plus the bot's hedge (`own`, the part the bot opened itself).
// `capacity` is the largest total BTC position (in BTC) the Lighter collateral allows. The hedge
// has priority: the owner's BTC position is shrunk only when the hedge needs its margin, and the
// owner's other Lighter markets are never touched.
// `overlay` is the trend overlay (lib/scalp.js) the bot holds while the Papertrade exposure is too
// small to trade; any real exposure (a leg liquidated or alone) replaces it at once.
// Returns { need, hedge, baseline, target, order, reduceOnly, partial, scalp }: `order` is the signed
// BTC amount to trade (0: nothing), `reduceOnly` is set when it shrinks the position without flipping it.
function plan({ positions, busted, current, own = 0, price, capacity, minTrade, overlay = 0 }) {
  const exposed = round(-exposure(positions, busted));
  const scalp = Math.abs(exposed) * price < minTrade && overlay !== 0;
  const need = scalp ? round(overlay) : exposed;
  let baseline = round(current - own);
  // A hedge opposite to the owner's position nets against it, which frees margin. The overlay,
  // unlike a real hedge, only uses the margin the owner's position leaves.
  const netting = Math.sign(baseline) === -Math.sign(need);
  const room = netting ? capacity + Math.abs(baseline) : scalp ? Math.max(0, capacity - Math.abs(baseline)) : capacity;
  const hedge = round(Math.sign(need) * Math.min(Math.abs(need), room));
  if (hedge && Math.sign(baseline) === Math.sign(hedge) && Math.abs(baseline + hedge) > capacity)
    baseline = round(Math.sign(baseline) * Math.max(0, capacity - Math.abs(hedge)));
  const target = round(baseline + hedge);
  let order = round(target - current);
  // Differences below Lighter's minimum order (about $10) are left alone.
  if (Math.abs(order) * price < minTrade) order = 0;
  const reduceOnly = order !== 0 && Math.sign(order) === -Math.sign(current) && Math.abs(order) <= Math.abs(current);
  return { need, hedge, baseline, target, order, reduceOnly, partial: !scalp && Math.abs(hedge) < Math.abs(need), scalp };
}

module.exports = { bustTracker, exposure, plan };
