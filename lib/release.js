'use strict';

// Published versions: the git tags vX.Y[.Z] of the public repo. update.js installs the latest one,
// and the dashboard shows whether the running bot is behind it.

const fs = require('fs');
const path = require('path');
const { fetchText } = require('./api');

const REPO = 'nicos9eth-cmd/PaperTrade_Farming_Bot';

const parseVersion = (s) => (String(s).match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/) || []).slice(1, 4).map((n) => Number(n || 0));
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};
const shown = (v) => `v${v.join('.')}`;

// The highest version among GitHub's tags, as { name, v }, or null.
function latestTag(tags) {
  const found = (tags || []).map((t) => ({ name: t.name, v: parseVersion(t.name) })).filter((t) => t.v.length === 3);
  return found.length ? found.reduce((a, b) => (newer(b.v, a.v) ? b : a)) : null;
}

async function get(host, p) {
  const res = await fetchText(host, p, { headers: { Accept: host === 'api.github.com' ? 'application/vnd.github+json' : '*/*' }, deadline: 30000 });
  if (res.status !== 200) throw new Error(`${host}${p} -> HTTP ${res.status}`);
  return res.text;
}

async function latest() {
  return latestTag(JSON.parse(await get('api.github.com', `/repos/${REPO}/tags?per_page=100`)));
}

// The version in this folder's package.json, as a string ('0.0.0' if unreadable).
function localVersion(root = path.join(__dirname, '..')) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch (e) {
    return '0.0.0';
  }
}

module.exports = { REPO, parseVersion, newer, shown, latestTag, latest, get, localVersion };
