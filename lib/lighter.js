'use strict';

// Lighter (zero-fee perps DEX), used to hedge the Papertrade exposure the relayer cannot close in
// time. Reads go over Lighter's public API; orders are signed by lib/lighter_bridge.py, which runs
// Lighter's official SDK in the bot's own Python environment (.venv-lighter, made by setup-lighter.bat).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fetchText } = require('./api');

const HOST = 'mainnet.zklighter.elliot.ai';
const URL_BASE = `https://${HOST}`;
const ROOT = path.join(__dirname, '..');
const KEY_FILE = path.join(ROOT, '.lighter-key.json');
const VENV = path.join(ROOT, '.venv-lighter');
const PYTHON = path.join(VENV, 'Scripts', 'python.exe');
const SDK_VERSION = '1.1.6';
const BTC_MARKET = 1;
const SIZE_SCALE = 1e5; // BTC amounts are integers of 0.00001 BTC
const MAX_LEVERAGE = 50; // Lighter's cap on BTC (2 % initial margin)
const MAX_SLIPPAGE = 0.003; // an order filling worse than 0.3 % from the best price is refused

async function get(p) {
  const res = await fetchText(HOST, p, { headers: { Accept: 'application/json' }, deadline: 10000 });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch (e) {}
  if (res.status !== 200 || !json) throw new Error(`Lighter ${p.split('?')[0]} -> HTTP ${res.status}`);
  return json;
}

// The main Lighter account of an Ethereum address (the lowest index), or null.
async function accountIndex(l1) {
  const r = await get(`/api/v1/accountsByL1Address?l1_address=${l1.toLowerCase()}`);
  const idx = (r.sub_accounts || []).map((a) => a.index);
  return idx.length ? Math.min(...idx) : null;
}

async function apiKeys(index) {
  return (await get(`/api/v1/apikeys?account_index=${index}&api_key_index=255`)).api_keys || [];
}

// Collateral and BTC position (signed size in BTC: positive long, negative short).
async function account(index) {
  const r = await get(`/api/v1/account?by=index&value=${index}`);
  const a = (r.accounts || [])[0];
  if (!a) throw new Error('compte Lighter introuvable');
  const p = (a.positions || []).find((x) => x.market_id === BTC_MARKET);
  const base = p ? Number(p.position) * (p.sign < 0 ? -1 : 1) : 0;
  if (!Number.isFinite(base) || !Number.isFinite(Number(a.collateral))) throw new Error('compte Lighter illisible');
  return {
    collateral: Number(a.collateral),
    equity: Number(a.total_asset_value),
    base,
    entry: p ? Number(p.avg_entry_price) : 0,
    liquidation: p ? Number(p.liquidation_price) : 0,
  };
}

function loadKey() {
  try {
    const k = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    return Number.isInteger(k.account_index) && Number.isInteger(k.api_key_index) && k.private_key ? k : null;
  } catch (e) {
    return null;
  }
}

function saveKey(k) {
  fs.writeFileSync(KEY_FILE + '.tmp', JSON.stringify(k, null, 2));
  fs.renameSync(KEY_FILE + '.tmp', KEY_FILE);
}

// The part of the Lighter BTC position the bot opened itself (signed, in BTC). Kept on disk so a
// restart in the middle of a hedge does not mistake the hedge for the owner's own position.
const HEDGE_FILE = path.join(ROOT, '.lighter-hedge.json');
function loadOwn() {
  try {
    const v = JSON.parse(fs.readFileSync(HEDGE_FILE, 'utf8')).own;
    return Number.isFinite(v) ? v : 0;
  } catch (e) {
    return 0;
  }
}
function saveOwn(own) {
  try {
    fs.writeFileSync(HEDGE_FILE + '.tmp', JSON.stringify({ own }));
    fs.renameSync(HEDGE_FILE + '.tmp', HEDGE_FILE);
  } catch (e) {}
}

