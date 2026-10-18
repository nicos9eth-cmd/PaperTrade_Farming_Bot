'use strict';

// Start-up reads: a passing failure (rate limit, timeout, cut connection) is retried after a pause,
// a lasting one (unreadable answer, page not found) stops right away.

const assert = require('assert');
const { retry, transient } = require('../lib/api');

assert.ok(transient(new Error('état du compte -> HTTP 429')));
assert.ok(transient(new Error('état du compte -> HTTP 503')));
assert.ok(transient(new Error('état du compte -> pas de réponse après 10 s')));
assert.ok(transient(new Error('état du compte -> connexion fermée')));
assert.ok(transient(new Error('état du compte -> flux fermé sans données')));
assert.ok(transient(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
assert.ok(!transient(new Error('état du compte -> HTTP 404')));
assert.ok(!transient(new Error('format de position inattendu dans l\'état du compte')));

(async () => {
  const slept = [];
  const said = [];
  const opts = { waits: [5000, 15000, 30000], sleep: async (ms) => slept.push(ms), log: (s) => said.push(s) };
  const failing = (errors, value) => {
    let n = 0;
    const fn = async () => {
      n++;
      if (errors.length) throw errors.shift();
      return value;
    };
    fn.calls = () => n;
    return fn;
  };

  // First try good: no pause.
  let fn = failing([], 'ok');
  assert.strictEqual(await retry(fn, opts), 'ok');
  assert.deepStrictEqual(slept, []);

  // Two rate limits, then the answer: paused 5 s then 15 s, and said why.
  fn = failing([new Error('état du compte -> HTTP 429'), new Error('état du compte -> HTTP 429')], 'ok');
  assert.strictEqual(await retry(fn, opts), 'ok');
  assert.deepStrictEqual(slept, [5000, 15000]);
  assert.strictEqual(said.length, 2);
  assert.ok(/HTTP 429 ; nouvel essai dans 5 s/.test(said[0]), said[0]);

  // A lasting error is not retried.
  slept.length = 0;
  fn = failing([new Error('format de position inattendu dans l\'état du compte')], 'ok');
  await assert.rejects(retry(fn, opts), /format de position/);
  assert.strictEqual(fn.calls(), 1);
  assert.deepStrictEqual(slept, []);

  // Still failing after every pause: the last error comes out.
  fn = failing([1, 2, 3, 4].map((i) => new Error(`état du compte -> HTTP 429 (${i})`)), 'ok');
  await assert.rejects(retry(fn, opts), /HTTP 429 \(4\)/);
  assert.strictEqual(fn.calls(), 4);
  assert.deepStrictEqual(slept, [5000, 15000, 30000]);

  console.log('retry: ok (429, délai, coupure = nouvel essai après pause ; réponse illisible = arrêt)');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
