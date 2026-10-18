'use strict';

// Adaptive close threshold: close earlier when the price is moving fast or orders are slow to land.

const LONG_WINDOW_MS = 300000;
const SHORT_WINDOW_MS = 60000;
const MAX_LAG_SECONDS = 60;
const MAX_STEP = 0.0025; // largest relative move counted between two samples
const FLOOR_SIGMA = 0.02 / Math.sqrt(86400); // 2% per day, per square-root second

function tracker() {
  const samples = []; // { t, p }
  const latencies = []; // seconds, most recent last
  let queueDelay = 0; // extra seconds the relayer's backlog needs to clear
  const lags = []; // seconds the account state was behind, most recent last

  // Median of the recent readings, so a single stale snapshot does not move the threshold.
  const typicalLag = () => {
    if (!lags.length) return 0;
    const sorted = lags.slice().sort((a, b) => a - b);
    return Math.min(MAX_LAG_SECONDS, Math.max(0, sorted[Math.floor(sorted.length / 2)]));
  };

  // Volatility as relative move per square-root second over a window.
  const sigma = (windowMs, now) => {
    let sumSq = 0;
    let seconds = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i - 1].t < now - windowMs) continue;
      // Cap each step so one freak quote cannot drag the threshold to its floor for minutes.
      const r = Math.max(-MAX_STEP, Math.min(MAX_STEP, samples[i].p / samples[i - 1].p - 1));
      sumSq += r * r;
      seconds += (samples[i].t - samples[i - 1].t) / 1000;
    }
    // Never assume less than an ordinary day's volatility, including before enough samples exist.
    return Math.max(FLOOR_SIGMA, seconds > 10 ? Math.sqrt(sumSq / seconds) : 0);
  };

  return {
    addPrice(p, t = Date.now()) {
      samples.push({ t, p });
      while (samples.length && samples[0].t < t - LONG_WINDOW_MS) samples.shift();
    },
    // Time one of our own orders took to show up on the account.
    addLatency(ms) {
      latencies.push(ms / 1000);
      if (latencies.length > 5) latencies.shift();
    },
    setQueueDelay(seconds) {
      queueDelay = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    },
    addLag(seconds) {
      lags.push(seconds);
      if (lags.length > 5) lags.shift();
    },
    // Fraction of the way to liquidation at which to close, and the inputs behind it.
    assess(bustMove, config, now = Date.now()) {
      const { vol, delay, buffer } = estimate(config, now);
      const raw = Math.max(config.minCloseAt, Math.min(config.closeAt, 1 - buffer / bustMove));
      // If anything in the estimate is unusable, fall back to the most cautious threshold.
      const closeAt = Number.isFinite(raw) ? raw : config.minCloseAt;
      return { closeAt, vol, delay, buffer };
    },
    // Smallest distance to liquidation a new pair needs so that, with the current delay estimate,
    // the room left after the lowest threshold (minCloseAt) still covers riskSigmas of price
    // moves during the delay. Below it the adaptive threshold is already clamped at its floor.
    // On 2026-10-15 a close sat 28 min in the relayer queue at x61 and a leg was liquidated.
    minBustMove(config, now = Date.now()) {
      const { buffer } = estimate(config, now);
      const share = 1 - config.minCloseAt;
      return Number.isFinite(buffer) && share > 0 ? buffer / share : Infinity;
    },
  };

  function estimate(config, now) {
    const vol = Math.max(sigma(LONG_WINDOW_MS, now), sigma(SHORT_WINDOW_MS, now));
    const delay = Math.max(config.baseDelaySeconds, ...latencies) + typicalLag() + queueDelay;
    return { vol, delay, buffer: config.riskSigmas * vol * Math.sqrt(delay) };
  }
}

// Longest close delay (seconds) a pair whose liquidation is `bustMove` away can absorb in a calm
// market before minBustMove refuses to open it: the inverse of minBustMove at FLOOR_SIGMA.
function tolerableDelay(bustMove, config) {
  const room = (1 - config.minCloseAt) * bustMove;
  return (room / (config.riskSigmas * FLOOR_SIGMA)) ** 2;
}

module.exports = { tracker, tolerableDelay };
