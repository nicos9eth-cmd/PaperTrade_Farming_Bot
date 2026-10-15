'use strict';

const assert = require('assert');
const { tracker } = require('../lib/risk');

const config = { closeAt: 0.85, minCloseAt: 0.5, riskSigmas: 4, baseDelaySeconds: 5 };
const BUST = 0.0114;

// Feeds one price every 2 s, each step moving by `step` (relative), alternating direction.
function feed(t, step) {
  let p = 80000;
  for (let i = 0; i < 150; i++) {
    p *= 1 + (i % 2 ? step : -step);
    t.addPrice(p, i * 2000);
  }
  return 300000;
}

// Calm market: the static threshold applies.
let t = tracker();
let now = feed(t, 0.00005);
assert.strictEqual(t.assess(BUST, config, now).closeAt, 0.85);

// One stale account snapshot among fresh ones changes nothing.
for (const lag of [2, 2, 700, 2, 2]) t.addLag(lag);
assert.strictEqual(t.assess(BUST, config, now).closeAt, 0.85);

// Volatile market: closes earlier, but not below the floor.
t = tracker();
now = feed(t, 0.0006);
const volatile = t.assess(BUST, config, now).closeAt;
assert.ok(volatile < 0.85 && volatile >= 0.5, `volatile ${volatile}`);

// Same volatility plus slow orders and a lagging account state: earlier still.
t.addLatency(30000);
for (let i = 0; i < 5; i++) t.addLag(10);
const congested = t.assess(BUST, config, now).closeAt;
assert.ok(congested < volatile, `congested ${congested} vs ${volatile}`);

// A relayer backlog alone (calm market) also advances the threshold.
t = tracker();
now = feed(t, 0.0002);
const idle = t.assess(BUST, config, now).closeAt;
t.setQueueDelay(120);
assert.ok(t.assess(BUST, config, now).closeAt < idle, 'queue delay should advance the threshold');

// Extreme case is clamped to the floor.
t = tracker();
now = feed(t, 0.01);
assert.strictEqual(t.assess(BUST, config, now).closeAt, 0.5);

// Distance to liquidation a new pair needs. Calm market, quick orders: about 0.1 %, no constraint at x60-x80.
t = tracker();
now = feed(t, 0.00005);
const calmBust = t.minBustMove(config, now);
assert.ok(calmBust > 0.0005 && calmBust < 0.004, `calm minBust ${calmBust}`);
// The night of 2026-10-15: 1568 s of relayer backlog. About 2.2 % is needed, i.e. x45 at most.
t.setQueueDelay(1568);
const nightBust = t.minBustMove(config, now);
assert.ok(nightBust > 0.02 && nightBust < 0.024, `night minBust ${nightBust}`);

console.log(`risk: ok (calme 0.85, volatil ${volatile.toFixed(2)}, congestionné ${congested.toFixed(2)} ; distance minimale à l'ouverture : calme ${(calmBust * 100).toFixed(2)} %, nuit du 15/10 ${(nightBust * 100).toFixed(2)} %)`);
