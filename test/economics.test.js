'use strict';

const assert = require('assert');
const { winKeep, mintRate, pairOutcome } = require('../lib/economics');

const BTC = { baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 814.598, referenceNotional: 100000 };
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

// Doc: on BTC, counting the deadband, a 1% move keeps ~88% of the raw gain and a 0.1% move ~74% (before the 2% win fee).
near(winKeep(0.01, BTC) / 0.98, 0.88, 0.005);
near(winKeep(0.001, BTC) / 0.98, 0.74, 0.005);
assert.strictEqual(winKeep(0.00001, BTC), 0);

// Doc: flat 100 below the threshold, ~30 PAPER/$ at a $100M high-water mark.
assert.strictEqual(mintRate({ flatRate: 100, decayScale: 120e6, tailProgress: 0 }), 100);
near(mintRate({ flatRate: 100, decayScale: 120e6, tailProgress: 100e6 }), 29.75, 0.05);

const o = pairOutcome({ notional: 1000, move: 0.01, market: BTC, paper: { flatRate: 100, decayScale: 120e6, tailProgress: 0 }, queueEmpty: true });
near(o.loss, 10, 1e-9);
near(o.minted, 980, 1e-6);
near(o.cost, 1.36, 0.02);

console.log('economics: ok');
