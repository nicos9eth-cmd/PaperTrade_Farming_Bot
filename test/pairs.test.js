'use strict';

const assert = require('assert');
const { buildPairs, pairStatus } = require('../lib/pairs');

const BTC = { id: 1, coin: 'BTC', baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 814.598, referenceNotional: 100000 };
const ETH = { ...BTC, id: 2, coin: 'ETH' };
const proto = { queueEmpty: true, paper: { flatRate: 100, decayScale: 120e6, tailProgress: 0 } };
const leg = (id, isLong, entry, leverage, margin = 20, market = BTC) => {
  const dist = 1 / leverage - 0.000476;
  return { id, market, isLong, entry, margin, leverage, notional: margin * leverage, bust: entry * (isLong ? 1 - dist : 1 + dist) };
};
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

// Opposite legs of the same market and size make a pair, whatever their order.
let r = buildPairs([leg('S', false, 80000, 61), leg('L', true, 80000, 61)]);
assert.strictEqual(r.pairs.length, 1);
assert.strictEqual(r.pairs[0].long.id, 'L');
assert.strictEqual(r.pairs[0].short.id, 'S');
assert.strictEqual(r.single.length, 0);

// Same side, another market, or a size more than 1 % apart: no pair.
assert.strictEqual(buildPairs([leg('a', true, 80000, 61), leg('b', true, 80000, 61)]).pairs.length, 0);
assert.strictEqual(buildPairs([leg('a', true, 80000, 61), leg('b', false, 3000, 61, 20, ETH)]).pairs.length, 0);
r = buildPairs([leg('a', true, 80000, 61, 20), leg('b', false, 80000, 61, 20.3)]);
assert.strictEqual(r.pairs.length, 0);
assert.strictEqual(r.single.length, 2);
// Within 1 %: still a pair (fills at slightly different margins).
assert.strictEqual(buildPairs([leg('a', true, 80000, 61, 20), leg('b', false, 80000, 61, 20.1)]).pairs.length, 1);

// Three legs: one pair and one lone leg.
r = buildPairs([leg('L1', true, 80000, 61), leg('S1', false, 80000, 61), leg('L2', true, 80000, 61)]);
assert.strictEqual(r.pairs.length, 1);
assert.deepStrictEqual(r.single.map((p) => p.id), ['L2']);

// Status: price down 0.5 % at x61, the long is the losing leg, about 39 % of its way to bust.
const pair = { long: leg('L', true, 80000, 61), short: leg('S', false, 80000, 61) };
let s = pairStatus(pair, 79600, proto);
assert.strictEqual(s.loser.id, 'L');
near(s.move, 0.005, 1e-9);
near(s.bustMove, 1 / 61 - 0.000476, 1e-9);
near(s.progress, 0.005 / (1 / 61 - 0.000476), 1e-9);
near(s.now.loss, 20 * 61 * 0.005, 1e-9);
assert.ok(s.at(0.85).minted > s.now.minted);
// At entry nothing is lost.
s = pairStatus(pair, 80000, proto);
assert.strictEqual(s.move, 0);
assert.strictEqual(s.now.minted, 0);

// Legs filled at different prices: each is measured from its own entry, so the worse one counts.
const skewed = { long: leg('L', true, 80100, 61), short: leg('S', false, 80000, 61) };
s = pairStatus(skewed, 80020, proto);
assert.strictEqual(s.loser.id, 'L');
near(s.move, 80 / 80100, 1e-12);

console.log('pairs: ok (appariement à 1 % près, jambe perdante mesurée depuis sa propre entrée)');
