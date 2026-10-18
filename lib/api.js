'use strict';

const https = require('https');
const dns = require('dns');

const PT_HOST = 'exchange.papertrade.xyz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PaperTradeBot';
const num = (raw, decimals = 18) => Number(BigInt(raw)) / 10 ** decimals;

// DNS lookup that remembers each host's last answer. The owner's connection has had hours of
// intermittent DNS failures (ENOTFOUND, or lookups hanging past the request deadline) while the
// servers themselves were reachable: in that case requests go on with the last known address.
const knownAddress = new Map();
const LOOKUP_PATIENCE_MS = 2000;
function lookup(host, options, callback) {
  if (typeof options === 'function') [options, callback] = [{}, options];
  const opts = typeof options === 'number' ? { family: options } : options || {};
  let done = false;
  const answer = (err, a) => {
    if (done) return;
    done = true;
    clearTimeout(patience);
    if (err) callback(err);
    else if (opts.all) callback(null, [a]);
    else callback(null, a.address, a.family);
  };
  const last = knownAddress.get(host);
  const patience = last ? setTimeout(() => answer(null, last), LOOKUP_PATIENCE_MS) : null;
  dns.lookup(host, { family: opts.family || 0, hints: opts.hints || 0 }, (err, address, family) => {
    if (!err) {
      knownAddress.set(host, { address, family });
      answer(null, { address, family });
    } else if (last) answer(null, last);
    else answer(err);
  });
}

