'use strict';

// Builds a clean copy of the bot to give to someone else: no session key, no wallet, no logs.

const fs = require('fs');
const path = require('path');

const FILES = ['bot.js', 'watch.js', 'setup.js', 'configure.js', 'share.js', 'update.js', 'package.json', 'package-lock.json', 'README.md', '.gitignore'];
const DIRS = ['lib', 'test'];
const BATS = fs.readdirSync(__dirname).filter((f) => f.endsWith('.bat'));
const out = path.join(__dirname, 'partage', 'PaperTradeBot');

fs.rmSync(path.join(__dirname, 'partage'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of [...FILES, ...BATS]) if (fs.existsSync(path.join(__dirname, f))) fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
for (const d of DIRS) {
  fs.mkdirSync(path.join(out, d));
  for (const f of fs.readdirSync(path.join(__dirname, d))) fs.copyFileSync(path.join(__dirname, d, f), path.join(out, d, f));
}
// The copy gets the documented default settings, never the owner's (wallet, budget, leverage).
const { DEFAULTS } = require('./lib/config');
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(DEFAULTS, null, 2) + '\n');

console.log(`Copie propre créée dans : ${out}`);
console.log('Elle ne contient ni ta clé de session, ni ton adresse, ni tes journaux, ni tes réglages.');
