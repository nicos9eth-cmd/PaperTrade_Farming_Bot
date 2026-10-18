'use strict';

// Short rotations while the pool is under the cliff (every dollar lost mints 100 PAPER).

const assert = require('assert');
const { optimize, bestClose, closeNowWorth, simulatedWindow } = require('../lib/burst');
const { pairStatus } = require('../lib/pairs');
const { DEFAULTS } = require('../lib/config');

// Papertrade's parameters on 2026-10-18.
const market = { id: 1, coin: 'BTC', maxLeverage: 1000, maxNotional: 1e7, liquidationBuffer: 0.000476, rateMultiplier: 15000, positionMultiplier: 814.598, baseRate: 0.1, referenceNotional: 1e5 };
const mkts = { minMargin: 10, minNotional: 1000 };
const tail = { flatRate: 100, decayScale: 120e6, tailProgress: 228.4e6, threshold: 2e6, trackedLp: 4.86e6 };
const inWindow = { queueEmpty: true, window: true, paper: { ...tail, lp: 1.5e6 } };
const outside = { queueEmpty: true, window: false, paper: { ...tail, lp: 4.86e6 } };
const CALM = 0.02 / Math.sqrt(86400); // 2 % a day, per square-root second
const config = DEFAULTS;
const run = (over) => optimize({ available: 100, mkts, market, proto: inWindow, config, vol: CALM, overhead: 15, minBust: 0.0012, ...over });

// $100 in a calm market: the highest leverage the close delay allows (x596 for 0.12 % of room),
// a close far before the usual 85 %, within the window's cost ceiling, and at least 20 s a cycle.
let b = run();
assert.ok(!b.reason, b.reason);
assert.strictEqual(b.leverage, 596);
assert.ok(b.closeAt < 0.85 && b.closeAt >= 0.05, `closeAt ${b.closeAt}`);
assert.ok(b.outcome.costPerPaper <= config.burstMaxCostPerPaper, `cost ${b.outcome.costPerPaper}`);
assert.ok(b.cycleSeconds >= 20);
assert.ok(Math.abs(b.lossUsd - b.notional * b.move) < 1e-9);
assert.ok(Math.abs(b.move - b.closeAt * b.bustMove) < 1e-12);
// Each cycle mints the loss at 100 PAPER/$ (98 % basis).
assert.ok(Math.abs(b.outcome.minted - b.lossUsd * 0.98 * 100) < 1e-6);
// It beats the usual rotation (x81, close at 85 %) in PAPER per hour.
const usual = bestClose({ notional: 49.5 * 81, bustMove: 1 / 81 - 0.000476, market, proto: inWindow, config: { ...config, burstMaxCostPerPaper: 1 }, vol: CALM, overhead: 15, only: 0.85 });
assert.ok(b.perHour > 3 * usual.perHour, `${b.perHour} vs ${usual.perHour}`);

// More capital, proportionally bigger loss per cycle at the same leverage.
const big = run({ available: 1000 });
assert.strictEqual(big.leverage, b.leverage);
assert.ok(Math.abs(big.lossUsd / b.lossUsd - 10) < 0.01, `${big.lossUsd} / ${b.lossUsd}`);
// $25: x81 is the smallest position Papertrade takes, the room needed allows up to x596.
assert.ok(!run({ available: 25 }).reason);

// Slow closes: the leverage comes down to keep room for them, and a night like 2026-10-15
// (2.16 % of room needed) leaves $25 nothing to open.
assert.strictEqual(run({ minBust: 0.0216 }).leverage, 45);
assert.ok(/clôtures trop lentes/.test(run({ available: 25, minBust: 0.0216 }).reason));

// Quick orders: shorter rotations. Slow ones: longer.
assert.ok(run({ overhead: 5 }).closeAt <= run({ overhead: 60 }).closeAt);
// A tighter cost ceiling asks for bigger moves.
const strict = run({ config: { ...config, burstMaxCostPerPaper: 0.0018 } });
assert.ok(strict.move > b.move, `${strict.move} vs ${b.move}`);
assert.ok(strict.outcome.costPerPaper <= 0.0018);
assert.ok(/coût/.test(run({ config: { ...config, burstMaxCostPerPaper: 0.0005 } }).reason));
// Outside the window the same ceiling cannot be met (11.86 PAPER/$).
assert.ok(/coût/.test(run({ proto: outside }).reason));
// Never below Papertrade's minimum margin.
assert.ok(/capital insuffisant/.test(run({ available: 15 }).reason));

// The pair open when the window starts (x81, opened before): closed as soon as closing it now at
// 100 PAPER/$ mints as much as its usual close at 85 % would at the tail rate (about 10 % of the way).
const leg = (isLong) => {
  const dist = 1 / 81 - 0.000476;
  return { id: isLong ? 'L' : 'S', market, isLong, entry: 80000, margin: 49.5, leverage: 81, notional: 49.5 * 81, bust: 80000 * (isLong ? 1 - dist : 1 + dist) };
};
const pair = { long: leg(true), short: leg(false) };
const at = (progress) => 80000 * (1 - progress * (1 / 81 - 0.000476));
const worth = (progress, proto = inWindow, cfg = config) => closeNowWorth({ status: pairStatus(pair, at(progress), proto), proto, config: cfg, normalCloseAt: 0.85 });
assert.strictEqual(worth(0.05), false);
assert.strictEqual(worth(0.12), true);
assert.strictEqual(worth(0.5), true);
// Never outside the window, and never above the cost ceiling.
assert.strictEqual(worth(0.5, outside), false);
assert.strictEqual(worth(0.12, inWindow, { ...config, burstMaxCostPerPaper: 0.0001 }), false);

// The open pair's own best close point in the window, for its leverage.
const own = bestClose({ notional: pair.long.notional, bustMove: 1 / 81 - 0.000476, market, proto: inWindow, config, vol: CALM, overhead: 15 });
assert.ok(own.closeAt > 0 && own.closeAt < 0.85, `own ${own.closeAt}`);
assert.strictEqual(bestClose({ notional: pair.long.notional, bustMove: 1 / 81 - 0.000476, market, proto: outside, config, vol: CALM, overhead: 15 }), null);

// bot-simulation with --simuler-fenetre: the real summary, with the pool put under the cliff.
const sim = simulatedWindow(outside);
assert.strictEqual(sim.window, true);
assert.strictEqual(sim.paper.lp, 1.5e6);
assert.strictEqual(sim.paper.tailProgress, tail.tailProgress);
assert.strictEqual(outside.paper.lp, 4.86e6);

console.log(`burst: ok (100 $ calme : x${b.leverage}, clôture à ${(b.closeAt * 100).toFixed(0)} % soit ${b.lossUsd.toFixed(2)} $ de perte, ~${Math.round(b.cycleSeconds)} s par cycle, $${b.outcome.costPerPaper.toFixed(4)}/PAPER ; paire x81 encaissée dès ~10 % du chemin)`);
