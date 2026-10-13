'use strict';

// Live relayer congestion, from the same public stream that feeds the site's Status tab
// (Congestion / Pending Tx / Time To Clear).

const WebSocket = require('ws');

const URL = 'wss://stream.papertrade.xyz/connection/websocket';
const CHANNEL = 'pressure:current';
const STALE_MS = 10000;
const SILENCE_MS = 30000;

function summarize(s) {
  const limit = Number(s.blockGasLimit);
  const pendingGas = Number(s.totalPendingGas);
  const blocks = (s.chain && s.chain.blocks) || [];
  // Gas other users take per block leaves less room for the relayer's batches.
  const foreign = blocks.length ? blocks.reduce((sum, b) => sum + Number(b.gasUsed) - Number(b.papertradeGasUsed || 0), 0) / blocks.length : 0;
  const room = Math.max(limit * 0.1, limit - foreign);
  const neededBlocks = pendingGas > 0 ? Math.ceil(pendingGas / room) : 0;
  const out = {
    at: s.ts,
    pending: s.pendingCount,
    neededBlocks,
    clearSeconds: s.pendingCount ? Math.max(3, neededBlocks) : 0,
    level: neededBlocks <= 1 ? 'LOW' : neededBlocks <= 5 ? 'MEDIUM' : 'HIGH',
  };
  // An unreadable snapshot is no reading at all, rather than numbers the bot would act on.
  return [out.at, out.pending, out.neededBlocks, out.clearSeconds].every(Number.isFinite) ? out : null;
}

// Keeps the stream open (reconnecting as needed); current() is null when there is no fresh reading.
function watch() {
  let latest = null;
  let ws = null;
  let heard = Date.now();
  // A connection that went silent without closing is dropped, which triggers a reconnect.
  setInterval(() => {
    if (ws && Date.now() - heard > SILENCE_MS) ws.terminate();
  }, SILENCE_MS).unref();
  const connect = () => {
    heard = Date.now();
    ws = new WebSocket(URL, { headers: { Origin: 'https://exchange.papertrade.xyz' } });
    const use = (data) => {
      if (data && data.snapshot && data.snapshot.ok && !data.snapshot.stale) latest = summarize(data.snapshot) || latest;
    };
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, connect: { name: 'js' } })));
    ws.on('message', (raw) => {
      heard = Date.now();
      for (const line of raw.toString().split('\n')) {
        if (!line.trim()) continue;
        if (line === '{}') {
          if (ws.readyState === WebSocket.OPEN) ws.send('{}'); // server ping
          continue;
        }
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (msg.id === 1 && msg.connect) ws.send(JSON.stringify({ id: 2, subscribe: { channel: CHANNEL } }));
        else if (msg.id === 2 && msg.subscribe) (msg.subscribe.publications || []).forEach((p) => use(p.data));
        else if (msg.push && msg.push.pub) use(msg.push.pub.data);
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => setTimeout(connect, 3000));
  };
  connect();
  return { current: () => (latest && Date.now() - latest.at < STALE_MS ? latest : null) };
}

module.exports = { watch, summarize };
