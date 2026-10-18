'use strict';

// The account state, read from one stream held open (/state/user/live) instead of one connection
// every poll: Papertrade answers HTTP 429 when the bot and the site's own tab together open too
// many. The stream sends a full `wallet` frame, then patches (`baseAccountRevision`) on each change
// and heartbeats in between. The bot only ever uses full frames: a patch makes it reconnect for a
// fresh one, so the account is never rebuilt from pieces. Format read from the site's own client.

const https = require('https');
const api = require('./api');

const REFRESH_MS = 60000; // a fresh full frame at least this often, even when nothing changes
const SILENCE_MS = 45000; // no event for this long: the connection is dead
const MIN_RECONNECT_MS = 2000; // patches come in bursts: at most one reconnect per poll
const FIRST_FRAME_MS = 10000;
// Papertrade runs several servers; on 2026-10-18 one answered 14 minutes behind the others. A frame
// this late asks for another connection, which usually lands on an up-to-date server.
const BEHIND_S = 30;

// Blocks of a server-sent event stream, and the unfinished tail to keep for the next chunk.
function sseEvents(text) {
  const blocks = text.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop();
  const events = blocks.map((block) => {
    const lines = block.split('\n');
    const name = lines.find((l) => l.startsWith('event: '));
    const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    return { event: name ? name.slice(7) : null, data: data.length ? data.join('\n') : null };
  });
  return { events, rest };
}

// Pause before reconnect attempt n (1, 2...): doubles from 1 s up to 30 s, with jitter, as on the site.
function backoffMs(n, random = Math.random) {
  const top = Math.min(30000, 1000 * 2 ** Math.max(0, n - 1));
  return top / 2 + random() * (top / 2);
}

// What each event means for the bot: 'snapshot' (new full frame kept), 'refetch' (the account
// changed: get a full frame), 'behind' (a late server: try another connection; the frame is kept
// only if nothing newer is known), 'invalid' (reconnect) or 'activity' (connection alive).
function walletFeed() {
  const feed = {
    snapshot: null,
    receivedAt: 0,
    receivedLag: 0,
    lastActivity: 0,
    silenceMs: SILENCE_MS,
    event({ event, data }, now) {
      let body;
      try {
        body = data === null ? null : JSON.parse(data);
      } catch (e) {
        return 'invalid';
      }
      feed.lastActivity = now;
      if (event === 'heartbeat') return body === null ? 'activity' : 'invalid';
      if (event === 'liveness') {
        const beat = body && body.heartbeatIntervalMs;
        if (!(Number.isSafeInteger(beat) && beat > 0)) return 'invalid';
        feed.silenceMs = Math.min(SILENCE_MS, 3 * beat);
        return 'activity';
      }
      if (event !== 'wallet') return 'activity';
      if (!body || typeof body !== 'object') return 'invalid';
      if ('baseAccountRevision' in body) return 'refetch';
      if (!Number.isSafeInteger(body.accountRevision) || !Number.isSafeInteger(body.indexedThroughBlock) || !Array.isArray(body.openPositions)) return 'invalid';
      // accountRevision restarts on each connection: the indexed block orders frames.
      if (feed.snapshot && body.indexedThroughBlock < feed.snapshot.indexedThroughBlock) return 'behind';
      feed.snapshot = body;
      feed.receivedAt = now;
      feed.receivedLag = now / 1000 - body.indexedThroughTimestamp;
      return feed.receivedLag > BEHIND_S ? 'behind' : 'snapshot';
    },
  };
  return feed;
}