// One HTTPS exchange, as { status, text }. `deadline` bounds the whole call: whatever the
// server or the connection does, the promise settles by then, so the bot's loop cannot freeze.
// Every call opens a fresh connection. Keeping them open was measured on 2026-10-15: about 20 ms
// saved per read (both hosts answer from a nearby CDN edge), not worth the dropped-connection cases.
function fetchText(host, path, { body = null, headers = {}, deadline = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${host}${path} -> pas de réponse après ${deadline / 1000} s`)), deadline);
    const req = https.request(
      {
        host,
        path,
        lookup,
        method: body ? 'POST' : 'GET',
        headers: { 'User-Agent': UA, ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => finish(null, { status: res.statusCode, text }));
        // A connection cut in the middle of the body ends without 'end'.
        res.on('aborted', () => finish(new Error(`${host}${path} -> réponse interrompue`)));
        res.on('close', () => finish(new Error(`${host}${path} -> connexion fermée`)));
        res.on('error', (e) => finish(e));
      }
    );
    req.on('error', (e) => finish(e));
    if (body) req.write(body);
    req.end();
  });
}

// JSON request. Rejects with .status and .payload on a non-2xx answer or an unreadable body.
async function request(host, path, body, headers = {}, deadline = 10000) {
  const res = await fetchText(host, path, { body: body ? JSON.stringify(body) : null, headers: { Accept: 'application/json', ...headers }, deadline });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch (e) {}
  if (res.status < 200 || res.status >= 300 || json === null) {
    const err = new Error(`${host}${path} -> HTTP ${res.status}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// Hyperliquid BBO mid, the price Papertrade executes at.
async function hlMid(coin) {
  const book = await request('api.hyperliquid.xyz', '/info', { type: 'l2Book', coin });
  const bid = Number(book.levels[0][0].px);
  const ask = Number(book.levels[1][0].px);
  const mid = (bid + ask) / 2;
  if (!(mid > 0) || ask < bid) throw new Error('prix Hyperliquid illisible');
  return mid;
}

// PAPER's price: Paragon's pre-market perp on Hyperliquid (HIP-3 dex `para`), listed 2026-10-18
// while the token itself is not transferable yet. A market estimate, not a price PAPER can be sold at.
const PAPER_COIN = 'para:PAPER';
function parsePaperPrice(mids) {
  const px = Number(mids && mids[PAPER_COIN]);
  return px > 0 ? px : null;
}

async function paperPrice() {
  return parsePaperPrice(await request('api.hyperliquid.xyz', '/info', { type: 'allMids', dex: 'para' }));
}

// Per-market impact parameters and price scale.
async function markets() {
  const t = await request(PT_HOST, '/state/trading');
  const intake = t.intake || [];
  const out = {
    tradingPaused: t.tradingPaused,
    minMargin: num(t.minimumTradeSizeRaw),
    minNotional: num(t.minimumOpenNotionalRaw),
    // Relayer-side limits: minimum staked PAPER, cap on net open interest (USD), paused actions.
    minPaperStake: intake[1] ? num(intake[1]) : 0,
    maxNetOi: intake[2] ? num(intake[2]) : 0,
    pausedActions: Array.isArray(intake[3]) ? intake[3] : [],
    byId: {},
  };
  for (const i of t.instruments) {
    out.byId[i[0]] = {
      id: i[0],
      coin: i[1],
      priceScale: Number(i[3]),
      openable: i[4] && !i[5],
      maxLeverage: i[14],
      maxNotional: num(i[15]),
      liquidationBuffer: num(i[16]),
      rateMultiplier: num(i[12]),
      positionMultiplier: num(i[13]),
      baseRate: num(i[17]),
      referenceNotional: num(i[18]),
      // Open interest and per-side caps, in units of the asset.
      oiLong: num(i[19]),
      oiShort: num(i[20]),
      capLong: num(i[21]),
      capShort: num(i[22]),
    };
  }
  return out;
}

// The mint curve's inputs, as the site's PAPER tab reads them. `lp` is the pool the curve is
// evaluated at (LP + reserve - payout queue); under `threshold` (the cliff) every dollar lost mints
// the flat rate, and `window` says so.
function parseProtocol(s) {
  const b = s.balances;
  const paper = {
    flatRate: num(s.paper.rate),
    decayScale: num(s.paper.decay),
    tailProgress: num(s.paper.tailProgress),
    threshold: num(s.paper.cliff),
    trackedLp: num(s.paper.trackedLp),
    lp: num(BigInt(b.lp) + BigInt(b.reserve) - BigInt(b.queue)),
  };
  return { queueEmpty: BigInt(b.queue) === 0n, window: paper.lp < paper.threshold, paper };
}

async function protocol() {
  return parseProtocol(await request(PT_HOST, '/query/protocol/summary'));
}

// Decodes one position row. A row on a market the bot does not know gets `market: null`
// (callers skip it). A row that does not look like the expected layout throws: acting on a
// misread position (wrong side, wrong price) would be worse than not acting.
function parsePosition(p, mkts) {
  const m = mkts.byId[p[1]] || null;
  if (!m) return { id: String(p[0]), market: null };
  const margin = num(p[5]);
  const pos = {
    id: String(p[0]),
    market: m,
    isLong: p[2],
    entry: Number(p[4]) / m.priceScale,
    margin,
    leverage: p[6],
    notional: margin * p[6],
    bust: Number(p[7]) / m.priceScale,
    openedAt: p[8],
  };
  const ok = typeof pos.isLong === 'boolean' && pos.entry > 0 && pos.bust > 0 && pos.margin > 0 && Number.isInteger(pos.leverage) && pos.leverage > 0 && (pos.isLong ? pos.bust < pos.entry : pos.bust > pos.entry);
  if (!ok) throw new Error('format de position inattendu dans l\'état du compte');
  return pos;
}

// One snapshot of the account from the live state stream (first "wallet" event).
function walletSnapshot(wallet, deadline = 10000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      err ? reject(err) : resolve(value);
    };
    // Hard limit: heartbeats keep the stream alive, so an idle timeout alone would never fire.
    const timer = setTimeout(() => finish(new Error(`état du compte -> pas de réponse après ${deadline / 1000} s`)), deadline);
    const req = https.get(
      { host: PT_HOST, path: `/state/user/live?wallet=${wallet.toLowerCase()}`, lookup, headers: { 'User-Agent': UA, Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) return finish(new Error(`état du compte -> HTTP ${res.statusCode}`));
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let end;
          while ((end = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, end);
            buf = buf.slice(end + 2);
            if (!/^event: wallet$/m.test(block)) continue;
            const line = block.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            try {
              return finish(null, JSON.parse(line.slice(6)));
            } catch (e) {
              return finish(e);
            }
          }
        });
        res.on('end', () => finish(new Error('état du compte -> flux fermé sans données')));
        res.on('close', () => finish(new Error('état du compte -> connexion fermée')));
        res.on('error', (e) => finish(e));
      }
    );
    req.on('error', (e) => finish(e));
  });
}

// A failure that clears by itself: rate limit, server error, timeout, cut connection.
const transient = (e) => /HTTP (429|5\d\d)|pas de réponse|connexion fermée|flux fermé/.test(e.message) || /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)/.test(e.code || '');

// Start-up reads: retried after each pause in `waits` while the failure is transient.
async function retry(fn, { waits = [5000, 15000, 30000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= waits.length || !transient(e)) throw e;
      log(`${e.message} ; nouvel essai dans ${waits[i] / 1000} s`);
      await sleep(waits[i]);
    }
  }
}

module.exports = { PT_HOST, UA, lookup, fetchText, request, hlMid, parsePaperPrice, paperPrice, markets, protocol, parseProtocol, parsePosition, walletSnapshot, num, transient, retry };
