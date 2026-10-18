'use strict';

// What changed on Papertrade between two site versions, written in plain words to
// nouveautes-papertrade.txt: texts added or removed on the site (buttons, messages, errors),
// the parts of the site that were modified, and market parameters that moved.
// Papertrade publishes no changelog; this is read from the site's own script files.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const api = require('./api');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT_FILE = path.join(ROOT, '.site-snapshot.json');
const REPORT_FILE = path.join(ROOT, 'nouveautes-papertrade.txt');
const MAX_FILES = 400;
const MAX_LINES = 40;
// Third-party libraries: their texts are developer messages, not Papertrade's.
const LIBRARIES = /^(secp256k1|sha3|solana|qrcode|workbox|dist|rolldown|jsx-runtime|curve)/;
// A hashed script name, e.g. trade._coin-DparOeUn.js
const HASHED = /[^"'`\s/(),]+?-[\w-]{8}\.js/g;

async function get(p) {
  const res = await api.fetchText(api.PT_HOST, p, { headers: { Accept: 'text/html,*/*' }, deadline: 30000 });
  if (res.status !== 200) throw new Error(`${p} -> HTTP ${res.status}`);
  return res.text;
}

// Every script reachable from the home page. Any failed download fails the whole snapshot:
// a partial one would report the missing parts as removed.
async function scripts() {
  const html = await get('/');
  const found = new Map();
  const todo = [...new Set((html.match(/assets\/[^"'`\s]+?\.js/g) || []).map((s) => s.slice('assets/'.length)))];
  while (todo.length) {
    if (found.size >= MAX_FILES) throw new Error('trop de fichiers sur le site');
    const batch = todo.splice(0, 4);
    await Promise.all(
      batch.map(async (f) => {
        const js = await get('/assets/' + f);
        found.set(f, js);
        for (const m of js.match(HASHED) || []) if (!found.has(m) && !todo.includes(m) && !batch.includes(m)) todo.push(m);
      })
    );
  }
  return found;
}

const moduleName = (file) => file.replace(/-[\w-]{8}\.js$/, '').replace(/\.js$/, '');

// Sentences shown to users: mostly plain words, starting with a capital or a number.
function texts(js) {
  const out = [];
  const word = /^[A-Za-z][a-z']*[.,:;!?]?$/;
  for (const m of js.matchAll(/`([^`$\\]{6,200})`|"([^"\\]{6,200})"|'([^'\\]{6,200})'/g)) {
    const s = (m[1] || m[2] || m[3]).trim();
    const toks = s.split(/\s+/);
    if (toks.length < 2 || !/^[A-Z0-9$]/.test(s)) continue;
    if (toks.filter((t) => word.test(t)).length / toks.length >= 0.7) out.push(s);
  }
  return out;
}

// Settings Papertrade can change, not live figures.
async function params() {
  const [m, p] = await Promise.all([api.markets(), api.protocol()]);
  const out = {
    'trading en pause': m.tradingPaused,
    'marge minimum par position': m.minMargin,
    'taille minimum par position': m.minNotional,
    'PAPER stakés minimum (relayer)': m.minPaperStake,
    'actions suspendues (relayer)': m.pausedActions.join(', ') || 'aucune',
    'mint : taux de base': p.paper.flatRate,
    'mint : échelle de décroissance': p.paper.decayScale,
    'mint : seuil de LP sous lequel le taux de base s\'applique': p.paper.threshold,
  };
  for (const i of Object.values(m.byId)) {
    const k = (name) => `${i.coin} ${name}`;
    Object.assign(out, {
      [k('ouvrable')]: i.openable,
      [k('levier max')]: i.maxLeverage,
      [k('taille max')]: i.maxNotional,
      [k('marge de liquidation')]: i.liquidationBuffer,
      [k('haircut : multiplicateur de taux')]: i.rateMultiplier,
      [k('haircut : multiplicateur de position')]: i.positionMultiplier,
      [k('haircut : taux de base')]: i.baseRate,
      [k('haircut : taille de référence')]: i.referenceNotional,
    });
  }
  // Open-interest caps are left out: they move all the time with the pool.
  for (const k of Object.keys(out)) if (typeof out[k] === 'number') out[k] = Number(out[k].toPrecision(6));
  return out;
}

async function snapshot(build) {
  const [files, settings] = await Promise.all([scripts(), params()]);
  const modules = {};
  const shown = {};
  for (const [file, js] of files) {
    const name = moduleName(file);
    // Other scripts' hashed names change whenever they do: ignore them to see real edits only.
    modules[name] = crypto.createHash('sha1').update(js.replace(HASHED, 'x.js')).digest('hex').slice(0, 12);
    if (!LIBRARIES.test(name)) for (const t of texts(js)) shown[t] = shown[t] || name;
  }
  return { build, at: new Date().toISOString(), modules, texts: shown, params: settings };
}

function compare(a, b, formatOk) {
  const lines = [];
  const list = (title, items) => {
    if (!items.length) return;
    lines.push(title);
    for (const s of items.slice(0, MAX_LINES)) lines.push('  ' + s);
    if (items.length > MAX_LINES) lines.push(`  ... et ${items.length - MAX_LINES} autres`);
  };
  const added = Object.keys(b.texts).filter((t) => !(t in a.texts));
  const removed = Object.keys(a.texts).filter((t) => !(t in b.texts));
  list('Nouveaux textes sur le site :', added.map((t) => `+ [${b.texts[t]}] ${t}`));
  list('Textes retirés :', removed.map((t) => `- [${a.texts[t]}] ${t}`));
  const names = [...new Set([...Object.keys(a.modules), ...Object.keys(b.modules)])].sort();
  const changed = names.filter((n) => n in a.modules && n in b.modules && a.modules[n] !== b.modules[n]);
  const joined = (items) => (items.length ? [items.join(', ')] : []);
  list('Parties du site modifiées :', joined(changed));
  list('Parties ajoutées :', joined(names.filter((n) => !(n in a.modules))));
  list('Parties retirées :', joined(names.filter((n) => !(n in b.modules))));
  const moved = Object.keys({ ...a.params, ...b.params }).filter((k) => String(a.params[k]) !== String(b.params[k]));
  list('Paramètres Papertrade changés :', moved.map((k) => `${k} : ${a.params[k]} -> ${b.params[k]}`));
  if (!lines.length) lines.push('Aucun changement visible : correctifs internes ou réglages techniques.');
  if (formatOk === false) lines.push('ATTENTION : le format des ordres a changé, le bot doit être mis à jour (il n\'ouvre plus de paire).');
  else if (formatOk === true) lines.push('Format des ordres inchangé : le bot reste compatible.');
  return { lines, added: added.length, removed: removed.length, changed: changed.length, params: moved.length };
}

let last = null; // build of the snapshot on disk
let running = false;

// Called with the site's current build: takes a first snapshot, or reports what changed since the
// previous one. Returns null when there is nothing to report; never throws.
async function record(build, formatOk = null) {
  if (!build || running) return null;
  if (last === null) {
    try {
      last = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')).build;
    } catch (e) {
      last = '';
    }
  }
  if (build === last) return null;
  running = true;
  try {
    const next = await snapshot(build);
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    } catch (e) {}
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(next));
    last = build;
    if (!previous) return null;
    const diff = compare(previous, next, formatOk);
    const title = `=== ${new Date().toLocaleString('fr-FR')} : Papertrade passe de la version ${previous.build} à ${build} ===`;
    // Newest first, so the file opens on the latest update.
    let old = '';
    try {
      old = fs.readFileSync(REPORT_FILE, 'utf8');
    } catch (e) {}
    fs.writeFileSync(REPORT_FILE, [title, ...diff.lines, '', old].join('\n'));
    return diff;
  } catch (e) {
    return { error: e.message };
  } finally {
    running = false;
  }
}

module.exports = { record, compare, texts, REPORT_FILE };