// The live stream for one wallet. `read()` gives the latest full frame and the indexer delay:
// measured when the frame arrived while the stream is healthy, growing with time once it is not.
function walletStream(wallet) {
  const feed = walletFeed();
  let gen = 0; // connection generation: events of a replaced connection are ignored
  let req = null;
  let connectedAt = 0;
  let failures = 0;
  let lastError = null;
  let retryTimer = null;
  let healthy = false;
  const waiting = [];

  const settle = () => {
    while (waiting.length) waiting.shift().resolve();
  };
  const schedule = (ms) => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, ms);
  };
  // Ends connection `id` and plans the next one: 'error' and 'late' (a server behind, maybe the
  // same one again) back off more each time in a row, 'change' only waits MIN_RECONNECT_MS.
  const drop = (id, err, why = 'error') => {
    if (id !== gen) return;
    gen++;
    if (req) req.destroy();
    req = null;
    healthy = false;
    if (why !== 'change') failures++;
    if (why === 'error') lastError = err;
    schedule(Math.max(why === 'change' ? 0 : backoffMs(failures), connectedAt + MIN_RECONNECT_MS - Date.now()));
  };
  function connect() {
    const id = ++gen;
    connectedAt = Date.now();
    feed.lastActivity = connectedAt;
    feed.silenceMs = SILENCE_MS;
    req = https.get(
      { host: api.PT_HOST, path: `/state/user/live?wallet=${wallet.toLowerCase()}`, lookup: api.lookup, headers: { 'User-Agent': api.UA, Accept: 'text/event-stream' } },
      (res) => {
        if (id !== gen) return res.resume();
        if (res.statusCode !== 200) {
          res.resume();
          return drop(id, new Error(`état du compte -> HTTP ${res.statusCode}`));
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (id !== gen) return;
          const out = sseEvents(buf + chunk);
          buf = out.rest;
          for (const e of out.events) {
            const what = feed.event(e, Date.now());
            if (what === 'snapshot') {
              healthy = true;
              failures = 0;
              lastError = null;
              settle();
            } else if (what === 'refetch' || what === 'behind') {
              if (feed.snapshot) settle();
              return drop(id, null, what === 'behind' ? 'late' : 'change');
            } else if (what === 'invalid') return drop(id, new Error('état du compte -> message illisible'));
          }
        });
        res.on('end', () => drop(id, new Error('état du compte -> flux fermé')));
        res.on('close', () => drop(id, new Error('état du compte -> connexion fermée')));
        res.on('error', (e) => drop(id, e));
      }
    );
    req.on('error', (e) => drop(id, e));
  }
  // Dead connection (no heartbeat), or a full frame due: reconnect.
  const watchdog = setInterval(() => {
    if (!req) return;
    const now = Date.now();
    if (now - feed.lastActivity > feed.silenceMs) drop(gen, new Error(`état du compte -> pas de réponse après ${Math.round(feed.silenceMs / 1000)} s`));
    else if (healthy && now - feed.receivedAt > REFRESH_MS) drop(gen, null, 'change');
  }, 1000);
  watchdog.unref();
  connect();

  return {
    // Resolves with { wallet, lag }, waiting for the first frame up to `deadline`.
    async read(deadline = FIRST_FRAME_MS) {
      if (!feed.snapshot) {
        await new Promise((resolve, reject) => {
          const w = { resolve: () => (clearTimeout(timer), resolve()) };
          const timer = setTimeout(() => {
            waiting.splice(waiting.indexOf(w), 1);
            reject(lastError || new Error(`état du compte -> pas de réponse après ${deadline / 1000} s`));
          }, deadline);
          waiting.push(w);
        });
      }
      // Cut off: say why, as the one-shot reads did; the bot keeps its last state for a while.
      if (!healthy && lastError) throw lastError;
      // Between connections the frame ages from the moment it was known current.
      const lag = feed.receivedLag + (healthy ? 0 : (Date.now() - feed.receivedAt) / 1000);
      return { wallet: feed.snapshot, lag };
    },
    close() {
      gen++;
      clearInterval(watchdog);
      clearTimeout(retryTimer);
      if (req) req.destroy();
      req = null;
    },
  };
}

module.exports = { sseEvents, walletFeed, backoffMs, walletStream, REFRESH_MS };
