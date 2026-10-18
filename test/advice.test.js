'use strict';

const assert = require('assert');
const { advise } = require('../lib/advice');
const { DEFAULTS } = require('../lib/config');

// Papertrade's parameters on 2026-10-15.
const market = { maxLeverage: 1000, maxNotional: 1e7, liquidationBuffer: 0.000476, rateMultiplier: 15000, positionMultiplier: 814.598, baseRate: 0.1, referenceNotional: 1e5 };
const mkts = { minMargin: 10, minNotional: 1000 };
const proto = { queueEmpty: true, window: false, paper: { flatRate: 100, decayScale: 120000000, tailProgress: 184410275, threshold: 2e6, trackedLp: 4.86e6, lp: 4.86e6 } };
const run = (balance, lighterEquity) => advise({ balance, mkts, market, proto, config: DEFAULTS, defaults: DEFAULTS, lighterEquity });

// $36.65, no Lighter: prudent is Papertrade's floor (x56, $1000 minimum position) instead of x82;
// the bot will wait when closes take more than about 17 minutes in a calm market.
let a = run(36.65, null);
assert.strictEqual(a.pick, 'prudent');
assert.strictEqual(a.chosen.leverage, 56);
assert.strictEqual(a.normal.leverage, 82);
assert.strictEqual(a.cover, null);
assert.ok(a.waitAfter > 900 && a.waitAfter < 1200, `waitAfter ${a.waitAfter}`);

// Same with $16.80 on Lighter: about 74 % of a leg covered, $6 missing for all of it.
a = run(36.65, 16.8);
assert.ok(a.cover.share > 0.7 && a.cover.share < 0.8, `share ${a.cover.share}`);
assert.strictEqual(a.cover.missingUsd, 6);
assert.ok(Number.isFinite(a.waitAfter));

// $200 with $100 on Lighter: prudent (x42) is fully covered, so the bot never waits for slow closes.
a = run(200, 100);
assert.strictEqual(a.pick, 'prudent');
assert.strictEqual(a.cover.share, 1);
assert.strictEqual(a.waitAfter, Infinity);

// $200 with $200 on Lighter: even the normal leverage's leg is covered, so normal is kept.
a = run(200, 200);
assert.strictEqual(a.pick, 'normal');
assert.strictEqual(a.cover.share, 1);

// The PAPER price ceiling leaves room for the falling mint rate, and the budget is ~10 cycles.
assert.ok(a.maxCostPerPaper > a.chosen.late.costPerPaper * 1.4);
assert.ok(Math.abs(a.budget - a.chosen.late.cost * 10) < 1.01);

// What the window (pool under 2 M, 100 PAPER/$) would do with this balance in a calm market:
// short rotations at a higher leverage, with the loss in $ at which each one closes.
a = run(100, null);
assert.ok(a.window && !a.window.reason, JSON.stringify(a.window));
assert.ok(a.window.leverage > a.normal.leverage);
assert.ok(a.window.lossUsd > 0 && a.window.outcome.costPerPaper <= DEFAULTS.burstMaxCostPerPaper);
assert.ok(a.window.perHour > 0 && a.window.cycleSeconds >= 20);
assert.ok(!run(36.65, null).window.reason);

console.log('advice: ok (36 $ : x56 prudent ; + Lighter : couverture 74 %, 6 $ manquants ; 200 $ + Lighter : couvert, sans attente)');
