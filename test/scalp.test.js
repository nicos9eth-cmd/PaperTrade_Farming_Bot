'use strict';

// Lighter trend overlay: while a Papertrade pair is open, the bot holds on Lighter the side the
// price is trending to (the opposite of the losing leg), sized by the trend's strength.

const assert = require('assert');
const { tracker } = require('../lib/risk');
const { target, ledger, MIN_HOLD_MS } = require('../lib/scalp');

const CALM = 0.02 / Math.sqrt(86400);
const ENTRY = 80000;
const legOf = (isLong) => ({ id: isLong ? 'L' : 'S', isLong, entry: ENTRY, notional: 49.5 * 81 });
const pair = { long: legOf(true), short: legOf(false) };
const LEG = (49.5 * 81) / ENTRY; // one leg in BTC, about 0.0501
const closeMove = 0.85 * (1 / 81 - 0.000476);

// Runs the overlay along a price path (one price every 2 s), as the bot's hedge tick does.
function run(path, { capBtc = 1, start = 0 } = {}) {
  const t = tracker();
  const book = ledger();
  let state;
  let current = 0;
  let orders = 0;
  let flips = 0;
  path.forEach((price, i) => {
    const now = start + i * 2000;
    t.addPrice(price, now);
    const r = target({ pair, price, now, vol: CALM, trend: t.trend(120000, now), closeMove, capBtc, current, state });
    state = r.state;
    if (r.overlay !== current) {
      orders++;
      if (current && r.overlay && Math.sign(r.overlay) !== Math.sign(current)) flips++;
      book.trade(r.overlay - current, price);
      current = r.overlay;
    }
    book.mark(price, current);
  });
  return { current, orders, flips, pnl: book.pnl, state };
}
const line = (from, to, n) => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);

// A clean trend up (+0.6 % in 5 min): long a full leg once the price is out of the band, and the
// overlay gains while the short leg loses.
let r = run([ENTRY, ...line(ENTRY, ENTRY * 1.006, 150)]);
assert.ok(Math.abs(r.current - Math.round(LEG * 1e5) / 1e5) < 1e-9, `current ${r.current}`);
assert.ok(r.orders <= 3, `orders ${r.orders}`);
assert.ok(r.pnl > 0.5 * LEG * ENTRY * 0.004, `pnl ${r.pnl}`);

// Back and forth around the entry, inside or well beyond the band: no trend, no order, no churn.
r = run(Array.from({ length: 150 }, (_, i) => ENTRY + (i % 2 ? 30 : -30)));
assert.strictEqual(r.orders, 0);
r = run(Array.from({ length: 150 }, (_, i) => ENTRY + (i % 2 ? 120 : -120)));
assert.strictEqual(r.orders, 0);

// Up, then down through the entry: one turn at most, ending short with the trend.
r = run([ENTRY, ...line(ENTRY, ENTRY * 1.004, 100), ...line(ENTRY * 1.004, ENTRY * 0.996, 200)]);
assert.ok(r.current < 0, `current ${r.current}`);
assert.ok(r.flips <= 1, `flips ${r.flips}`);

// A turn right after taking a side is held for MIN_HOLD_MS.
const t = tracker();
for (let i = 0; i <= 30; i++) t.addPrice(ENTRY - i * 8, i * 2000);
const held = target({ pair, price: ENTRY - 240, now: 60000, vol: CALM, trend: t.trend(120000, 60000), closeMove, capBtc: 1, current: 0.05, state: { side: 1, since: 60000 - MIN_HOLD_MS / 2 } });
assert.strictEqual(held.state.side, 1);
assert.strictEqual(held.overlay, 0); // the trend is against the side held: nothing held meanwhile
const turned = target({ pair, price: ENTRY - 240, now: 60000, vol: CALM, trend: t.trend(120000, 60000), closeMove, capBtc: 1, current: 0.05, state: { side: 1, since: 0 } });
assert.strictEqual(turned.state.side, -1);
assert.ok(turned.overlay < 0);

// Capped by what the Lighter collateral may carry on its own.
r = run([ENTRY, ...line(ENTRY, ENTRY * 1.006, 150)], { capBtc: 0.02 });
assert.strictEqual(r.current, 0.02);
// No pair, no overlay.
assert.strictEqual(target({ pair: null, price: ENTRY, now: 0, vol: CALM, trend: { er: 1, net: 0.01 }, closeMove, capBtc: 1, current: 0.05 }).overlay, 0);

// The ledger: mark to market of the overlay, less an estimated spread on each trade.
const book = ledger();
book.trade(0.05, 80000);
book.mark(80000, 0.05);
book.mark(80400, 0.05);
book.trade(-0.05, 80400);
book.mark(80400, 0);
assert.ok(Math.abs(book.pnl - (0.05 * 400 - 0.05 * 80000 * 1e-4 - 0.05 * 80400 * 1e-4)) < 1e-9, `${book.pnl}`);

console.log('scalp: ok (tendance suivie avec une jambe entière, aucun ordre en zigzag, un seul retournement, détention minimale, plafond de collatéral)');
