'use strict';

// Read-only closing assistant: watches the open hedged pairs and says when to close both legs.
// It never signs or sends an order.

const { execFile } = require('child_process');
const api = require('./lib/api');
const { buildPairs, pairStatus } = require('./lib/pairs');
const { mintRate } = require('./lib/economics');
const config = require('./config.json');

const usd = (n) => '$' + n.toFixed(2);
const pct = (n) => (n * 100).toFixed(2) + '%';
const clock = () => new Date().toLocaleTimeString('fr-FR');

let lastBeep = 0;
function beep(urgent) {
  const gap = urgent ? 3000 : 15000;
  if (!config.sound || Date.now() - lastBeep < gap) return;
  lastBeep = Date.now();
  const cmd = urgent ? '1..3 | % { [console]::beep(1600,250) }' : '[console]::beep(1000,400)';
  execFile('powershell', ['-NoProfile', '-Command', cmd], () => {});
}

function render(price, proto, positions) {
  const lines = [];
  lines.push(`[${clock()}] BTC ${price.toFixed(1)} | mint ${mintRate(proto.paper).toFixed(2)} PAPER/$ | queue ${proto.queueEmpty ? 'vide' : 'ACTIVE'}`);
  const { pairs, single } = buildPairs(positions.filter((p) => p.market && p.market.coin === 'BTC'));
  if (!pairs.length && !single.length) lines.push('  Aucune position BTC ouverte.');
  let level = 0;
  for (const pair of pairs) {
    const s = pairStatus(pair, price, proto);
    const side = s.loser.isLong ? 'long' : 'short';
    const target = s.at(config.alertAt);
    lines.push(
      `  Paire ${usd(s.loser.margin)} x${s.loser.leverage} | entrée ${s.entry.toFixed(1)} | mouvement ${pct(s.move)} sur ${pct(s.bustMove)} avant liquidation du ${side} (${Math.round(s.progress * 100)}%)`
    );
    lines.push(
      `    Si tu fermes maintenant : coût ${usd(s.now.cost)}, ~${Math.round(s.now.minted)} PAPER, ${isFinite(s.now.costPerPaper) ? '$' + s.now.costPerPaper.toFixed(4) : '-'} par PAPER`
    );
    lines.push(
      `    Au seuil d'alerte (${pct(s.bustMove * config.alertAt)}) : coût ${usd(target.cost)}, ~${Math.round(target.minted)} PAPER, $${target.costPerPaper.toFixed(4)} par PAPER`
    );
    if (s.progress >= config.urgentAt) {
      level = Math.max(level, 2);
      lines.push('    >>> URGENT : FERME LES DEUX JAMBES MAINTENANT (Close All), liquidation imminente <<<');
    } else if (s.progress >= config.alertAt) {
      level = Math.max(level, 1);
      lines.push('    >>> Seuil atteint : ferme les deux jambes (Close All) <<<');
    }
  }
  for (const p of single) {
    level = Math.max(level, 2);
    lines.push(
      `  >>> Position ${p.isLong ? 'long' : 'short'} ${usd(p.margin)} x${p.leverage} SANS couverture (entrée ${p.entry.toFixed(1)}, liquidation ${p.bust.toFixed(1)}) : ferme-la ou rouvre l'autre jambe <<<`
    );
  }
  console.log(lines.join('\n'));
  if (level) beep(level === 2);
}

async function main() {
  const once = process.argv.includes('--once');
  const mkts = await api.markets();
  let proto = await api.protocol();
  for (let tick = 0; ; tick++) {
    try {
      if (tick && tick % 30 === 0) {
        proto = await api.protocol();
        Object.assign(mkts, await api.markets());
      }
      const [price, w] = await Promise.all([api.hlMid('BTC'), api.walletSnapshot(config.wallet)]);
      render(price, proto, w.openPositions.map((p) => api.parsePosition(p, mkts)));
    } catch (e) {
      console.error(`[${clock()}] ${e.message}`);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, Math.max(2, config.pollSeconds) * 1000));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
