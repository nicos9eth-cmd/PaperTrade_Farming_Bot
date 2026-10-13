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

async function buildId(html) {
  const chunk = html.match(/assets\/build-[\w-]+\.js/);
  if (!chunk) return null;
  const js = await text('/' + chunk[0]);
  // The bundle exports the id under the alias `t`: find `X as t`, then X=`<hex id>`.
  const alias = js.match(/([\w$]+) as t[,}]/);
  if (!alias) return null;
  const at = js.indexOf(alias[1] + '=`');
  const id = at < 0 ? null : js.slice(at + alias[1].length + 2).match(/^[0-9a-f]{8,40}(?=`)/);
  return id ? id[0] : null;
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
