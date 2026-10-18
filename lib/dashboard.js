'use strict';

// Full-screen console dashboard (plain ANSI, works in the Windows cmd window).

const { mintRate } = require('./economics');
const { pairStatus } = require('./pairs');

const WIDTH = 92;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const paint = (color, text) => C[color] + text + C.reset;
const usd = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const big = (n) => '$' + (n / 1e6).toFixed(1) + 'M';
const int = (n) => Math.round(n).toLocaleString('fr-FR');
const px = (n) => n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (n) => (n * 100).toFixed(2) + '%';
const paperUsd = (n) => '$' + n.toLocaleString('fr-FR', { minimumSignificantDigits: 3, maximumSignificantDigits: 3 });

function duration(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

function bar(progress, closeAt) {
  const size = 30;
  const filled = Math.max(0, Math.min(size, Math.round(progress * size)));
  const mark = Math.round(closeAt * size);
  let out = '';
  for (let i = 0; i < size; i++) out += i === mark ? '|' : i < filled ? '#' : '.';
  return paint(progress >= closeAt ? 'red' : progress >= closeAt * 0.7 ? 'yellow' : 'green', `[${out}]`);
}

// Open-interest room on each side of a market, in USD.
function oiRoom(market, price, maxNetOi) {
  const long = (market.capLong - market.oiLong) * price;
  const short = (market.capShort - market.oiShort) * price;
  const net = (market.oiLong - market.oiShort) * price;
  return { long, short, net, maxNetOi };
}

// The pool against the cliff under which every dollar lost mints the flat rate.
function poolText(proto) {
  const p = proto.paper;
  if (!(p.lp >= 0) || !p.threshold) return '';
  const m = (x) => (x / 1e6).toFixed(2) + ' M';
  if (proto.window) return `FENÊTRE OUVERTE : LP ${m(p.lp)} sous ${m(p.threshold)}, ${p.flatRate} PAPER/$ par dollar perdu`;
  return `LP ${m(p.lp)} (fenêtre ${p.flatRate} PAPER/$ sous ${m(p.threshold)}, encore ${m(p.lp - p.threshold)})`;
}

function render(v) {
  const L = [];
  const row = (label, text) => L.push(` ${paint('cyan', label.padEnd(9))}${text}`);
  const rule = () => L.push(paint('dim', ' ' + '-'.repeat(WIDTH - 2)));
  const mode = v.live ? paint('green', 'RÉEL') : paint('yellow', 'SIMULATION (aucun ordre réel)');

  L.push(` ${paint('bold', 'PAPERTRADE BOT')}  ${mode}  ${paint('dim', `en marche depuis ${duration(Date.now() - v.startedAt)}  |  ${new Date().toLocaleTimeString('fr-FR')}`)}`);
  rule();

  if (!v.market) return '[H Marché BTC introuvable dans les données Papertrade.[J';
  const room = oiRoom(v.market, v.price, v.mkts.maxNetOi);
  const side = (label, value) => `${label} ${value > 0 ? paint('green', big(value) + ' libre') : paint('red', 'PLEIN')}`;
  row('MARCHÉ', `BTC ${paint('bold', px(v.price))}   mint ${mintRate(v.proto.paper).toFixed(2)} PAPER/$   queue de paiement ${v.proto.queueEmpty ? 'vide' : paint('red', 'ACTIVE')}`);
  const pool = poolText(v.proto);
  if (pool) row('', v.proto.window ? paint('green', paint('bold', pool)) : paint('dim', pool));
  row('', `open interest : ${side('long', room.long)}   ${side('short', room.short)}   net ${big(room.net)}${room.maxNetOi ? ' / ' + big(room.maxNetOi) : ''}`);

  const p = v.pressure;
  row('RELAYER', p ? `congestion ${paint(p.level === 'LOW' ? 'green' : p.level === 'MEDIUM' ? 'yellow' : 'red', p.level)}   ${p.pending} ordre(s) en attente   temps pour vider ~${p.clearSeconds} s` : paint('dim', 'congestion inconnue (flux indisponible)'));

  const s = v.state;
  row('COMPTE', `disponible ${paint('bold', usd(s.available))}   en marge ${usd(s.locked)}${s.queued ? `   en queue ${usd(s.queued)}` : ''}   total ${usd(s.available + s.locked + s.queued)}`);
  row('', `PAPER ${paint('bold', int(s.paper))}  (staké ${int(s.paperStaked)}, à staker ${int(s.paperWallet)})   PnL réalisé depuis toujours ${usd(s.realized)}`);

  const t = v.totals;
  const pp = v.paperPrice;
  if (pp) {
    const gain = t.paper * pp - t.spent;
    row('PAPER', `prix ${paint('bold', paperUsd(pp))} (pré-marché para:PAPER sur Hyperliquid)   ton sac ${int(s.paper)} PAPER ≈ ${paint('bold', usd(s.paper * pp))}`);
    row('', `farmé depuis le lancement : ${int(t.paper)} PAPER ≈ ${usd(t.paper * pp)} pour ${usd(t.spent)} de coût (gain estimé ${paint(gain >= 0 ? 'green' : 'red', usd(gain))})`);
  } else row('PAPER', paint('dim', 'prix du PAPER indisponible (pré-marché para:PAPER sur Hyperliquid)'));

  if (!v.pairs.length && !v.single.length) row('POSITION', paint('dim', 'aucune position BTC ouverte'));
  for (const pair of v.pairs) {
    const st = pairStatus(pair, v.price, v.proto);
    const target = st.at(v.closeAt);
    row('PAIRE', `${usd(st.loser.margin)} x${st.loser.leverage} par jambe   entrée ${px(st.entry)}   liquidation ${px(pair.long.bust)} / ${px(pair.short.bust)}`);
    row('', `${bar(st.progress, v.closeAt)} ${Math.round(st.progress * 100)}%   mouvement ${pct(st.move)} sur ${pct(st.bustMove)}   clôture à ${pct(st.bustMove * v.closeAt)}`);
    if (v.risk) {
      const adapted = v.closeAt < v.config.closeAt - 0.005;
      const text = `seuil de clôture ${Math.round(v.closeAt * 100)}%${adapted ? ' (avancé)' : ''}   volatilité ${(v.risk.vol * Math.sqrt(60) * 100).toFixed(3)}%/min   délai estimé ${v.risk.delay.toFixed(0)} s`;
      row('', adapted ? paint('yellow', text) : paint('dim', text));
    }
    row('', paint('dim', `si clôture maintenant : coût ${usd(st.now.cost)}, ~${int(st.now.minted)} PAPER   |   au seuil : coût ${usd(target.cost)}, ~${int(target.minted)} PAPER`));
  }
  for (const p of v.single) row('JAMBE', paint('red', `${p.isLong ? 'long' : 'short'} ${usd(p.margin)} x${p.leverage} SANS couverture, entrée ${px(p.entry)}, liquidation ${px(p.bust)}`));
  if (v.lighter) {
    const l = v.lighter;
    const btc = (x) => `${x > 0 ? 'long' : 'short'} ${Math.abs(x).toFixed(5)} BTC (${usd(Math.abs(x) * v.price)})`;
    const mine = l.base - l.own;
    const hedge = Math.abs(l.own) >= 1e-5 ? paint('yellow', 'couverture du bot ' + btc(l.own)) : paint('dim', 'pas de couverture en cours');
    const manual = Math.abs(mine) >= 1e-5 ? `   ta position ${btc(mine)}` : '';
    row('LIGHTER', `${hedge}${manual}   collatéral ${usd(l.equity)}   peut couvrir ${usd(l.capacityUsd)}${l.liquidation ? `   liquidation ${px(l.liquidation)}` : ''}`);
    if (l.scalp) {
      const sc = l.scalp;
      const text = sc.on ? `couverture réactive : ${Math.abs(sc.held) >= 1e-5 ? btc(sc.held) : 'rien de tenu (pas de paire complète)'}` : 'couverture réactive arrêtée (limite de perte atteinte)';
      row('', `${paint(sc.on ? 'dim' : 'red', text)}   résultat de la couverture réactive ${paint(sc.pnl >= 0 ? 'green' : 'red', usd(sc.pnl))}`);
    }
  }

  const budget = v.config.maxNetLossUsd ? `   budget ${usd(t.budgetSpent)} / ${usd(v.config.maxNetLossUsd)}` : '';
  row('SESSION', `${t.cycles} cycle(s)   coût ${usd(t.spent)}   +${int(t.paper)} PAPER${t.paper > 0 ? `   $${(t.spent / t.paper).toFixed(4)} par PAPER` : ''}${budget}`);
  row('ÉTAT', v.stopReason ? paint('red', `arrêt des ouvertures : ${v.stopReason}`) : paint('bold', v.status));
  rule();
  for (const e of v.events.slice(-8)) L.push(paint('dim', ' ' + e).slice(0, WIDTH + 12));
  rule();
  L.push(paint('dim', ' Ctrl+C pour arrêter. Les positions ouvertes restent alors ouvertes sans surveillance.'));

  return '\x1b[H' + L.map((l) => l + '\x1b[K').join('\n') + '\n\x1b[J';
}

module.exports = { render, oiRoom, poolText, paperUsd };
