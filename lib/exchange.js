'use strict';

// Two interchangeable back ends for the bot: the real account, and a simulation at live prices.

const api = require('./api');
const intents = require('./intents');
const { winKeep, mintRate } = require('./economics');

const rawMargin = (margin) => BigInt(Math.round(margin * 100)) * 10n ** 16n;

function live(config, key, mkts) {
  return {
    name: 'RÉEL',
    async state() {
      const w = await api.walletSnapshot(config.wallet);
      return {
        available: api.num(w.funds.availableBalance),
        locked: api.num(w.locked),
        // Seconds the indexed account state is behind the clock: a live sign of congestion.
        lag: Date.now() / 1000 - w.indexedThroughTimestamp,
        queued: api.num(w.queued),
        paperWallet: api.num(w.paper.balance),
        paperStaked: api.num(w.paper.staked),
        positions: w.openPositions.map((p) => api.parsePosition(p, mkts)),
        pending: w.operations.length,
        // Positions with a close already queued at the relayer (operation row: [..., positionIds] at index 9).
        closing: w.operations.filter((o) => o[1] === 'closePositions').flatMap((o) => (Array.isArray(o[9]) ? o[9] : []).map(String)),
        paper: api.num(w.paper.balance) + api.num(w.paper.staked),
        realized: api.num(BigInt(w.lifetime.realizedPnlRaw)),
        keyExpiry: Number((w.sessionKeys.find(([k]) => k === key.address) || [])[1] || 0),
      };
    },
    open: (market, isLong, margin, leverage, deadlineSeconds) =>
      intents.openPosition(key, config.build, { instrumentId: market.id, isLong, marginRaw: rawMargin(margin), leverage, deadlineSeconds }),
    close: (ids) => intents.closePositions(key, config.build, ids),
    onPrice() {},
  };
}

function simulated(config, mkts, startCapital, getProto) {
  const s = { available: startCapital, positions: [], paper: 0, realized: 0, nextId: 1, price: null };
  const settle = (p, price, liquidated) => {
    const proto = getProto();
    const move = Math.abs(price - p.entry) / p.entry;
    const winning = p.isLong ? price > p.entry : price < p.entry;
    let pnl;
    if (liquidated) pnl = -p.margin;
    else if (winning) pnl = p.notional * move * winKeep(move, p.market);
    else pnl = -Math.min(p.margin, p.notional * move);
    if (pnl < 0) s.paper += -pnl * (liquidated || !proto.queueEmpty ? 1 : 0.98) * mintRate(proto.paper);
    s.realized += pnl;
    s.available += p.margin + pnl;
  };
  return {
    name: 'SIMULATION',
    async state() {
      const locked = s.positions.reduce((sum, p) => sum + p.margin, 0);
      return { available: s.available, locked, lag: 0, queued: 0, paperWallet: s.paper, paperStaked: 0, positions: s.positions.slice(), pending: 0, closing: [], paper: s.paper, realized: s.realized, keyExpiry: Infinity };
    },
    async open(market, isLong, margin, leverage) {
      const dist = 1 / leverage - market.liquidationBuffer;
      s.available -= margin;
      s.positions.push({
        id: String(s.nextId++),
        market,
        isLong,
        entry: s.price,
        margin,
        leverage,
        notional: margin * leverage,
        bust: s.price * (isLong ? 1 - dist : 1 + dist),
        openedAt: Date.now(),
      });
    },
    async close(ids) {
      for (const p of s.positions.filter((p) => ids.includes(p.id))) settle(p, s.price, false);
      s.positions = s.positions.filter((p) => !ids.includes(p.id));
    },
    // Liquidates simulated positions whose bust price was crossed.
    onPrice(price) {
      s.price = price;
      for (const p of s.positions.filter((p) => (p.isLong ? price <= p.bust : price >= p.bust))) {
        settle(p, price, true);
        s.positions = s.positions.filter((q) => q !== p);
      }
    },
  };
}

module.exports = { live, simulated };
