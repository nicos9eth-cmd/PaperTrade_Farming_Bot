'use strict';

// Lighter reactive cover: while a Papertrade pair is open, the bot holds on Lighter the side that
// offsets the losing leg (long above the pair's entry, short below), and turns as soon as the price
// crosses the entry again, at most once every MIN_HOLD_MS. Lighter charges no fee: each turn costs
// only the spread and the price drift during the reaction, so the reaction is fed by a live price.

const assert = require('assert');
const { cover, ledger, MIN_HOLD_MS } = require('../lib/scalp');

const ENTRY = 80000;
const legOf = (isLong) => ({ id: isLong ? 'L' : 'S', isLong, entry: ENTRY, notional: 20.36 * 61 });
const pair = { long: legOf(true), short: legOf(false) };
const LEG = (20.36 * 61) / ENTRY; // one leg in BTC, about 0.0155
const CAP = 0.00141; // 10x a $11.57 Lighter account

// Runs the cover along a price path, one price every `every` ms, as the bot's live feed does.
function run(path, { every = 200, capBtc = CAP, current = 0 } = {}) {
  const book = ledger();
  let state;
  let held = current;
  let orders = 0;
  path.forEach((price, i) => {
    const now = i * every;
    const r = cover({ pair, price, now, capBtc, current: held, state });
    state = r.state;
    if (r.overlay !== held) {
      orders++;
      book.trade(r.overlay - held, price);
      held = r.overlay;
    }
    book.mark(price, held);
  });
  return { held, orders, pnl: book.pnl, state };
}
const line = (from, to, n) => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);

assert.ok(MIN_HOLD_MS >= 1000 && MIN_HOLD_MS <= 5000);

// Below the entry the long leg loses: short on Lighter, the whole cap. Above: long.
let r = run([ENTRY, ENTRY - 5]);
assert.strictEqual(r.held, -CAP);
r = run([ENTRY + 5]);
assert.strictEqual(r.held, CAP);
// At the entry exactly, nothing taken yet.
assert.strictEqual(run([ENTRY]).held, 0);

// It turns as soon as the price crosses the entry, but not twice within MIN_HOLD_MS.
const hold = MIN_HOLD_MS / 200;
r = run([ENTRY - 5, ENTRY + 5]);
assert.strictEqual(r.held, -CAP); // 200 ms after taking the short: kept
r = run([ENTRY - 5, ...Array(hold).fill(ENTRY + 5)]);
assert.strictEqual(r.held, CAP); // once MIN_HOLD_MS passed: long
// A fast back-and-forth around the entry: at most one turn per MIN_HOLD_MS.
r = run(Array.from({ length: 300 }, (_, i) => ENTRY + (i % 2 ? 3 : -3)));
assert.ok(r.orders <= 1 + Math.ceil((300 * 200) / MIN_HOLD_MS), `orders ${r.orders}`);

// The size is set when a side is taken and kept until the next turn, whatever the collateral does
// meanwhile: no order for a change of a few cents of equity.
let s = cover({ pair, price: ENTRY - 5, now: 0, capBtc: CAP, current: 0 });
s = cover({ pair, price: ENTRY - 50, now: 1000, capBtc: CAP * 1.3, current: s.overlay, state: s.state });
assert.strictEqual(s.overlay, -CAP);
s = cover({ pair, price: ENTRY + 50, now: 1000 + MIN_HOLD_MS, capBtc: CAP * 1.3, current: s.overlay, state: s.state });
assert.strictEqual(s.overlay, Math.round(CAP * 1.3 * 1e5) / 1e5);

// Never more than one leg, whatever the collateral allows.
assert.ok(Math.abs(run([ENTRY + 5], { capBtc: 1 }).held - Math.round(LEG * 1e5) / 1e5) < 1e-9);
// No pair, nothing held.
assert.strictEqual(cover({ pair: null, price: ENTRY, now: 0, capBtc: CAP, current: -CAP }).overlay, 0);

// After a restart the bot's position is taken back as it is: no order while it is on the right
// side, even if the collateral changed; a turn as soon as it is on the wrong one.
s = cover({ pair, price: ENTRY - 20, now: 0, capBtc: CAP * 1.2, current: -CAP });
assert.strictEqual(s.overlay, -CAP);
s = cover({ pair, price: ENTRY + 20, now: 0, capBtc: CAP, current: -CAP });
assert.strictEqual(s.overlay, CAP);

// A clean move away from the entry: one order, and the cover gains what the losing leg loses
// (relative to its own size), less the spread.
r = run([ENTRY, ...line(ENTRY, ENTRY * 0.99, 500)]);
assert.strictEqual(r.orders, 1);
assert.ok(r.pnl > CAP * ENTRY * 0.0098, `pnl ${r.pnl}`);

// The ledger: mark to market of the cover, less an estimated spread on each trade.
const book = ledger();
book.trade(0.05, 80000);
book.mark(80000, 0.05);
book.mark(80400, 0.05);
book.trade(-0.05, 80400);
book.mark(80400, 0);
assert.ok(Math.abs(book.pnl - (0.05 * 400 - 0.05 * 80000 * 0.35e-4 - 0.05 * 80400 * 0.35e-4)) < 1e-9, `${book.pnl}`);

console.log('scalp: ok (couverture de la jambe perdante, retournement au prix d\'entrée au plus toutes les 2 s, taille fixée au retournement, reprise après redémarrage)');
