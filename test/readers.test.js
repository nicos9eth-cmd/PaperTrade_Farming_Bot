'use strict';

// What the bot reads from Papertrade: position rows, relayer congestion, open-interest room,
// and the report of what a site update changed.

const assert = require('assert');
const { parsePosition } = require('../lib/api');
const { summarize } = require('../lib/pressure');
const { oiRoom, poolText, render } = require('../lib/dashboard');
const { compare } = require('../lib/changes');

const e18 = (x) => (BigInt(Math.round(x * 1e6)) * 10n ** 12n).toString();
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

// Position row: [id, market, isLong, ?, entry x priceScale, margin (18 dec.), leverage, bust x priceScale, openedAt].
const mkts = { byId: { 1: { id: 1, coin: 'BTC', priceScale: 10 } } };
const p = parsePosition([77, 1, true, null, 800000, e18(18.43), 61, 787000, 1792291487], mkts);
assert.strictEqual(p.id, '77');
assert.strictEqual(p.entry, 80000);
assert.strictEqual(p.bust, 78700);
near(p.margin, 18.43, 1e-9);
near(p.notional, 18.43 * 61, 1e-9);
// Unknown market: kept apart, not guessed.
assert.deepStrictEqual(parsePosition([5, 9, true, null, 1, e18(1), 2, 1, 0], mkts), { id: '5', market: null });
// A row that does not look right (bust on the wrong side, non-integer leverage) is refused.
assert.throws(() => parsePosition([77, 1, true, null, 800000, e18(18.43), 61, 810000, 0], mkts), /format de position inattendu/);
assert.throws(() => parsePosition([77, 1, false, null, 800000, e18(18.43), 61.5, 810000, 0], mkts), /format de position inattendu/);
assert.throws(() => parsePosition([77, 1, 'yes', null, 800000, e18(18.43), 61, 787000, 0], mkts), /format de position inattendu/);

// Congestion: blocks needed to clear the pending gas, with the room other users leave.
const snap = (pendingGas, pendingCount, used = 0) => ({ ts: 1000, pendingCount, blockGasLimit: '30000000', totalPendingGas: String(pendingGas), chain: { blocks: [{ gasUsed: String(used), papertradeGasUsed: '0' }] } });
assert.deepStrictEqual(summarize(snap(0, 0)), { at: 1000, pending: 0, neededBlocks: 0, clearSeconds: 0, level: 'LOW' });
let c = summarize(snap(90e6, 400));
assert.strictEqual(c.neededBlocks, 3);
assert.strictEqual(c.level, 'MEDIUM');
// Other users filling blocks leave less room: the same backlog needs more blocks.
c = summarize(snap(90e6, 400, 20e6));
assert.strictEqual(c.neededBlocks, 9);
assert.strictEqual(c.level, 'HIGH');
// Never less than 10 % of a block for the relayer.
assert.strictEqual(summarize(snap(30e6, 10, 40e6)).neededBlocks, 10);
// Unreadable: no reading rather than garbage.
assert.strictEqual(summarize({ ts: 1000, pendingCount: 1, blockGasLimit: 'x', totalPendingGas: '5' }), null);

// Open-interest room in USD on each side, and the net imbalance.
const room = oiRoom({ capLong: 100, oiLong: 90, capShort: 100, oiShort: 40 }, 80000, 5e6);
assert.deepStrictEqual(room, { long: 800000, short: 4800000, net: 4000000, maxNetOi: 5e6 });

// The pool against the cliff, on the dashboard.
const tail = { flatRate: 100, decayScale: 120e6, tailProgress: 228.4e6, threshold: 2e6, trackedLp: 4.86e6 };
assert.strictEqual(poolText({ window: false, paper: { ...tail, lp: 4.86e6 } }), 'LP 4.86 M (fenêtre 100 PAPER/$ sous 2.00 M, encore 2.86 M)');
assert.strictEqual(poolText({ window: true, paper: { ...tail, lp: 1.5e6 } }), 'FENÊTRE OUVERTE : LP 1.50 M sous 2.00 M, 100 PAPER/$ par dollar perdu');
// Old summaries without the pool figures: nothing to show.
assert.strictEqual(poolText({ paper: { flatRate: 100, decayScale: 120e6, tailProgress: 0 } }), '');

// The whole dashboard, window open and an overlay held, draws without error.
const BTCm = { id: 1, coin: 'BTC', capLong: 100, oiLong: 10, capShort: 100, oiShort: 10, liquidationBuffer: 0.000476, baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 814.598, referenceNotional: 1e5 };
const legAt = (isLong) => ({ id: isLong ? 'L' : 'S', market: BTCm, isLong, entry: 80000, margin: 49.5, leverage: 587, notional: 49.5 * 587, bust: 80000 * (isLong ? 0.9988 : 1.0012) });
const screen = render({
  live: false,
  startedAt: Date.now() - 60000,
  price: 80030,
  proto: { queueEmpty: true, window: true, paper: { ...tail, lp: 1.5e6 } },
  mkts: { maxNetOi: 5e6 },
  market: BTCm,
  state: { available: 1, locked: 99, queued: 0, paper: 1000, paperStaked: 1000, paperWallet: 0, realized: -5 },
  pairs: [{ long: legAt(true), short: legAt(false) }],
  single: [],
  config: { closeAt: 0.85, maxNetLossUsd: 25 },
  closeAt: 0.5,
  risk: { vol: 7e-5, delay: 5 },
  pressure: { level: 'LOW', pending: 3, clearSeconds: 3 },
  status: 'Surveillance de la paire',
  stopReason: null,
  lighter: { base: 0.006, own: 0.006, equity: 50, capacityUsd: 2250, liquidation: 0, scalp: { on: true, held: 0.006, share: 0.8, pnl: 0.12 } },
  events: ['un événement'],
  totals: { cycles: 1, spent: 5, paper: 1600, budgetSpent: 5 },
});
assert.ok(screen.includes('FENÊTRE OUVERTE') && screen.includes('scalp de tendance : long 0.00600 BTC') && screen.includes('force de la tendance 80 %'));

// Site update report.
const before = { texts: { 'Close position': 'trade', 'Old banner text': 'app' }, modules: { trade: 'a', app: 'b' }, params: { 'BTC levier max': 1000 } };
const after = { texts: { 'Close position': 'trade', 'New mint window': 'paper' }, modules: { trade: 'a', app: 'c', paper: 'd' }, params: { 'BTC levier max': 500 } };
const d = compare(before, after, true);
assert.deepStrictEqual([d.added, d.removed, d.changed, d.params], [1, 1, 1, 1]);
assert.ok(d.lines.includes('  + [paper] New mint window'));
assert.ok(d.lines.includes('  BTC levier max : 1000 -> 500'));
assert.ok(d.lines.includes('  paper'));
assert.strictEqual(d.lines[d.lines.length - 1], 'Format des ordres inchangé : le bot reste compatible.');
assert.ok(/ATTENTION/.test(compare(before, before, false).lines.join('\n')));
assert.strictEqual(compare(before, before, null).lines[0], 'Aucun changement visible : correctifs internes ou réglages techniques.');

console.log('readers: ok (lignes de position, congestion du relayer, place en open interest, rapport des nouveautés)');
