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

// PAPER minted per $1 of mint basis, at the pool size `p.lp` (the site's reward curve): the flat
// rate under the cliff (`p.threshold`), else the tail rate, which decays further only past the
// pool's tracked high-water mark. Without pool figures, the tail rate.
function mintRate(p) {
  if (p.lp < p.threshold) return p.flatRate;
  if (p.decayScale <= 0) return 0;
  const beyond = p.lp > 0 ? Math.max(0, p.lp - Math.max(p.trackedLp || 0, p.threshold || 0)) : 0;
  const r = p.decayScale / (p.decayScale + p.tailProgress + beyond);
  return p.flatRate * r * r;
}

// PAPER minted for `basis` dollars of loss. The loss is paid into the pool: only the part that
// keeps it under the cliff earns the flat rate, the rest the tail rate.
function minted(basis, p) {
  const under = p.lp < p.threshold ? Math.min(basis, p.threshold - p.lp) : 0;
  return under * p.flatRate + (basis - under) * mintRate({ ...p, lp: Math.max(p.lp, p.threshold) });
}

// Outcome of closing a hedged pair (same notional on both legs) after a price move.
function pairOutcome({ notional, move, market, paper, queueEmpty }) {
  const loss = notional * move;
  const gain = loss * winKeep(move, market);
  const basis = queueEmpty ? loss * (1 - FEE) : loss;
  const paperOut = minted(basis, paper);
  const cost = loss - gain;
  return { loss, gain, cost, minted: paperOut, costPerPaper: paperOut > 0 ? cost / paperOut : Infinity };
}

module.exports = { winKeep, mintRate, minted, pairOutcome };
