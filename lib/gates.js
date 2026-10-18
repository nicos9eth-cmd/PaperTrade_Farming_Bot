'use strict';

// What the bot does when it holds nothing: `{ stop }` (only the owner can lift it: budget, session
// key), `{ wait }` (clears by itself), or `{ open: 'normal' | 'burst' }`. A mint rate or a cost per
// PAPER out of bounds is a wait, not a stop: under the cliff the rate jumps back to the flat 100.

const { mintRate } = require('./economics');

const usd = (n) => '$' + n.toFixed(2);
const millions = (x) => (x / 1e6).toFixed(2) + ' M';

const wakeUp = (paper) => `réveil automatique si le LP passe sous ${millions(paper.threshold)} (actuellement ${millions(paper.lp)})`;

function whenFlat({ live, spent, config, proto, keyExpiry, now = Date.now(), formatOk, stale, load }) {
  if (config.maxNetLossUsd && spent >= config.maxNetLossUsd)
    return { stop: `budget atteint (${usd(spent)} dépensés sur ${usd(config.maxNetLossUsd)}) ; pour repartir, change maxNetLossUsd dans config.json` };
  if (live && keyExpiry * 1000 < now + 2 * 3600e3) return { stop: 'clé de session bientôt expirée, relance setup.bat' };
  if (formatOk === false) return { wait: 'le format des ordres a changé sur le site Papertrade, le bot doit être mis à jour' };
  if (stale) return { wait: 'état du compte en retard côté Papertrade' };
  if (!proto.queueEmpty && config.pauseWhenQueueActive) return { wait: 'queue de paiement active' };
  if (load && load.level === 'HIGH') return { wait: `relayer congestionné (${load.pending} ordres en attente)` };
  if (proto.window) return { open: 'burst' };
  const rate = mintRate(proto.paper);
  if (rate < config.minMintRate) return { wait: `veille, taux de mint ${rate.toFixed(2)} sous le plancher ${config.minMintRate} ; ${wakeUp(proto.paper)}` };
  return { open: 'normal' };
}

// A normal pair whose expected cost per PAPER is over the ceiling is not opened.
function costGate(expected, config, proto) {
  if (!config.maxCostPerPaper || expected.costPerPaper <= config.maxCostPerPaper) return null;
  return { wait: `veille, coût attendu $${expected.costPerPaper.toFixed(4)} par PAPER au-dessus du plafond $${config.maxCostPerPaper} ; ${wakeUp(proto.paper)}` };
}

module.exports = { whenFlat, costGate };
