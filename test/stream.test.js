'use strict';

// The account state stream (/state/user/live), held open instead of one connection every poll:
// a full `wallet` frame first, then patches (`baseAccountRevision`) on each change, heartbeats in
// between. The bot keeps full frames only: a patch makes it fetch a fresh full frame.

const assert = require('assert');
const { sseEvents, walletFeed, backoffMs, REFRESH_MS } = require('../lib/stream');

// Server-sent events: blocks split on a blank line, partial blocks kept for the next chunk.
let r = sseEvents(': connected\n\nevent: liveness\ndata: {"heartbeatIntervalMs":15000}\n\nevent: wal');
assert.deepStrictEqual(r.events, [{ event: null, data: null }, { event: 'liveness', data: '{"heartbeatIntervalMs":15000}' }]);
assert.strictEqual(r.rest, 'event: wal');
r = sseEvents(r.rest + 'let\ndata: {"a":\ndata: 1}\n\n');
assert.deepStrictEqual(r.events, [{ event: 'wallet', data: '{"a":\n1}' }]);
assert.strictEqual(r.rest, '');
// Windows line ends from a proxy are tolerated.
assert.deepStrictEqual(sseEvents('event: heartbeat\r\ndata: null\r\n\r\n').events, [{ event: 'heartbeat', data: 'null' }]);

const T = 1792291487000;
// accountRevision counts frames within one connection (it starts at 1 on each): the indexed block
// tells which of two frames is newer.
const full = { address: '0xa09d', accountRevision: 1, indexedThroughBlock: 48862581, indexedThroughTimestamp: T / 1000 - 1.5, openPositions: [], operations: [] };
const ev = (event, data) => ({ event, data: JSON.stringify(data) });

const feed = walletFeed();
assert.strictEqual(feed.snapshot, null);
// Liveness sets the silence limit: 3 heartbeats, at most 45 s.
assert.strictEqual(feed.event(ev('liveness', { heartbeatIntervalMs: 20000 }), T), 'activity');
assert.strictEqual(feed.silenceMs, 45000);
assert.strictEqual(feed.event(ev('liveness', { heartbeatIntervalMs: 5000 }), T), 'activity');
assert.strictEqual(feed.silenceMs, 15000);
// A full frame is kept, with the indexer delay measured when it arrived.
assert.strictEqual(feed.event(ev('wallet', full), T), 'snapshot');
assert.strictEqual(feed.snapshot.indexedThroughBlock, 48862581);
assert.strictEqual(feed.receivedAt, T);
assert.ok(Math.abs(feed.receivedLag - 1.5) < 1e-9);
// Heartbeats keep the connection alive without touching the state.
assert.strictEqual(feed.event(ev('heartbeat', null), T + 20000), 'activity');
assert.strictEqual(feed.lastActivity, T + 20000);
assert.strictEqual(feed.receivedAt, T);
// A patch: the account changed, fetch a full frame. The old one stays usable meanwhile.
assert.strictEqual(feed.event(ev('wallet', { baseAccountRevision: 1, accountRevision: 2, addedPositions: [] }), T + 21000), 'refetch');
assert.strictEqual(feed.snapshot.indexedThroughBlock, 48862581);
// Measured on 2026-10-18: one of Papertrade's servers answered 14 minutes behind. Its frame
// (older block) never replaces a newer one, and asks for another connection.
const behind = { ...full, indexedThroughBlock: 48861711, indexedThroughTimestamp: T / 1000 - 863 };
assert.strictEqual(feed.event(ev('wallet', behind), T + 22000), 'behind');
assert.strictEqual(feed.snapshot.indexedThroughBlock, 48862581);
assert.strictEqual(feed.event(ev('wallet', { ...full, indexedThroughBlock: 48862597, indexedThroughTimestamp: T / 1000 + 22 }), T + 23000), 'snapshot');
assert.strictEqual(feed.snapshot.indexedThroughBlock, 48862597);
// With nothing better, a late frame is kept (the bot sees its delay) but another is asked for.
const first = walletFeed();
assert.strictEqual(first.event(ev('wallet', behind), T), 'behind');
assert.ok(first.snapshot && Math.abs(first.receivedLag - 863) < 1e-9);
// Garbage or a frame without revision or block: reconnect.
assert.strictEqual(feed.event({ event: 'wallet', data: '{oops' }, T), 'invalid');
assert.strictEqual(feed.event(ev('wallet', { address: '0xa09d' }), T), 'invalid');
assert.strictEqual(feed.event(ev('wallet', { ...full, indexedThroughBlock: undefined }), T), 'invalid');
assert.strictEqual(feed.event(ev('heartbeat', { not: 'null' }), T), 'invalid');
// Unknown events and comments are ignored.
assert.strictEqual(feed.event({ event: null, data: null }, T), 'activity');
assert.strictEqual(feed.event(ev('something-new', { x: 1 }), T), 'activity');

// Reconnection pauses, as on the site: 1 s, 2 s, 4 s... at most 30 s, between half and all of it.
assert.strictEqual(backoffMs(1, () => 0), 500);
assert.strictEqual(backoffMs(1, () => 1), 1000);
assert.strictEqual(backoffMs(3, () => 1), 4000);
assert.strictEqual(backoffMs(10, () => 1), 30000);
assert.strictEqual(backoffMs(10, () => 0), 15000);
// A full frame at least every minute even when nothing changes, as a safety net.
assert.ok(REFRESH_MS >= 30000 && REFRESH_MS <= 120000);

console.log('stream: ok (flux du compte gardé ouvert : état complet, correctifs = relecture, pulsations, pauses 1 s -> 30 s)');
