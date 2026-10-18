'use strict';

// Published versions on GitHub: which one is the latest, and whether the running bot is behind it.

const assert = require('assert');
const { parseVersion, newer, latestTag, shown } = require('../lib/release');
const { versionText } = require('../lib/dashboard');

assert.deepStrictEqual(parseVersion('v1.9.1'), [1, 9, 1]);
assert.deepStrictEqual(parseVersion('1.8'), [1, 8, 0]);
assert.deepStrictEqual(parseVersion('test-tag'), []);
assert.ok(newer([1, 10, 0], [1, 9, 9]) && !newer([1, 9, 1], [1, 9, 1]) && !newer([1, 8, 4], [1, 9, 0]));
assert.strictEqual(shown([1, 9, 0]), 'v1.9.0');
assert.strictEqual(shown([1, 8, 0]), 'v1.8.0');

// GitHub's tag list, newest first or not: the highest version wins, other tags are ignored.
const tags = [{ name: 'v1.8.4' }, { name: 'v1.10.0' }, { name: 'v1.9.1' }, { name: 'essai' }];
assert.deepStrictEqual(latestTag(tags), { name: 'v1.10.0', v: [1, 10, 0] });
assert.strictEqual(latestTag([{ name: 'essai' }]), null);
assert.strictEqual(latestTag(null), null);

// The dashboard's ÉTAT line: green when up to date (or ahead, in the owner's dev folder), red when behind.
const green = '\x1b[32m';
const red = '\x1b[31m';
const ok = versionText('1.9.1', { name: 'v1.9.1', v: [1, 9, 1] });
assert.ok(ok.includes(green) && ok.includes('v1.9.1') && ok.includes('dernière version'), ok);
const ahead = versionText('1.9.2', { name: 'v1.9.1', v: [1, 9, 1] });
assert.ok(ahead.includes(green), ahead);
const old = versionText('1.9.0', { name: 'v1.9.1', v: [1, 9, 1] });
assert.ok(old.includes(red) && old.includes('v1.9.0') && old.includes('v1.9.1 disponible') && old.includes('mettre-a-jour.bat'), old);
const unknown = versionText('1.9.1', null);
assert.ok(!unknown.includes(green) && !unknown.includes(red) && unknown.includes('v1.9.1'), unknown);

console.log('release: ok (dernière version publiée, version en cours en vert si à jour, en rouge sinon)');