// The Python process signing for the bot. Restarted on the next request if it dies.
function bridge() {
  let proc = null;
  let nextId = 1;
  const waiting = new Map();
  let buf = '';
  const start = () => {
    proc = spawn(PYTHON, [path.join(__dirname, 'lighter_bridge.py')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          continue;
        }
        const w = waiting.get(msg.id);
        if (w) {
          waiting.delete(msg.id);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
    proc.stderr.on('data', () => {}); // SDK warnings: not the bot's business
    // Writing to a process that failed to start or just died: the pending request times out instead.
    proc.stdin.on('error', () => {});
    const fail = (why) => {
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error(why));
      }
      waiting.clear();
      proc = null;
      buf = '';
    };
    proc.on('exit', (code) => fail(`signeur Lighter arrêté (code ${code})`));
    proc.on('error', (e) => fail(`signeur Lighter introuvable : ${e.message}`));
  };
  return {
    request(cmd, fields = {}, deadline = 20000) {
      if (!proc) start();
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`signeur Lighter : pas de réponse à ${cmd} après ${deadline / 1000} s`));
        }, deadline);
        waiting.set(id, { resolve, reject, timer });
        proc.stdin.write(JSON.stringify({ id, cmd, ...fields }) + '\n');
      });
    },
    stop() {
      if (proc) proc.kill();
    },
  };
}

// Raises when the bridge answered with a refusal.
const must = (r, what) => {
  if (!r.ok) throw new Error(`Lighter ${what} refusé : ${r.error}`);
  return r;
};

// The real account, through the registered key.
function live(key) {
  const b = bridge();
  return {
    name: 'Lighter',
    async init() {
      must(await b.request('init', { url: URL_BASE, account_index: key.account_index, api_key_index: key.api_key_index, private_key: key.private_key }), 'clé API');
      // The hedge can need all the collateral: allow Lighter's maximum on BTC (cross margin).
      must(await b.request('leverage', { leverage: MAX_LEVERAGE }), 'levier');
    },
    state: () => account(key.account_index),
    // Market order for `base` BTC (signed: positive buys). Returns once Lighter accepted it.
    async trade(base, reduceOnly) {
      const units = Math.round(Math.abs(base) * SIZE_SCALE);
      if (!units) return;
      must(await b.request('order', { base: units, is_ask: base < 0, reduce_only: !!reduceOnly, max_slippage: MAX_SLIPPAGE }), 'ordre');
    },
    stop: () => b.stop(),
  };
}

// In-memory account at the live price, for the simulation, starting from the real account's
// collateral and BTC position.
function simulated(collateral, base = 0, entry = 0) {
  const s = { collateral, base, entry, price: entry };
  const pnl = () => s.base * (s.price - s.entry);
  return {
    name: 'Lighter (simulation)',
    async init() {},
    onPrice(p) {
      s.price = p;
    },
    async state() {
      return { collateral: s.collateral, equity: s.collateral + pnl(), base: s.base, entry: s.entry, liquidation: 0 };
    },
    async trade(base) {
      const next = s.base + base;
      // Realise the part that is closed, average the part that is added.
      if (s.base && Math.sign(base) !== Math.sign(s.base)) {
        const closed = Math.min(Math.abs(base), Math.abs(s.base)) * Math.sign(s.base);
        s.collateral += closed * (s.price - s.entry);
      }
      if (!next) s.entry = 0;
      else if (Math.sign(next) !== Math.sign(s.base)) s.entry = s.price;
      else if (Math.abs(next) > Math.abs(s.base)) s.entry = (s.entry * s.base + s.price * base) / next;
      s.base = Math.round(next * SIZE_SCALE) / SIZE_SCALE;
    },
    stop() {},
  };
}

module.exports = { HOST, URL_BASE, KEY_FILE, PYTHON, VENV, SDK_VERSION, SIZE_SCALE, MAX_LEVERAGE, accountIndex, apiKeys, account, loadKey, saveKey, loadOwn, saveOwn, bridge, live, simulated };
