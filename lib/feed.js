'use strict';

// Live BTC mid from Hyperliquid's best bid/offer stream: a frame on each change, about every 200 ms
// (the polled book the bot reads each tick is 2 s apart). Hyperliquid is the price Papertrade
// settles on; Lighter's own book sat $14 away on 2026-10-18, more than the cover's whole margin.

const WebSocket = require('ws');
const { backoffMs } = require('./stream');

const URL = 'wss://api.hyperliquid.xyz/ws';
const SUBSCRIBE = JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin: 'BTC' } });
const SILENCE_MS = 30000; // BTC's best price changes many times a minute: silence means a dead link

// The mid of a bbo frame, or null for anything else.
function bboMid(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!j || j.channel !== 'bbo' || !j.data || j.data.coin !== 'BTC' || !Array.isArray(j.data.bbo)) return null;
  const [bid, ask] = j.data.bbo;
  if (!bid || !ask) return null;
  const b = Number(bid.px);
  const a = Number(ask.px);
  return b > 0 && a >= b ? (a + b) / 2 : null;
}

// Calls onMid(price) on each new mid; reconnects by itself. Returns { close }.
function liveMid(onMid) {
  let ws = null;
  let failures = 0;
  let lastAt = 0;
  let closed = false;
  let timer = null;
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(URL);
    lastAt = Date.now();
    ws.on('open', () => ws.send(SUBSCRIBE));
    ws.on('message', (m) => {
      lastAt = Date.now();
      const mid = bboMid(String(m));
      if (mid === null) return;
      failures = 0;
      onMid(mid);
    });
    const retry = () => {
      if (closed || !ws) return;
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      ws = null;
      timer = setTimeout(connect, backoffMs(++failures));
    };
    ws.on('close', retry);
    ws.on('error', retry);
  };
  const watchdog = setInterval(() => {
    if (ws && Date.now() - lastAt > SILENCE_MS) ws.emit('close');
  }, 5000);
  watchdog.unref();
  connect();
  return {
    close() {
      closed = true;
      clearInterval(watchdog);
      clearTimeout(timer);
      if (ws) ws.terminate();
    },
  };
}

module.exports = { bboMid, liveMid, SUBSCRIBE };
