'use strict';

// One-click update from the public GitHub repo (mettre-a-jour.bat). Downloads every file of the
// latest published version, and only once all of them arrived intact replaces the local copies.
// The owner's own settings and state are never touched: config.json, the session key, the budget,
// logs and journals are not in the repo, or are skipped below.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const release = require('./lib/release');

const { REPO, get, newer, shown } = release;
const ROOT = __dirname;
// In the repo, but holding the owner's settings: new settings get their defaults from lib/config.js.
const KEEP = new Set(['config.json']);

async function main() {
  // The owner's working folder is the source of the published copies, not a copy of them.
  if (fs.existsSync(path.join(ROOT, 'CLAUDE.md'))) throw new Error('ce dossier est le dossier de développement, il ne se met pas à jour depuis GitHub.');

  console.log('Recherche de la dernière version...');
  const latest = await release.latest();
  if (!latest) throw new Error('aucune version publiée trouvée sur GitHub.');
  // An unreadable version compares as older than any published one.
  const mine = release.parseVersion(release.localVersion(ROOT));
  if (!newer(latest.v, mine)) {
    console.log(`Le bot est déjà à jour (${shown(mine)}).`);
    return;
  }
  console.log(`Mise à jour ${shown(mine)} -> ${latest.name}`);

  const tree = JSON.parse(await get('api.github.com', `/repos/${REPO}/git/trees/${latest.name}?recursive=1`));
  if (tree.truncated) throw new Error('liste des fichiers incomplète, réessaie plus tard.');
  const files = tree.tree.filter((f) => f.type === 'blob' && !KEEP.has(f.path));

  // Everything is downloaded and checked before anything is written: a cut connection
  // leaves the bot as it was, never half updated.
  const got = new Map();
  const todo = files.slice();
  const worker = async () => {
    for (let f = todo.shift(); f; f = todo.shift()) {
      const text = await get('raw.githubusercontent.com', `/${REPO}/${latest.name}/${f.path.split('/').map(encodeURIComponent).join('/')}`);
      if (Buffer.byteLength(text) !== f.size) throw new Error(`${f.path} reçu incomplet, réessaie plus tard.`);
      got.set(f.path, text);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const lockBefore = read('package-lock.json');
  writing = true;
  let changed = 0;
  for (const f of files) {
    let text = got.get(f.path);
    // The repo stores line ends as LF; Windows batch files expect CRLF.
    if (f.path.endsWith('.bat')) text = text.replace(/\r?\n/g, '\r\n');
    const target = path.join(ROOT, ...f.path.split('/'));
    if (read(f.path) === text) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target + '.tmp', text);
    fs.renameSync(target + '.tmp', target);
    changed++;
  }
  console.log(`${changed} fichier(s) mis à jour.`);

  if (read('package-lock.json') !== lockBefore || !fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.log('Installation des composants...');
    const npm = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: true });
    if (npm.status !== 0) throw new Error('installation des composants échouée : lance installer.bat.');
  }
  console.log(`Bot à jour (${latest.name}). Tes réglages, ta clé et ton budget sont conservés.`);
  console.log('Si le bot tournait, ferme sa fenêtre et relance-le pour utiliser la nouvelle version.');
}

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (e) {
    return null;
  }
}

let writing = false;
main().catch((e) => {
  console.error(`Mise à jour impossible : ${e.message}`);
  console.error(writing ? 'Relance mettre-a-jour.bat pour terminer.' : 'Rien n\'a été modifié.');
  process.exitCode = 1;
});
