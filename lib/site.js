'use strict';

// Follows Papertrade's site deploys: reads the current build id, and checks that the order
// format in the live frontend bundle is still the one this bot signs.

const { PT_HOST, fetchText } = require('./api');
const { TYPES, DOMAIN } = require('./intents');

async function text(path) {
  const res = await fetchText(PT_HOST, path, { headers: { Accept: 'text/html,*/*' }, deadline: 20000 });
  if (res.status !== 200) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.text;
}

// How the bundle writes a type definition, e.g. Close:[{name:`user`,type:`address`},...]
const asBundled = (type) => `${type}:[${TYPES[type].map((f) => '{name:`' + f.name + '`,type:`' + f.type + '`}').join(',')}]`;

// The build chunk is linked from the page or, since mid-October 2026, imported by the entry script.
async function buildId(html) {
  let chunk = html.match(/build-[\w-]{8}\.js/);
  if (!chunk) {
    const index = html.match(/assets\/index-[\w-]+\.js/);
    if (index) chunk = (await text('/' + index[0])).match(/build-[\w-]{8}\.js/);
  }
  if (!chunk) return null;
  const js = await text('/assets/' + chunk[0]);
  // The chunk holds a single hex id, e.g. var e=`273503a8849e`; its export alias changes between builds.
  const ids = [...new Set((js.match(/`[0-9a-f]{8,40}`/g) || []).map((s) => s.slice(1, -1)))];
  return ids.length === 1 ? ids[0] : null;
}

async function formatOk(html) {
  const index = html.match(/assets\/index-[\w-]+\.js/);
  if (!index) return null;
  const typed = (await text('/' + index[0])).match(/typed-data-[\w-]+\.js/);
  if (!typed) return null;
  const js = await text('/assets/' + typed[0]);
  // A missing chunk can be answered with the site's HTML page: that says nothing about the format.
  if (!js.includes('OpenPosition')) return null;
  const domain = 'exchange:{name:`' + DOMAIN.name + '`,version:`' + DOMAIN.version + '`}';
  return ['OpenPosition', 'Close', 'RegisterSessionKey'].every((t) => js.includes(asBundled(t))) && js.includes(domain);
}

// { build, formatOk }: each is null when it could not be determined (site unreachable, layout changed).
async function check() {
  const out = { build: null, formatOk: null };
  try {
    const html = await text('/');
    out.build = await buildId(html).catch(() => null);
    out.formatOk = await formatOk(html).catch(() => null);
  } catch (e) {}
  return out;
}

module.exports = { check };
