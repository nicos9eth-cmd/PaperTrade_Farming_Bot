'use strict';

const assert = require('assert');
const { sizePair } = require('../lib/sizing');

// Papertrade's limits on 2026-10-15: $10 minimum margin, $1000 minimum position.
const market = { maxLeverage: 1000, liquidationBuffer: 0.00048, maxNotional: 0 };
const mkts = { minMargin: 10, minNotional: 1000 };
const config = { targetMove: 0.01352, closeAt: 0.85, reserve: 0.01, maxMarginPerLeg: null };
const NIGHT = 0.0216; // room needed with the 1568 s relayer backlog of the night of 2026-10-15

// $25: $12.37 a leg, so x81 is the lowest leverage reaching $1000, whatever targetMove asks (x61).
let s = sizePair(25, mkts, market, config);
assert.strictEqual(s.leverage, 81);
assert.ok(!s.tooSlow);
// ...and on a night like that one it can only wait.
assert.ok(sizePair(25, mkts, market, config, NIGHT).tooSlow);

// $37.30 ($18.46 a leg, minimum x55): x61 normally, lowered to x55 under moderate congestion.
assert.strictEqual(sizePair(37.3, mkts, market, config).leverage, 61);
s = sizePair(37.3, mkts, market, config, 0.0175);
assert.strictEqual(s.leverage, 55);
assert.strictEqual(s.usual, 61);
assert.ok(!s.tooSlow);
assert.ok(sizePair(37.3, mkts, market, config, NIGHT).tooSlow);

// $100 ($49.50 a leg, minimum x21): that night's delay is absorbed by opening at x45.
s = sizePair(100, mkts, market, config, NIGHT);
assert.strictEqual(s.leverage, 45);
assert.ok(s.bustMove >= NIGHT, `bustMove ${s.bustMove}`);
assert.ok(!s.tooSlow);

// A small requirement changes nothing.
assert.strictEqual(sizePair(37.3, mkts, market, config, 0.004).leverage, 61);

console.log('sizing: ok (25 $ : x81 ou attente ; 37 $ : x61, x55 si congestion ; 100 $ : x45 la nuit du 15/10)');
