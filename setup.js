'use strict';

// One-time setup: creates the bot's own session key and has the wallet authorise it.
// The key can only open and close positions; it cannot withdraw, stake or claim.
// If config.json has no wallet yet, the account connected on the page is saved there.

const http = require('http');
const { exec } = require('child_process');
const api = require('./lib/api');
const intents = require('./lib/intents');
const site = require('./lib/site');
const configFile = require('./lib/config');
const config = configFile.load();
const PORT = 8765;
const expected = (config.wallet || '').toLowerCase();

const page = `<!doctype html><meta charset="utf-8"><title>PaperTradeBot - autorisation</title>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto">
<h2>Autoriser la clé de session du bot</h2>
<p>${expected ? `Compte attendu : <code>${expected}</code>` : 'Le compte connecté dans ton wallet sera celui du bot.'}</p>
<p>Cette signature autorise le bot à ouvrir et fermer des positions pendant 30 jours. Elle ne permet ni retrait, ni staking, ni claim. Ce n'est pas une transaction.</p>
<div id="wallets"></div><pre id="out" style="white-space:pre-wrap"></pre>
<script>
const out = (t) => (document.getElementById('out').textContent = t);
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(t); return t; };
const seen = new Set();
function add(name, provider) {
  if (seen.has(provider)) return;
  seen.add(provider);
  const b = document.createElement('button');
  b.textContent = 'Signer avec ' + name;
  b.style.cssText = 'display:block;margin:8px 0;padding:10px 16px;font-size:16px';
  b.onclick = () => sign(provider).catch((e) => out('Erreur : ' + (e.message || e)));
  document.getElementById('wallets').appendChild(b);
}
async function sign(provider) {
  const [account] = await provider.request({ method: 'eth_requestAccounts' });
  const typed = JSON.parse(await post('/prepare', { account }));
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x3e7' }] }); } catch (e) {}
  out('Vérifie sur ton wallet avant de valider :\\n  key = ' + typed.message.key + '\\n  contrat = ' + typed.domain.verifyingContract + '\\n\\nConfirme la signature...');
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] });
  out('Signature reçue, envoi à Papertrade...');
  out(await post('/signature', { signature }));
}
window.addEventListener('eip6963:announceProvider', (e) => add(e.detail.info.name, e.detail.provider));
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(() => { if (!seen.size && window.ethereum) add('le wallet du navigateur', window.ethereum); if (!seen.size) out('Aucun wallet détecté dans ce navigateur.'); }, 500);
</script>`;

const body = (req) =>
  new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch (e) {
        reject(new Error('requête illisible'));
      }
    });
    req.on('error', reject);
  });

// Only the signing page itself may post: other sites open in the browser are refused.
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sameOrigin = (req) => req.headers.host === `127.0.0.1:${PORT}` && req.headers.origin === ORIGIN;

async function registered(wallet, key) {
  const w = await api.walletSnapshot(wallet);
  const entry = w.sessionKeys.find(([k]) => k === key.address);
  return !!entry && Number(entry[1]) > Date.now() / 1000 + 24 * 3600;
}

async function main() {
  config.build = (await site.check()).build || config.build;
  const existing = intents.loadKey();
  if (expected && existing && existing.user === expected && (await registered(expected, existing)))
    return console.log('La clé de session du bot est déjà autorisée. Rien à faire.');

  let pending = null; // { key, message }
  const server = http.createServer(async (req, res) => {
    const reply = (code, text) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(page);
      }
      if (req.method === 'POST' && !sameOrigin(req)) return reply(403, 'Origine refusée.');
      if (req.method === 'POST' && req.url === '/prepare') {
        const account = String((await body(req)).account || '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(account)) return reply(400, 'Compte invalide.');
        if (expected && account !== expected) return reply(400, `Mauvais compte sélectionné dans le wallet : ${account}`);
        // The new key stays in memory until the relayer accepts it, so a failed or abandoned
        // attempt never replaces a key file that still works.
        const key = intents.newKey(account);
        pending = { key, message: intents.registerMessage(key) };
        console.log(`Clé de session du bot : ${key.address}`);
        return reply(200, JSON.stringify(intents.typedData('RegisterSessionKey', pending.message)));
      }
      if (req.method === 'POST' && req.url === '/signature') {
        if (!pending) return reply(400, 'Recharge la page et recommence.');
        const { key, message } = pending;
        const packed = intents.pack('RegisterSessionKey', message, String((await body(req)).signature || ''));
        if (packed.signer !== key.user) return reply(400, `Signature faite par ${packed.signer}, pas par le compte attendu.`);
        await intents.submit('registerSessionKey', packed, config.build);
        intents.saveKey(key);
        pending = null;
        if (!expected) {
          config.wallet = key.user;
          configFile.save(config);
        }
        console.log('Enregistrement accepté par le relayer, clé enregistrée dans .session-key.json (ne partage jamais ce fichier). Attente de la confirmation...');
        let ok = false;
        for (let i = 0; i < 40 && !ok; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          ok = await registered(key.user, key).catch(() => false);
        }
        const text = ok ? 'Clé autorisée. Tu peux fermer cette page. Prochaine étape : reglages.bat, puis bot-live.bat.' : 'Envoyé, mais pas encore confirmé après 2 minutes. Relance setup.bat pour vérifier.';
        console.log(text);
        reply(200, text);
        if (ok) server.close();
        return;
      }
      reply(404, '');
    } catch (e) {
      console.log('Échec : ' + e.message);
      reply(500, 'Échec : ' + e.message);
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`Ouvre ${url} dans le navigateur où se trouve ton wallet, puis signe.`);
    if (process.platform === 'win32') exec(`start "" "${url}"`);
  });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
