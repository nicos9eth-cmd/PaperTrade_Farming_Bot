'use strict';

const assert = require('assert');
const { bustTracker, exposure, plan } = require('../lib/hedge');

// The night of 2026-10-15: pair opened at 81938.5, x61, $18.43 a leg.
const ENTRY = 81938.5;
const long = { id: 'L', isLong: true, entry: ENTRY, notional: 18.43 * 61, bust: 80634.6 };
const short = { id: 'S', isLong: false, entry: ENTRY, notional: 18.43 * 61, bust: 83242.4 };
const leg = Math.round(((18.43 * 61) / ENTRY) * 1e5) / 1e5; // one leg in BTC, 0.01372
const MANUAL = -0.0044; // the owner's own Lighter short
const opts = { capacity: 1, minTrade: 10 };
const near = (a, b) => Math.abs(a - b) < 1e-5;

// Nothing to hedge (no Papertrade position, or a complete pair): the owner's short is left alone.
let p = plan({ positions: [], busted: bustTracker(), current: MANUAL, own: 0, price: 81000, ...opts });
assert.strictEqual(p.order, 0);
let t = bustTracker();
t.update([long, short], 81500);
p = plan({ positions: [long, short], busted: t, current: MANUAL, own: 0, price: 81500, ...opts });
assert.strictEqual(p.order, 0);

// 04:24, the price crosses the long's bust while the close sits in the relayer queue: the long
// counts as liquidated at once, the short is hedged by buying one leg on Lighter. The buy nets
// against the owner's short, which is still there underneath.
t.update([long, short], 80600);
assert.ok(t.has('L'));
p = plan({ positions: [long, short], busted: t, current: MANUAL, own: 0, price: 80600, ...opts });
assert.ok(near(p.order, leg) && near(p.hedge, leg) && near(p.baseline, MANUAL), JSON.stringify(p));
const hedged = p.target;

// 04:36, price back at 81200: the long stays counted as gone (liquidation is a hard bust).
t.update([long, short], 81200);
p = plan({ positions: [long, short], busted: t, current: hedged, own: leg, price: 81200, ...opts });
assert.strictEqual(p.order, 0);

// 04:50, the short's close lands: the bot unwinds its own hedge only, the owner's short is back.
t.update([], 81210);
p = plan({ positions: [], busted: t, current: hedged, own: leg, price: 81210, ...opts });
assert.ok(near(p.order, -leg) && near(p.target, MANUAL), JSON.stringify(p));

// The other way round (a long left alone: the hedge is a sale, like the owner's short) with too
// little margin for both: the hedge comes first, the owner's short is cut to make room.
p = plan({ positions: [long], busted: bustTracker(), current: MANUAL, own: 0, price: 81000, capacity: 0.0093, minTrade: 10 });
assert.ok(near(p.hedge, -0.0093) && p.baseline === 0 && p.partial, JSON.stringify(p));
assert.ok(near(p.order, -0.0049));
// With enough margin for both, the owner's short is kept whole.
p = plan({ positions: [long], busted: bustTracker(), current: MANUAL, own: 0, price: 81000, ...opts });
assert.ok(near(p.hedge, -leg) && near(p.baseline, MANUAL) && !p.partial);

// No owner position: a lone leg is hedged, then unwound; a crossed bust not followed by a
// liquidation is trusted again after 5 minutes once the price is back.
p = plan({ positions: [short], busted: bustTracker(), current: 0, own: 0, price: 81500, ...opts });
assert.ok(near(p.order, leg) && !p.reduceOnly);
p = plan({ positions: [], busted: bustTracker(), current: leg, own: leg, price: 81500, ...opts });
assert.ok(near(p.order, -leg) && p.reduceOnly);
t = bustTracker();
t.update([long], 80600, 0);
t.update([long], 81500, 200000);
assert.ok(t.has('L'));
t.update([long], 81500, 400000);
assert.ok(!t.has('L'));

// Legs filled at slightly different prices: the tiny difference is below Lighter's minimum.
const shortLater = { ...short, entry: ENTRY + 20 };
p = plan({ positions: [long, shortLater], busted: bustTracker(), current: 0, own: 0, price: 81900, ...opts });
assert.strictEqual(p.order, 0);
assert.ok(Math.abs(exposure([long, shortLater], bustTracker())) * 81900 < 1);

console.log('hedge: ok (ton short intact sans couverture, jambe liquidée couverte puis débouclée, short réduit seulement si la marge manque)');
