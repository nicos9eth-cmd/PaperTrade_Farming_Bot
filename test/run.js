'use strict';

// Runs every test/*.test.js in its own process (npm test). Each file is a plain assert script:
// it prints one line when it passes and exits non-zero when it fails.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;
for (const f of files) {
  const run = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  if (run.status === 0) process.stdout.write(run.stdout);
  else {
    failed++;
    console.log(`ÉCHEC ${f}`);
    process.stdout.write(run.stdout);
    process.stdout.write(run.stderr);
  }
}
console.log(failed ? `${failed} fichier(s) de test en échec sur ${files.length}.` : `${files.length} fichiers de test : tout passe.`);
process.exitCode = failed ? 1 : 0;
