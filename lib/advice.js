'use strict';

// What the settings assistant (reglages.bat) recommends for given balances, so that each user
// gets settings matched to their own Papertrade and Lighter accounts.

const { cycleRange, lowestLeverage } = require('./sizing');
const { tolerableDelay } = require('./risk');
const { MAX_LEVERAGE } = require('./lighter');

const LIGHTER_USE = 0.9; // share of Lighter's maximum the hedge plans on (see bot.js hedgeTick)

// Share of a leg of `notional` the Lighter hedge can hold, and the missing amount; null without Lighter.
function coverage(lighterEquity, notional) {
  if (lighterEquity === null || lighterEquity === undefined) return null;
  const capacityUsd = Math.max(0, lighterEquity) * MAX_LEVERAGE * LIGHTER_USE;
  const share = Math.min(1, capacityUsd / notional);
  return { capacityUsd, share, missingUsd: share < 1 ? Math.ceil(notional / (MAX_LEVERAGE * LIGHTER_USE) - lighterEquity) : 0 };
}

// `lighterEquity`: value of the Lighter account the hedge uses, or null when there is none.
function advise({ balance, mkts, market, proto, config, defaults, lighterEquity }) {
  const normal = cycleRange(balance, mkts, market, proto, { ...config, maxMarginPerLeg: null, targetMove: defaults.targetMove });
  if (normal.reason) return { reason: normal.reason };
  const low = lowestLeverage(balance, mkts, market, { ...config, maxMarginPerLeg: null });
  const prudent = !low.reason && low.leverage < normal.leverage ? { ...cycleRange(balance, mkts, market, proto, { ...config, maxMarginPerLeg: null, targetMove: low.targetMove }), targetMove: low.targetMove } : null;

  // Fully covered on Lighter: a liquidated leg is hedged and the bot need not wait out slow
  // closes, so the more frequent cycles of the normal leverage are worth it. Otherwise the
  // prudent leverage puts liquidation further away and the bot has to wait less often.
  let pick = 'normal';
  let why;
  const normalCover = coverage(lighterEquity, normal.notional);
  if (normalCover && normalCover.share >= 1) why = 'ta couverture Lighter couvre une jambe entière : le bot peut garder le levier normal et ne pas attendre pendant les congestions';
  else if (prudent) {
    pick = 'prudent';
    why = 'sans couverture Lighter complète, un levier plus bas éloigne la liquidation et le bot attend moins souvent pendant les congestions (cycles plus rares, prix du PAPER un peu meilleur)';
  } else why = `ton solde impose déjà le levier le plus bas possible (Papertrade exige ${mkts.minNotional} $ par position)`;

  const chosen = pick === 'prudent' ? prudent : normal;
  const targetMove = pick === 'prudent' ? prudent.targetMove : defaults.targetMove;
  const cover = coverage(lighterEquity, chosen.notional);
  // The bot stops opening when the expected price of a PAPER exceeds maxCostPerPaper: leave room
  // for the mint rate, which keeps falling, before that happens.
  const maxCostPerPaper = Math.ceil(chosen.late.costPerPaper * 1.5 * 1000) / 1000;
  return {
    normal,
    prudent,
    pick,
    why,
    chosen,
    targetMove,
    cover,
    waitAfter: cover && cover.share >= 1 ? Infinity : tolerableDelay(chosen.bustMove, config),
    budget: Math.max(1, Math.ceil(chosen.late.cost * 10)),
    maxCostPerPaper,
  };
}

module.exports = { advise, coverage };
