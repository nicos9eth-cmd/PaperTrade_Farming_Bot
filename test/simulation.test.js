'use strict';

// The simulated back ends (bot-simulation.bat): Papertrade and Lighter accounts at live prices.

const assert = require('assert');
const exchange = require('../lib/exchange');
const lighter = require('../lib/lighter');
const { winKeep, mintRate } = require('../lib/economics');

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const BTC = { id: 1, coin: 'BTC', liquidationBuffer: 0.000476, baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 814.598, referenceNotional: 100000 };
const paper = { flatRate: 100, decayScale: 120e6, tailProgress: 0 };

(async () => {
  // A pair closed after a 0.5 % rise: the short's loss mints at 98 % (win fee taken off the basis
  // while the payout queue is empty), the long keeps winKeep of its raw gain.
  let proto = { queueEmpty: true, paper };
  let ex = exchange.simulated({}, {}, 100, () => proto);
  ex.onPrice(80000);
  await ex.open(BTC, true, 20, 61);
  await ex.open(BTC, false, 20, 61);
  let s = await ex.state();
  assert.strictEqual(s.positions.length, 2);
  near(s.available, 60, 1e-9);
  near(s.locked, 40, 1e-9);
  ex.onPrice(80400);
  await ex.close(s.positions.map((p) => p.id));
  s = await ex.state();
  const loss = 20 * 61 * 0.005;
  near(s.realized, -loss + loss * winKeep(0.005, BTC), 1e-9);
  near(s.paper, loss * 0.98 * 100, 1e-6);
  near(s.available, 100 + s.realized, 1e-9);
  assert.strictEqual(s.positions.length, 0);

  // A liquidated leg loses its whole margin and mints on all of it.
  ex = exchange.simulated({}, {}, 100, () => proto);
  ex.onPrice(80000);
  await ex.open(BTC, true, 20, 61);
  const bust = (await ex.state()).positions[0].bust;
  ex.onPrice(bust - 1);
  s = await ex.state();
  assert.strictEqual(s.positions.length, 0);
  near(s.realized, -20, 1e-9);
  near(s.paper, 20 * 100, 1e-6);

  // Payout queue active: the mint basis is the whole loss.
  proto = { queueEmpty: false, paper };
  ex = exchange.simulated({}, {}, 100, () => proto);
  ex.onPrice(80000);
  await ex.open(BTC, false, 20, 61);
  ex.onPrice(80400);
  await ex.close((await ex.state()).positions.map((p) => p.id));
  near((await ex.state()).paper, loss * 100, 1e-6);

  // The pool under the cliff: the loss mints at 100 PAPER/$ even late in the tail; a loss that lifts
  // the pool back over the cliff earns the flat rate on the part below it only.
  const tail = { flatRate: 100, decayScale: 120e6, tailProgress: 228.4e6, threshold: 2e6, trackedLp: 4.86e6 };
  proto = { queueEmpty: true, paper: { ...tail, lp: 1e6 } };
  ex = exchange.simulated({}, {}, 100, () => proto);
  ex.onPrice(80000);
  await ex.open(BTC, false, 20, 61);
  ex.onPrice(80400);
  await ex.close((await ex.state()).positions.map((p) => p.id));
  near((await ex.state()).paper, loss * 0.98 * 100, 1e-6);
  proto = { queueEmpty: true, paper: { ...tail, lp: 2e6 - 1 } };
  ex = exchange.simulated({}, {}, 100, () => proto);
  ex.onPrice(80000);
  await ex.open(BTC, false, 20, 61);
  ex.onPrice(80400);
  await ex.close((await ex.state()).positions.map((p) => p.id));
  near((await ex.state()).paper, 1 * 100 + (loss * 0.98 - 1) * mintRate({ ...tail, lp: 2e6 }), 1e-6);

  // Lighter: buy, add, reduce, flip. The realised part goes to the collateral, the entry is averaged on adds only.
  const lt = lighter.simulated(50);
  lt.onPrice(80000);
  await lt.trade(0.01);
  lt.onPrice(81000);
  await lt.trade(0.01);
  let l = await lt.state();
  near(l.entry, 80500, 1e-6);
  near(l.equity, 50 + 0.02 * 500, 1e-9);
  await lt.trade(-0.005); // reduce: realise 0.005 x (81000 - 80500), entry unchanged
  l = await lt.state();
  near(l.collateral, 50 + 2.5, 1e-9);
  near(l.entry, 80500, 1e-6);
  near(l.base, 0.015, 1e-9);
  lt.onPrice(80000);
  await lt.trade(-0.025); // flip to a 0.01 short at 80000
  l = await lt.state();
  near(l.base, -0.01, 1e-9);
  near(l.entry, 80000, 1e-6);
  near(l.collateral, 52.5 + 0.015 * -500, 1e-9);
  await lt.trade(0.01);
  l = await lt.state();
  assert.strictEqual(l.base, 0);
  near(l.equity, l.collateral, 1e-12);

  console.log('simulation: ok (paire, liquidation et file de paiement côté Papertrade ; achat, renfort, réduction et retournement côté Lighter)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
