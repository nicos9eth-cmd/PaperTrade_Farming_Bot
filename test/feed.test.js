'use strict';

// Live BTC price from Hyperliquid's best bid/offer stream (about every 200 ms), the price Papertrade
// settles on: the Lighter cover turns on it instead of waiting for the bot's 2-second tick.

const assert = require('assert');
const { bboMid, SUBSCRIBE } = require('../lib/feed');

const frame = (bid, ask, coin = 'BTC') => JSON.stringify({ channel: 'bbo', data: { coin, time: 1792324298011, bbo: [bid && { px: bid, sz: '0.1', n: 1 }, ask && { px: ask, sz: '0.2', n: 2 }] } });

assert.strictEqual(bboMid(frame('81986.0', '81987.0')), 81986.5);
// Other channels, other coins, an empty side or a crossed book: no price.
assert.strictEqual(bboMid(JSON.stringify({ channel: 'subscriptionResponse', data: {} })), null);
assert.strictEqual(bboMid(frame('3000.1', '3000.2', 'ETH')), null);
assert.strictEqual(bboMid(frame(null, '81987.0')), null);
assert.strictEqual(bboMid(frame('81990.0', '81987.0')), null);
assert.strictEqual(bboMid('{not json'), null);
assert.deepStrictEqual(JSON.parse(SUBSCRIBE), { method: 'subscribe', subscription: { type: 'bbo', coin: 'BTC' } });

console.log('feed: ok (prix BTC en direct de Hyperliquid, messages illisibles ignorés)');
