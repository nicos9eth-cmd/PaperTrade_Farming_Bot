'use strict';

// config.json as non-developers edit it in Notepad: every mistake gets a message they can act on.

const assert = require('assert');
const { parse, DEFAULTS } = require('../lib/config');

const fails = (text, pattern) => assert.throws(() => parse(text), (e) => pattern.test(e.message) && e.message.startsWith('config.json : '), text);

// A setting left out takes its default; Notepad's BOM is ignored.
let c = parse('﻿{ "maxNetLossUsd": 50 }');
assert.strictEqual(c.maxNetLossUsd, 50);
assert.strictEqual(c.closeAt, DEFAULTS.closeAt);
assert.deepStrictEqual(parse(JSON.stringify(DEFAULTS)), DEFAULTS);
// null is allowed where documented.
assert.strictEqual(parse('{ "maxMarginPerLeg": null }').maxMarginPerLeg, null);

// Typos: the line is given.
fails('{\n  "closeAt": 0.85,\n  "reserve": 0,5\n}', /vers la ligne 3/);
fails('{\n  "closeAt": 0.85\n  "reserve": 0.01\n}', /vers la ligne 3/);
// Numbers in quotes, out of range, wrong types.
fails('{ "closeAt": "0.85" }', /"closeAt" doit être un nombre/);
fails('{ "closeAt": 0.99 }', /"closeAt" vaut 0.99, il doit être entre 0.1 et 0.95/);
fails('{ "closeAt": null }', /"closeAt" doit être un nombre sans guillemets, écrit/);
fails('{ "minCloseAt": 0.9, "closeAt": 0.8 }', /"minCloseAt" \(0.9\) doit être plus petit/);
fails('{ "wallet": "0x123" }', /"wallet" doit être une adresse/);
fails('{ "sound": "true" }', /"sound" doit valoir true ou false/);
// The Lighter trend overlay is off unless asked for, with a loss limit of its own.
assert.strictEqual(DEFAULTS.lighterScalp, false);
assert.strictEqual(DEFAULTS.lighterScalpMaxLossUsd, 5);
fails('{ "lighterScalp": "oui" }', /"lighterScalp" doit valoir true ou false/);
fails('{ "lighterScalpMaxLossUsd": -1 }', /"lighterScalpMaxLossUsd" vaut -1/);
assert.strictEqual(parse('{ "burstMaxCostPerPaper": 0.006 }').burstMaxCostPerPaper, 0.006);
fails('{ "burstMaxCostPerPaper": 0 }', /"burstMaxCostPerPaper" vaut 0/);
assert.strictEqual(parse('{ "wallet": "0x6cd5661646289FB6E65EA5C032310fDEd797D0a2" }').wallet, '0x6cd5661646289FB6E65EA5C032310fDEd797D0a2');

console.log('config: ok (valeurs par défaut, BOM, ligne de la faute, plages, types)');
