'use strict';

// What the bot does when it holds nothing: stop for good, wait, or open (normal pair, or short
// rotations while the pool is under the cliff).

const assert = require('assert');
const { whenFlat, costGate } = require('../lib/gates');
const { DEFAULTS } = require('../lib/config');

const NOW = 1792291487000;
const tail = { flatRate: 100, decayScale: 120e6, tailProgress: 228.4e6, threshold: 2e6, trackedLp: 4.86e6, lp: 4.86e6 }; // 11.86 PAPER/$
const calm = { level: 'LOW', pending: 0 };
const base = { live: true, spent: 0, config: DEFAULTS, proto: { queueEmpty: true, window: false, paper: tail }, keyExpiry: NOW / 1000 + 86400 * 20, now: NOW, formatOk: true, stale: false, load: calm };
const run = (over) => whenFlat({ ...base, ...over });

assert.deepStrictEqual(run({}), { open: 'normal' });

// The budget is a stop: the owner decides to give more.
assert.ok(/budget atteint/.test(run({ spent: 25 }).stop));
assert.deepStrictEqual(run({ spent: 25, config: { ...DEFAULTS, maxNetLossUsd: null } }), { open: 'normal' });
// So is a session key about to expire (live only).
assert.ok(/clé de session/.test(run({ keyExpiry: NOW / 1000 + 3600 }).stop));
assert.deepStrictEqual(run({ live: false, keyExpiry: 0 }), { open: 'normal' });

// A mint rate under the floor is no longer a stop: the bot sleeps, and wakes up by itself when
// the pool falls under the cliff (100 PAPER/$).
const floor = { ...DEFAULTS, minMintRate: 12 };
let r = run({ config: floor });
assert.strictEqual(r.stop, undefined);
assert.ok(/^veille, taux de mint 11\.86 sous le plancher 12/.test(r.wait), r.wait);
assert.ok(/LP passe sous 2\.00 M \(actuellement 4\.86 M\)/.test(r.wait), r.wait);
const window = { queueEmpty: true, window: true, paper: { ...tail, lp: 1.9e6 } };
assert.deepStrictEqual(run({ config: floor, proto: window }), { open: 'burst' });

// Conditions that clear by themselves: wait, whatever the window.
for (const proto of [base.proto, window]) {
  assert.ok(/format des ordres/.test(run({ proto, formatOk: false }).wait));
  assert.ok(/état du compte en retard/.test(run({ proto, stale: true }).wait));
  assert.ok(/queue de paiement active/.test(run({ proto: { ...proto, queueEmpty: false } }).wait));
  assert.ok(/relayer congestionné \(312 ordres/.test(run({ proto, load: { level: 'HIGH', pending: 312 } }).wait));
}
assert.deepStrictEqual(run({ proto: { ...base.proto, queueEmpty: false }, config: { ...DEFAULTS, pauseWhenQueueActive: false } }), { open: 'normal' });
// Stops come first: a spent budget is not hidden behind a wait.
assert.ok(run({ spent: 30, stale: true }).stop);

// Expected cost per PAPER over the ceiling: sleep too, rather than stop.
assert.strictEqual(costGate({ costPerPaper: 0.011 }, DEFAULTS, base.proto), null);
r = costGate({ costPerPaper: 0.0131 }, DEFAULTS, base.proto);
assert.ok(/^veille, coût attendu \$0\.0131 par PAPER au-dessus du plafond \$0\.012/.test(r.wait), r.wait);
assert.ok(/LP passe sous 2\.00 M/.test(r.wait));
assert.strictEqual(costGate({ costPerPaper: 1 }, { ...DEFAULTS, maxCostPerPaper: null }, base.proto), null);

console.log('gates: ok (budget et clé = arrêt ; taux ou coût trop bas = veille jusqu\'à la fenêtre LP < 2 M)');
