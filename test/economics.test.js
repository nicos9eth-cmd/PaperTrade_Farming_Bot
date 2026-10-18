'use strict';

const assert = require('assert');
const { winKeep, mintRate, minted, pairOutcome } = require('../lib/economics');
const { parseProtocol } = require('../lib/api');

const BTC = { baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 814.598, referenceNotional: 100000 };
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

// Doc: on BTC, counting the deadband, a 1% move keeps ~88% of the raw gain and a 0.1% move ~74% (before the 2% win fee).
near(winKeep(0.01, BTC) / 0.98, 0.88, 0.005);
near(winKeep(0.001, BTC) / 0.98, 0.74, 0.005);
assert.strictEqual(winKeep(0.00001, BTC), 0);

// Doc: flat 100 below the threshold, ~30 PAPER/$ at a $100M high-water mark.
assert.strictEqual(mintRate({ flatRate: 100, decayScale: 120e6, tailProgress: 0 }), 100);
near(mintRate({ flatRate: 100, decayScale: 120e6, tailProgress: 100e6 }), 29.75, 0.05);

// The site's reward curve (RewardCurve U(lp)), on the protocol summary of 2026-10-18: LP 4.86 M,
// cliff 2 M, tail progress 228.4 M. Above the cliff the tail rate applies (11.86 PAPER/$); below
// it the flat rate, 100 PAPER/$, whatever the tail progress.
const proto = parseProtocol(require('./fixtures/protocol-2026-10-18.json'));
const live = proto.paper;
near(live.lp, 4860197.26, 0.01);
assert.strictEqual(live.threshold, 2e6);
assert.strictEqual(proto.window, false);
near(mintRate(live), 11.86, 0.01);
assert.strictEqual(mintRate({ ...live, lp: 1.99e6 }), 100);
// At the cliff exactly, and anywhere between it and the tracked high-water mark: the tail rate.
near(mintRate({ ...live, lp: 2e6 }), mintRate(live), 1e-9);
near(mintRate({ ...live, lp: 3e6 }), mintRate(live), 1e-9);
// Beyond the high-water mark the curve keeps decaying.
assert.ok(mintRate({ ...live, lp: live.trackedLp + 10e6 }) < mintRate(live));
// The window as the summary reports it: LP + reserve - payout queue under the cliff.
const low = JSON.parse(JSON.stringify(require('./fixtures/protocol-2026-10-18.json')));
low.balances.lp = (1500000n * 10n ** 18n).toString();
low.balances.queue = (100n * 10n ** 18n).toString();
const lowProto = parseProtocol(low);
assert.strictEqual(lowProto.window, true);
assert.strictEqual(lowProto.queueEmpty, false);
near(lowProto.paper.lp, 1499900, 1e-6);
assert.strictEqual(mintRate(lowProto.paper), 100);

// What a loss mints: the part that keeps the LP under the cliff at the flat rate, the rest at
// the tail rate (a loss is paid into the LP).
const edge = { ...live, lp: 2e6 - 30 };
near(minted(100, edge), 30 * 100 + 70 * mintRate(live), 1e-6);
near(minted(100, { ...live, lp: 1e6 }), 100 * 100, 1e-9);
near(minted(100, live), 100 * mintRate(live), 1e-9);
assert.strictEqual(minted(0, edge), 0);

const o = pairOutcome({ notional: 1000, move: 0.01, market: BTC, paper: { flatRate: 100, decayScale: 120e6, tailProgress: 0 }, queueEmpty: true });
near(o.loss, 10, 1e-9);
near(o.minted, 980, 1e-6);
near(o.cost, 1.36, 0.02);

console.log('economics: ok');
