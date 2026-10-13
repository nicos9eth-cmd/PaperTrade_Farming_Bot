'use strict';

const DEADBAND = 1 / 50000; // 0.2 bps of entry price
const FEE = 0.02;

// Share of a winning leg's raw gain that reaches the trader (deadband, impact, win fee).
function winKeep(move, m) {
  const eff = move - DEADBAND;
  if (eff <= 0) return 0;
  const term1 = 1 / (eff * m.rateMultiplier);
  const term2 = m.referenceNotional / (1e6 * eff * m.positionMultiplier);
  const scale = (1 - m.baseRate) / (1 + term1 + term2);
  return (eff / move) * scale * (1 - FEE);
}

// PAPER minted per $1 of mint basis.
function mintRate(p) {
  if (p.tailProgress <= 0) return p.flatRate;
  const r = p.decayScale / (p.decayScale + p.tailProgress);
  return p.flatRate * r * r;
}

// Outcome of closing a hedged pair (same notional on both legs) after a price move.
function pairOutcome({ notional, move, market, paper, queueEmpty }) {
  const loss = notional * move;
  const gain = loss * winKeep(move, market);
  const basis = queueEmpty ? loss * (1 - FEE) : loss;
  const minted = basis * mintRate(paper);
  const cost = loss - gain;
  return { loss, gain, cost, minted, costPerPaper: minted > 0 ? cost / minted : Infinity };
}

module.exports = { winKeep, mintRate, pairOutcome };
